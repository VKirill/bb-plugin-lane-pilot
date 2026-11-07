import type Database from "better-sqlite3";
import { classifyFailure, type FailureClass } from "../contracts/failure-class";
import { failureClassJudgment, FAILURE_CLASS_ID, type FailureClassDecision } from "./failure-class-judgment";
import { logFindJudgment } from "@lane-pilot/jev/judgments/log-find";
import { countJudgmentReceipts, labeledOutcomes, recordOutcome, registerOutcomeSweep, type Jev, type JevSettings, unlabeledJevReceipts, unlabeledJevSubjectReceipts, unlabeledRunReceipts, unlabeledSubjectReceipts } from "@lane-pilot/jev";
import { INVOICE_CHECK_ID } from "@lane-pilot/jev/judgments/invoice-check";
import { PLAN_FACT_JEV_ID, ROUTE_WORKFLOW_ID, WRITER_MODEL_JUDGMENT_ID, writerRouteKey } from "../contracts";

/**
 * The class of a failure with J-4 behind the rules: the rules first, and only a reason they have no confident match for goes to
 * Jev. `off` and `shadow` (the default) return the rules' class, `shadow` having recorded what Jev would have said in a receipt;
 * `active` returns Jev's class when it is clear. No Jev, no key, a failure: the rules' class.
 */
export type JudgedFailureDeps = {
  jev(): Jev | null;
  settings(): Promise<JevSettings>;
  projectId: string;
  runId: string | null;
  /** Present: the unlabeled receipts of this judgment get their outcome from the run's terminal state (see the sweep below). */
  db?: Database.Database | null;
  /** Present: a labeled `writer.model` outcome is also written into the task's `writer-route` record (W31). */
  kv?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> } | null;
};

import { getRun, hasAcceptedAttempt, hasLiveAttempt, getStageReceiptResult } from "../storage";
import { wfEarliestLinkedRun } from "@lane-pilot/workflow-engine";

/**
 * The label `calibrate` reads for `failure.class`: the run's terminal state is the stronger judge. Accepted means the class —
 * whatever it blamed — did not kill the work (agree). A dead run confirms a `task` reading and denies a `provider`/`infra`
 * parking that cost the task its attempts. Runs still going are left unlabeled. Receipts of shadow calls carry the decision
 * Jev would have made, so they are labeled the same way.
 */
export function sweepFailureClassOutcomes(db: Database.Database): number {
  const rows = unlabeledRunReceipts(db, FAILURE_CLASS_ID)
    .map((row) => ({ ...row, run_state: row.run_id ? getRun(db, row.run_id)?.state : undefined }))
    .filter((row): row is { id: number; run_id: string | null; decision: string; run_state: string } =>
      row.run_state === "accepted" || row.run_state === "blocked" || row.run_state === "closed");
  for (const row of rows) recordOutcome(db, row.id, row.run_state === "accepted" ? "agree" : row.decision === "task" ? "agree" : "disagree");
  return rows.length;
}

/**
 * The owner's decision on the invoice is the stronger judge of `invoice.check`: a sent invoice confirms a `match` and
 * denies a `mismatch`; a run that stopped before the send confirms a hold (mismatch/unsure) and denies a match the owner
 * did not let through. Runs the receipt cannot see (a workflow run outside lane_pilot_run, or one still going) stay unlabeled.
 */
export function sweepInvoiceCheckOutcomes(db: Database.Database): number {
  const rows = unlabeledRunReceipts(db, INVOICE_CHECK_ID)
    .map((row) => ({ ...row, run_state: row.run_id ? getRun(db, row.run_id)?.state : undefined }))
    .filter((row): row is { id: number; run_id: string | null; decision: string; run_state: string } =>
      row.run_state === "accepted" || row.run_state === "blocked" || row.run_state === "closed");
  for (const row of rows) recordOutcome(db, row.id, (row.run_state === "accepted") === (row.decision === "match") ? "agree" : "disagree");
  return rows.length;
}

/** How long after the route a graph run started under the same PM run counts as this route's result. */
const ROUTE_OUTCOME_WINDOW_MS = 30 * 60_000;

/**
 * The label `calibrate` reads for a confident `route.workflow` pick (decided_by='jev'): the graph the pick started is the
 * stronger judge. It reached its terminal → agree; it failed or was canceled, or a different graph went instead (the owner
 * or the PM rerouted) → disagree. Routes still running and receipts with no linked run stay unlabeled.
 */
