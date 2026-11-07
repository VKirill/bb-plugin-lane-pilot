import type Database from "better-sqlite3";
import { recordOutcome } from "./receipts";

/**
 * Outcome labels (H1): for each judgment the pipeline's own later truth, written onto its unlabeled receipts once the
 * truth had time to land. Each rule is a pure read over the DB returning `{receiptId, outcome}` rows; `applyOutcomeLabels`
 * writes them (`agree:outcome` / `disagree:outcome`, plus a short `:<detail>` suffix). A labeled receipt is never touched
 * again (`outcome IS NULL` in every query), so a second run labels nothing new.
 *
 * `failure.class`, `route.workflow`, `plan.fact`, `writer.model` and `invoice.check` already have their sweeps in
 * src/rooms/runs/failure-class-model.ts — they are called by the same nightly step and are not duplicated here.
 * Judgments with no later truth (errand.kind, intake.weight, learning.*, graph.step_trivial, guard.host_command until
 * permits reach a decision surface, …) are labeled by the model relabeler instead (labels-model.ts, `agree:model`).
 */

export type OutcomeLabel = { receiptId: number; outcome: string };

type Db = Pick<Database.Database, "prepare">;

const TASK_TRUTH_AGE_MS = 24 * 3_600_000;

/** Open attempt states mirror failure-class-model.ts: anything else terminal that is not `accepted` counts as failure. */
const OPEN_ATTEMPT_STATES = "'queued','spawn_requested','spawn_unknown','running','cancel_requested'";

type ReceiptRow = { id: number; run_id: string | null; subject: string | null; decision: string | null; at: number };

function unlabeled(db: Db, judgment: string, olderThan: number): ReceiptRow[] {
  return db.prepare(`SELECT id, run_id, subject, decision, at FROM lane_pilot_jev_receipt
    WHERE judgment = ? AND outcome IS NULL AND status = 'ok' AND decision IS NOT NULL AND at < ?`).all(judgment, olderThan) as ReceiptRow[];
}

/**
 * How the task of a receipt ended: `accepted` (an accepted attempt, no regression naming it, no `<id>-mainfix` follow-up),
 * `failed` (a terminal non-accepted attempt, a blocked/closed run without acceptance, a regression or a mainfix),
 * or `pending` (attempts still going, no truth yet).
 */
export function taskOutcome(db: Db, runId: string | null, taskId: string | null): "accepted" | "failed" | "pending" {
  if (!runId || !taskId) return "pending";
  if (db.prepare("SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND state='accepted' LIMIT 1").get(runId, taskId)) {
    const named = db.prepare("SELECT 1 FROM lane_pilot_regression WHERE (task_id=? OR culprit_task=?) AND kind='regression' LIMIT 1").get(taskId, taskId);
    const mainfix = db.prepare("SELECT 1 FROM lane_pilot_task WHERE id=? LIMIT 1").get(`${taskId}-mainfix`);
    return named || mainfix ? "failed" : "accepted";
  }
  const open = db.prepare(`SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND state IN (${OPEN_ATTEMPT_STATES}) LIMIT 1`).get(runId, taskId);
  if (open) return "pending";
  const had = db.prepare("SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND task_id=? LIMIT 1").get(runId, taskId);
  if (had) return "failed";
  const run = db.prepare("SELECT state, closed_at FROM lane_pilot_run WHERE id=?").get(runId) as { state: string; closed_at: number | null } | undefined;
  if (!run) return "pending";
  return run.closed_at !== null || run.state !== "running" ? "failed" : "pending";
}

/** The verdict of the task's plan critique stage, when one ran: `pass` (found nothing) or `changes` (it earned its cost). */
function planCriticVerdict(db: Db, runId: string, taskId: string): "pass" | "changes" | null {
  const row = db.prepare("SELECT state, result_json FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id='plan-critique' ORDER BY updated_at DESC LIMIT 1")
    .get(runId, taskId) as { state: string; result_json: string | null } | undefined;
  if (!row) return null;
  try {
    const result = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : {};
    const text = `${result["decision"] ?? ""} ${result["status"] ?? ""}`;
    if (/approve|pass/.test(text)) return "pass";
    if (/changes|rework|reject|block/.test(text)) return "changes";
  } catch { /* fall through to the state */ }
  if (["done", "passed", "completed"].includes(row.state)) return "pass";
  if (["failed", "blocked", "rework"].includes(row.state)) return "changes";
  return null;
}

