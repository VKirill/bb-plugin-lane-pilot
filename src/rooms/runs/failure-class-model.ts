import type Database from "better-sqlite3";
import { classifyFailure, type FailureClass } from "./failure-class";
import { failureClassJudgment, FAILURE_CLASS_ID } from "./failure-class-judgment";
import { logFindJudgment } from "@lane-pilot/jev/judgments/log-find";
import { recordOutcome, type Jev, type JevSettings } from "@lane-pilot/jev";
import { INVOICE_CHECK_ID } from "@lane-pilot/jev/judgments/invoice-check";
import { ROUTE_WORKFLOW_ID } from "../workflow/route-workflow";

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
};

/**
 * The label `calibrate` reads for `failure.class`: the run's terminal state is the stronger judge. Accepted means the class —
 * whatever it blamed — did not kill the work (agree). A dead run confirms a `task` reading and denies a `provider`/`infra`
 * parking that cost the task its attempts. Runs still going are left unlabeled. Receipts of shadow calls carry the decision
 * Jev would have made, so they are labeled the same way.
 */
export function sweepFailureClassOutcomes(db: Database.Database): number {
  const rows = db.prepare(`SELECT r.id, r.decision, run.state AS run_state FROM lane_pilot_jev_receipt r
    JOIN lane_pilot_run run ON run.id = r.run_id
    WHERE r.judgment = ? AND r.outcome IS NULL AND r.status = 'ok' AND r.decision IS NOT NULL AND run.state IN ('accepted','blocked','closed')`).all(FAILURE_CLASS_ID) as Array<{ id: number; decision: string; run_state: string }>;
  for (const row of rows) recordOutcome(db, row.id, row.run_state === "accepted" ? "agree" : row.decision === "task" ? "agree" : "disagree");
  return rows.length;
}

/**
 * The owner's decision on the invoice is the stronger judge of `invoice.check`: a sent invoice confirms a `match` and
 * denies a `mismatch`; a run that stopped before the send confirms a hold (mismatch/unsure) and denies a match the owner
 * did not let through. Runs the receipt cannot see (a workflow run outside lane_pilot_run, or one still going) stay unlabeled.
 */
export function sweepInvoiceCheckOutcomes(db: Database.Database): number {
  const rows = db.prepare(`SELECT r.id, r.decision, run.state AS run_state FROM lane_pilot_jev_receipt r
    JOIN lane_pilot_run run ON run.id = r.run_id
    WHERE r.judgment = ? AND r.outcome IS NULL AND r.status = 'ok' AND r.decision IS NOT NULL AND run.state IN ('accepted','blocked','closed')`).all(INVOICE_CHECK_ID) as Array<{ id: number; decision: string; run_state: string }>;
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
  const receipts = db.prepare(`SELECT id, run_id, decision, at FROM lane_pilot_jev_receipt
    WHERE judgment = ? AND outcome IS NULL AND status = 'ok' AND decided_by = 'jev' AND decision IS NOT NULL`).all(ROUTE_WORKFLOW_ID) as Array<{ id: number; run_id: string | null; decision: string; at: number }>;
  let labeled = 0;
  for (const receipt of receipts) {
    if (!receipt.run_id) continue;
    const run = db.prepare(`SELECT workflow_id, status FROM lane_pilot_wf_run
      WHERE link_run_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at LIMIT 1`)
      .get(receipt.run_id, receipt.at, receipt.at + ROUTE_OUTCOME_WINDOW_MS) as { workflow_id: string; status: string } | undefined;
    if (!run || run.status === "running" || run.status === "waiting") continue;
    const choice = receipt.decision.replace(/\s*\(\d+\)\s*$/, "");
    const agree = run.status === "succeeded" && run.workflow_id === choice;
    recordOutcome(db, receipt.id, agree ? "agree" : "disagree");
    labeled += 1;
  }
  return labeled;
}

let lastSweep = 0;

export async function judgedFailureClass(deps: JudgedFailureDeps, state: string, reason: string | null | undefined, subject?: string): Promise<FailureClass> {
  const rules = classifyFailure(state, reason);
  if (rules.confident || !reason?.trim()) return rules.cls;
  const instance = deps.jev();
  if (!instance) return rules.cls;
  try {
    const settings = await deps.settings().catch(() => ({} as JevSettings));
    if (!instance.enabled(settings)) return rules.cls;
    // At most once a minute: the labels of earlier judgments ride along, so the calibration set fills itself.
    if (deps.db && Date.now() - lastSweep > 60_000) { lastSweep = Date.now(); sweepFailureClassOutcomes(deps.db); sweepInvoiceCheckOutcomes(deps.db); sweepRouteWorkflowOutcomes(deps.db); }
    // B8: a pointed failure line found in the log sharpens the class question (shadow records it either way).
    const lines = reason.split("\n").map((line) => line.trim()).filter(Boolean);
    let pointed: string | null = null;
    if (lines.length > 12) {
      const found = await instance.judge(logFindJudgment, { task: subject ?? "attempt", command: state.slice(0, 200), lines }, { projectId: deps.projectId, runId: deps.runId, subject: subject ?? "attempt", settings }).catch(() => null);
      const pick = found?.by === "jev" ? found.decision.line : found?.by === "fallback" ? (found.shadow?.decision?.line ?? null) : null;
      if (pick !== null && pick !== undefined) pointed = lines[pick] ?? null;
    }
    const judged = pointed ? `${state}
pointed line: ${pointed}` : state;
    const verdict = await instance.judge(failureClassJudgment, { state: judged, reason }, { projectId: deps.projectId, runId: deps.runId, subject: subject ?? "attempt", settings });
    return verdict.by === "jev" ? verdict.decision.cls : rules.cls;
  } catch { return rules.cls; }
}