export function sweepRouteWorkflowOutcomes(db: Database.Database): number {
  const receipts = unlabeledJevReceipts(db, ROUTE_WORKFLOW_ID);
  let labeled = 0;
  for (const receipt of receipts) {
    if (!receipt.run_id) continue;
    const run = wfEarliestLinkedRun(db, receipt.run_id, receipt.at, receipt.at + ROUTE_OUTCOME_WINDOW_MS);
    if (!run || run.status === "running" || run.status === "waiting") continue;
    const choice = receipt.decision.replace(/\s*\(\d+\)\s*$/, "");
    const agree = run.status === "succeeded" && run.workflow_id === choice;
    recordOutcome(db, receipt.id, agree ? "agree" : "disagree");
    labeled += 1;
  }
  return labeled;
}

/**
 * The task's accepted attempt is the stronger judge of the shadow `plan.fact` read: the code's plan-fact verdict was right
 * when the task was accepted (and the redo family is what it is). Jev's per-item read (done / not_done; `unseen` stays out)
 * is compared with the code's (proven ⇔ done) and the receipt gets agree/disagree. Runs without an accepted attempt and
 * receipts where the stage stored no jev verdict stay unlabeled.
 */
export function sweepPlanFactOutcomes(db: Database.Database): number {
  const receipts = unlabeledSubjectReceipts(db, PLAN_FACT_JEV_ID);
  let labeled = 0;
  for (const receipt of receipts) {
    if (!receipt.run_id || !receipt.subject) continue;
    const accepted = hasAcceptedAttempt(db, receipt.run_id, receipt.subject);
    if (!accepted) continue;
    let result: { items?: Array<{ item: number; verdict: string }>; jev?: Record<string, string> } | null = null;
    try { result = getStageReceiptResult(db, receipt.run_id, receipt.subject, "plan-fact").result as { items?: Array<{ item: number; verdict: string }>; jev?: Record<string, string> } | null; }
    catch { /* unreadable result_json: this receipt stays unlabeled */ }
    if (!result?.jev || !result.items?.length) continue;
    const code = Object.fromEntries(result.items.map((item) => [String(item.item), item.verdict === "proven" ? "done" : "not_done"]));
    const agreed = Object.entries(result.jev).filter(([item, verdict]) => verdict !== "unseen" && code[item] !== undefined).every(([item, verdict]) => verdict === code[item]);
    if (Object.values(code).length) { recordOutcome(db, receipt.id, agreed ? "agree" : "disagree"); labeled += 1; }
  }
  return labeled;
}

export type LabeledOutcome = { receiptId: number; runId: string; taskId: string; outcome: "agree" | "disagree" };

/**
 * The task's result is the stronger judge of `writer.model` (W31 rank 3a): an accepted task confirms the pick — whether Jev
 * chose a profile or decided to keep the project's writer — a task that ended without acceptance (every attempt terminal and
 * none accepted, or the run closed over it) denies it. Attempts still going stay unlabeled. The returned rows let the caller
 * write the same outcome into the task's `writer-route` KV record.
 */
export function sweepWriterModelOutcomes(db: Database.Database): LabeledOutcome[] {
  const receipts = unlabeledJevSubjectReceipts(db, WRITER_MODEL_JUDGMENT_ID);
  const labeled: LabeledOutcome[] = [];
  for (const receipt of receipts) {
    let outcome: "agree" | "disagree" | null = null;
    if (hasAcceptedAttempt(db, receipt.run_id, receipt.subject)) {
      outcome = "agree";
    } else {
      const open = hasLiveAttempt(db, receipt.run_id, receipt.subject);
      const run = getRun(db, receipt.run_id);
      if (!open && (!run || run.closed_at !== null || run.state !== "running")) outcome = "disagree";
    }
    if (!outcome) continue;
    recordOutcome(db, receipt.id, outcome);
    labeled.push({ receiptId: receipt.id, runId: receipt.run_id, taskId: receipt.subject, outcome });
  }
  return labeled;
}

registerOutcomeSweep(FAILURE_CLASS_ID, sweepFailureClassOutcomes);
registerOutcomeSweep(INVOICE_CHECK_ID, sweepInvoiceCheckOutcomes);
registerOutcomeSweep(ROUTE_WORKFLOW_ID, sweepRouteWorkflowOutcomes);
registerOutcomeSweep(PLAN_FACT_JEV_ID, sweepPlanFactOutcomes);
registerOutcomeSweep(WRITER_MODEL_JUDGMENT_ID, (db) => sweepWriterModelOutcomes(db).length);

let lastSweep = 0;

