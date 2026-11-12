import type Database from "better-sqlite3";
import { recordOutcome } from "./receipts";

/**
 * Outcome labels (H1): for each judgment the pipeline's own later truth, written onto its unlabeled receipts once the
 * truth had time to land. Each rule is a pure read over the DB returning `{receiptId, outcome}` rows; `applyOutcomeLabels`
 * writes them (`agree:outcome` / `disagree:outcome`, plus a short `:<detail>` suffix). A labeled receipt is never touched
 * again (`outcome IS NULL` in every query), so a second run labels nothing new.
 *
 * `failure.class`, `route.workflow`, `writer.model` and `invoice.check` already have their sweeps in
 * src/rooms/runs/failure-class-model.ts — they are called by the same nightly step and are not duplicated here.
 * Judgments with no later truth (errand.kind, intake.weight, learning.*, …) are labeled by the model relabeler instead (labels-model.ts, `agree:model`).
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
  const known = db.prepare("SELECT 1 FROM lane_pilot_task WHERE id=? LIMIT 1");
  if (db.prepare("SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND state='accepted' LIMIT 1").get(runId, taskId)) {
    const named = db.prepare("SELECT 1 FROM lane_pilot_regression WHERE (task_id=? OR culprit_task=?) AND kind='regression' LIMIT 1").get(taskId, taskId);
    const mainfix = known.get(`${taskId}-mainfix`);
    return named || mainfix ? "failed" : "accepted";
  }
  const open = db.prepare(`SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND state IN (${OPEN_ATTEMPT_STATES}) LIMIT 1`).get(runId, taskId);
  if (open) return "pending";
  const had = db.prepare("SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND task_id=? LIMIT 1").get(runId, taskId);
  if (had) return "failed";
  // A subject that is no task of the run (a step name, a thread) has no fate: «failed» here labelled 887 receipts wrong.
  if (!known.get(taskId)) return "pending";
  const run = db.prepare("SELECT state, closed_at FROM lane_pilot_run WHERE id=?").get(runId) as { state: string; closed_at: number | null } | undefined;
  if (!run) return "pending";
  return run.closed_at !== null || run.state !== "running" ? "failed" : "pending";
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

/** Every outcome rule this file covers, run over the unlabeled receipts and written. Returns per-judgment counts. */
export function applyOutcomeLabels(db: Database.Database, now = Date.now()): Record<string, number> {
  const groups: Array<[string, OutcomeLabel[]]> = [
    ["critique.screen", labelCritiqueScreen(db, now)],
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