/**
 * `critique.screen` (the cheap pass/fail before the code critic): the task's fate judges the verdict. A `pass` that was
 * accepted without a regression or a mainfix is agreed; a `pass` whose task failed or regressed is disagreed — and the
 * same for `fail` the other way. An `escalate:` receipt was never a decision: left unlabeled.
 */
export function labelCritiqueScreen(db: Db, now = Date.now()): OutcomeLabel[] {
  const out: OutcomeLabel[] = [];
  for (const row of unlabeled(db, "critique.screen", now - TASK_TRUTH_AGE_MS)) {
    if (row.decision !== "pass" && row.decision !== "fail") continue;
    const outcome = taskOutcome(db, row.run_id, row.subject);
    if (outcome === "pending") continue;
    const right = (row.decision === "pass") === (outcome === "accepted");
    out.push({ receiptId: row.id, outcome: `${right ? "agree" : "disagree"}:outcome` });
  }
  return out;
}

/**
 * `critique.worth` (which critics a task deserves): a skipped plan critique is right when the task was accepted cleanly,
 * wrong when it failed; a plan critique that ran and found nothing means skipping it would have been right (disagree on
 * the «run» side); one that found something was worth its cost (agree). Tasks with no critic stage and no fate stay
 * unlabeled — a critic that never ran shows nothing.
 */
export function labelCritiqueWorth(db: Db, now = Date.now()): OutcomeLabel[] {
  const out: OutcomeLabel[] = [];
  for (const row of unlabeled(db, "critique.worth", now - TASK_TRUTH_AGE_MS)) {
    const skippedPlan = /skip[^,]*plan_critique|skip .*plan_critique/.test(row.decision ?? "");
    const outcome = taskOutcome(db, row.run_id, row.subject);
    if (skippedPlan) {
      if (outcome === "pending") continue;
      out.push({ receiptId: row.id, outcome: `${outcome === "accepted" ? "agree" : "disagree"}:outcome` });
      continue;
    }
    if (!row.run_id || !row.subject) continue;
    const critic = planCriticVerdict(db, row.run_id, row.subject);
    if (critic === "pass") out.push({ receiptId: row.id, outcome: "disagree:outcome:critic_found_nothing" });
    else if (critic === "changes") out.push({ receiptId: row.id, outcome: "agree:outcome" });
    else if (outcome === "accepted") out.push({ receiptId: row.id, outcome: "agree:outcome" });
    else if (outcome === "failed") out.push({ receiptId: row.id, outcome: "disagree:outcome" });
  }
  return out;
}

/**
 * `lead.predict`: the decision journal already holds the owner's answer and the verdict — the receipt for a prediction
 * copies it (`exact`/`partial` → agree, `miss` → disagree, `deferred` stays unlabeled: nothing was predicted to grade).
 * The link is the run and the journal row predicted at the receipt's time (the journal writes both in one step).
 */
export function labelLeadPredict(db: Db, now = Date.now()): OutcomeLabel[] {
  const out: OutcomeLabel[] = [];
  for (const row of unlabeled(db, "lead.predict", now - TASK_TRUTH_AGE_MS)) {
    if (!row.run_id) continue;
    const decision = db.prepare(`SELECT judge_verdict, owner_label FROM lane_pilot_decision
      WHERE run_id=? AND predicted_at IS NOT NULL AND ABS(predicted_at - ?) < 120000
      ORDER BY ABS(predicted_at - ?) LIMIT 1`).get(row.run_id, row.at, row.at) as { judge_verdict: string | null; owner_label: string | null } | undefined;
    const verdict = decision?.owner_label ?? decision?.judge_verdict;
    if (verdict === "exact" || verdict === "partial") out.push({ receiptId: row.id, outcome: "agree:outcome" });
    else if (verdict === "miss") out.push({ receiptId: row.id, outcome: "disagree:outcome" });
  }
  return out;
}

/**
 * `guard.host_command`: the permit the PM (or the owner) decided. Permit answers land as journal decisions of class
 * `permit` once that surface exists; `allow` confirms a safe read (`allow`/`review`), `deny` disagrees with it — and for a
 * `stop` decision the signs flip. No permit row → no truth (the ticket files live on the host, not in this DB).
 */
