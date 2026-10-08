import type { LanePilotDatabase } from "./db";

import type { RunRecord } from "./router";

/** How each workflow has run: finished top-level runs by outcome and when the last one started. The router's tiebreaker reads it. */
export function runRecords(db: LanePilotDatabase): Map<string, RunRecord> {
  const rows = db.prepare(`SELECT workflow_id AS id, COALESCE(SUM(status='succeeded'),0) AS ok, COALESCE(SUM(status IN ('failed','blocked','interrupted')),0) AS bad, MAX(created_at) AS last
    FROM lane_pilot_wf_run WHERE parent_run_id IS NULL GROUP BY workflow_id`).all() as Array<{ id: string; ok: number; bad: number; last: number | null }>;
  return new Map(rows.map((row) => [row.id, { succeeded: row.ok, failed: row.bad, lastRunAt: row.last }]));
}
