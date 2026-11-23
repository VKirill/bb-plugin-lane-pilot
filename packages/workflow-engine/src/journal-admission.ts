import type Database from "better-sqlite3";
import { receiptThreadId } from "./journal";

/** Includes interrupted/blocked children: their callers can resume them after the current turn. */
export function wfHasResumableLinkedRun(db: Pick<Database.Database, "prepare">, linkRunId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE link_run_id=? AND status IN ('running','waiting','blocked','interrupted') LIMIT 1").get(linkRunId));
}

/** True when at least one workflow run of `workflowId` linked to `linkRunId` has succeeded; false when none exists or the table is absent. */
export function wfHasSucceededLinkedWorkflow(db: Pick<Database.Database, "prepare">, linkRunId: string, workflowId: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE link_run_id=? AND workflow_id=? AND status='succeeded' LIMIT 1").get(linkRunId, workflowId));
  } catch {
    return false;
  }
}

/** Worker threads recorded on a workflow run's steps, in execution order. */
export function wfRunStepThreads(db: Pick<Database.Database, "prepare">, runId: string): Array<{ stepKey: string; nodeId: string; state: string; threadId: string }> {
  try {
    const rows = db.prepare("SELECT step_key, node_id, state, receipt_json FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid").all(runId) as Array<{
      step_key: string; node_id: string; state: string; receipt_json: string | null;
    }>;
    return rows.flatMap((row) => {
      const threadId = receiptThreadId(row.receipt_json);
      return threadId ? [{ stepKey: row.step_key, nodeId: row.node_id, state: row.state, threadId }] : [];
    });
  } catch {
    return [];
  }
}