export function labelGuardHostCommand(db: Db, now = Date.now()): OutcomeLabel[] {
  const out: OutcomeLabel[] = [];
  for (const row of unlabeled(db, "guard.host_command", now - TASK_TRUTH_AGE_MS)) {
    if (!row.run_id || !row.decision) continue;
    const decision = db.prepare(`SELECT answer_json FROM lane_pilot_decision
      WHERE run_id=? AND class='permit' AND answer_json IS NOT NULL
      ORDER BY answered_at DESC LIMIT 1`).get(row.run_id) as { answer_json: string | null } | undefined;
    if (!decision?.answer_json) continue;
    let option = "";
    try { option = String((JSON.parse(decision.answer_json) as { option?: unknown }).option ?? ""); } catch { continue; }
    if (option !== "allow" && option !== "deny") continue;
    const saidStop = row.decision.startsWith("stop");
    const right = (option === "allow") !== saidStop;
    out.push({ receiptId: row.id, outcome: `${right ? "agree" : "disagree"}:outcome:permit_${option}` });
  }
  return out;
}

/**
 * `errand.failure` (the episode sweep's shadow judgment, src/rooms/errands/failure-judgment.ts): the episode's own
 * `failure_class` — code-computed first, the analyst's word second — is the later truth the receipt is graded against.
 * An episode not yet enriched, or one with no class (a clean done), stays unlabeled.
 */
export function labelErrandFailure(db: Db, now = Date.now()): OutcomeLabel[] {
  const out: OutcomeLabel[] = [];
  for (const row of unlabeled(db, "errand.failure", now - TASK_TRUTH_AGE_MS)) {
    if (!row.run_id || !row.decision) continue;
    const episode = db.prepare("SELECT failure_class, enrichment_state FROM lane_pilot_errand_episode WHERE run_id=? ORDER BY extractor_version DESC LIMIT 1")
      .get(row.run_id) as { failure_class: string | null; enrichment_state: string } | undefined;
    if (!episode || episode.enrichment_state !== "enriched" || !episode.failure_class) continue;
    out.push({ receiptId: row.id, outcome: `${row.decision === episode.failure_class ? "agree" : "disagree"}:outcome` });
  }
  return out;
}

/** Every outcome rule this file covers, run over the unlabeled receipts and written. Returns per-judgment counts. */
export function applyOutcomeLabels(db: Database.Database, now = Date.now()): Record<string, number> {
  const groups: Array<[string, OutcomeLabel[]]> = [
    ["critique.screen", labelCritiqueScreen(db, now)],
    ["critique.worth", labelCritiqueWorth(db, now)],
    ["lead.predict", labelLeadPredict(db, now)],
    ["guard.host_command", labelGuardHostCommand(db, now)],
    ["errand.failure", labelErrandFailure(db, now)],
  ];
  const counts: Record<string, number> = {};
  for (const [judgment, labels] of groups) {
    for (const label of labels) recordOutcome(db, label.receiptId, label.outcome, now);
    counts[judgment] = labels.length;
  }
  return counts;
}

/**
 * What the autonomy tiers will read (H1): a judgment's labeled sample and its accuracy over ALL labeled receipts —
 * outcome, model and escalation labels alike. `null` when the judgment was never asked.
 */
export function judgeAccuracy(db: Db, judgmentId: string): { labeled: number; accuracy: number } | null {
  const rows = db.prepare(`SELECT outcome FROM lane_pilot_jev_receipt WHERE judgment=? AND status='ok' AND outcome IS NOT NULL`).all(judgmentId) as Array<{ outcome: string }>;
  const calls = (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_jev_receipt WHERE judgment=?").get(judgmentId) as { n: number }).n;
  if (calls === 0) return null;
  const agree = rows.filter((row) => row.outcome.startsWith("agree")).length;
  const disagree = rows.filter((row) => row.outcome.startsWith("disagree")).length;
  const labeled = agree + disagree;
  return { labeled, accuracy: labeled ? agree / labeled : 0 };
}

/**
 * The outcome sweeps that live with their owners: `runs` registers one per judgment it owns (the ids in
 * src/rooms/contracts/judgment-ids.ts plus failure.class and invoice.check); the nightly labels graph walks
 * `listJudgments()` and calls whatever registered — adding a sweep is one call here, not a second id list.
 */
type OutcomeSweep = (db: Database.Database) => number;
const outcomeSweeps = new Map<string, OutcomeSweep>();
export function registerOutcomeSweep(judgmentId: string, sweep: OutcomeSweep): void {
  outcomeSweeps.set(judgmentId, sweep);
}
export const outcomeSweepFor = (judgmentId: string): OutcomeSweep | undefined => outcomeSweeps.get(judgmentId);
