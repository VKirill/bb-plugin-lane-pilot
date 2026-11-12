import type Database from "better-sqlite3";
import { recordOutcome, registerOutcomeSweep, unlabeledJevReceipts, unlabeledRunReceipts } from "@lane-pilot/jev";
import { INVOICE_CHECK_ID } from "@lane-pilot/jev/judgments/invoice-check";
import { ROUTE_WORKFLOW_ID } from "../contracts";

import { getRun } from "../storage";
import { wfEarliestLinkedRun } from "@lane-pilot/workflow-engine";

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

registerOutcomeSweep(INVOICE_CHECK_ID, sweepInvoiceCheckOutcomes);
registerOutcomeSweep(ROUTE_WORKFLOW_ID, sweepRouteWorkflowOutcomes);