export async function judgedFailureClass(deps: JudgedFailureDeps, state: string, reason: string | null | undefined, subject?: string): Promise<FailureClass> {
  const rules = classifyFailure(state, reason);
  if (rules.confident || !reason?.trim()) return rules.cls;
  const instance = deps.jev();
  if (!instance) return rules.cls;
  try {
    // settings are advisory for the judge; empty settings still allow the judgment
    const settings = await deps.settings().catch(() => ({} as JevSettings));
    if (!instance.enabled(settings)) return rules.cls;
    // At most once a minute: the labels of earlier judgments ride along, so the calibration set fills itself.
    if (deps.db && Date.now() - lastSweep > 60_000) {
      lastSweep = Date.now();
      sweepFailureClassOutcomes(deps.db); sweepInvoiceCheckOutcomes(deps.db); sweepRouteWorkflowOutcomes(deps.db); sweepPlanFactOutcomes(deps.db);
      const labeled = sweepWriterModelOutcomes(deps.db);
      if (deps.kv) for (const row of labeled) {
        const key = writerRouteKey(row.runId, row.taskId);
        const route = await deps.kv.get(key);
        // outcome backfill is best-effort; the labeled row is already durable in the sweep
        if (route && typeof route === "object") await deps.kv.set(key, { ...(route as Record<string, unknown>), outcome: row.outcome, outcomeAt: Date.now() }).catch(() => undefined);
      }
    }
    // B8: a pointed failure line found in the log sharpens the class question (shadow records it either way).
    const lines = reason.split("\n").map((line) => line.trim()).filter(Boolean);
    let pointed: string | null = null;
    if (lines.length > 12) {
      // the log-find pass is advisory; null just means no pointed line
      const found = await instance.judge(logFindJudgment, { task: subject ?? "attempt", command: state.slice(0, 200), lines }, { projectId: deps.projectId, runId: deps.runId, subject: subject ?? "attempt", settings }).catch(() => null);
      const pick = found?.by === "jev" ? found.decision.line : found?.by === "fallback" ? (found.shadow?.decision?.line ?? null) : null;
      if (pick !== null && pick !== undefined) pointed = lines[pick] ?? null;
    }
    const judged = pointed ? `${state}
pointed line: ${pointed}` : state;
    const verdict = await instance.judge(failureClassJudgment, { state: judged, reason }, { projectId: deps.projectId, runId: deps.runId, subject: subject ?? "attempt", settings });
    if (verdict.by === "jev") return verdict.decision.cls;
    // Shadow receipts that proved themselves go live: the labeled outcomes reached the gate, so the class Jev recorded wins.
    if (verdict.by === "fallback" && verdict.shadow?.decision && deps.db && failureClassLive(deps.db)) return (verdict.shadow.decision as FailureClassDecision).cls;
    return rules.cls;
  } catch { return rules.cls; }
}

let gateCheckedAt = 0, gateLive = false;

/**
 * The shadow→live gate for `failure.class`: its own receipts vote. With 10+ labeled outcomes (the sweeps above write
 * agree/disagree from the run's terminal state) and 75%+ agreement the judgment decides like an active one even in shadow
 * mode; below that the rules' class is used and `failureClassReport` says what is missing. Checked once a minute.
 */
export function failureClassLive(db: Database.Database): boolean {
  if (Date.now() - gateCheckedAt < 60_000) return gateLive;
  gateCheckedAt = Date.now();
  const outcomes = labeledOutcomes(db, FAILURE_CLASS_ID);
  const agree = outcomes.filter((outcome) => outcome.startsWith("agree")).length;
  const disagree = outcomes.filter((outcome) => outcome.startsWith("disagree")).length;
  gateLive = agree + disagree >= 10 && agree / (agree + disagree) >= 0.75;
  return gateLive;
}

/** Why `failure.class` is or is not live: the labeled sample it would need, as the `jev failure` report prints it. */
export function failureClassReport(db: Database.Database): { calls: number; labeled: number; agree: number; disagree: number; accuracy: number | null; live: boolean; reason: string } {
  const calls = countJudgmentReceipts(db, FAILURE_CLASS_ID);
  const outcomes = labeledOutcomes(db, FAILURE_CLASS_ID);
  const agree = outcomes.filter((outcome) => outcome.startsWith("agree")).length;
  const disagree = outcomes.filter((outcome) => outcome.startsWith("disagree")).length;
  const labeled = agree + disagree;
  const accuracy = labeled ? agree / labeled : null;
  const live = labeled >= 10 && accuracy !== null && accuracy >= 0.75;
  const reason = live ? "gate: enough labeled outcomes and 75% agreement"
    : calls === 0 ? "never called yet — shadow judgments collect labels as attempts fail"
    : labeled < 10 ? `only ${labeled} labeled outcomes of the 10 needed; the shadow calls keep collecting`
    : `accuracy ${Math.round((accuracy ?? 0) * 100)}% is under the 75% gate — stays shadow`;
  return { calls, labeled, agree, disagree, accuracy, live, reason };
}
