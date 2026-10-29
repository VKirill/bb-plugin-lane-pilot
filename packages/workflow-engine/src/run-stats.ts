import type { LanePilotDatabase } from "./db";

import { tallyOutcomes, type OutcomeRow } from "./business-outcome";
import type { RunRecord } from "./router";

/** How each workflow has run: finished top-level runs by business outcome and when the last one started. The router's tiebreaker reads it. */
export function runRecords(db: LanePilotDatabase): Map<string, RunRecord> {
  // ponytail: classifies every top-level run in JS. Ceiling: a long journal. Upgrade: a stored outcome column.
  const rows = db.prepare(`SELECT workflow_id AS id, status, output_json, definition_json, created_at
    FROM lane_pilot_wf_run WHERE parent_run_id IS NULL`).all() as Array<OutcomeRow & { id: string; created_at: number }>;
  const grouped = new Map<string, { rows: OutcomeRow[]; last: number | null }>();
  for (const row of rows) {
    const bucket = grouped.get(row.id) ?? { rows: [], last: null };
    bucket.rows.push(row);
    bucket.last = bucket.last === null ? row.created_at : Math.max(bucket.last, row.created_at);
    grouped.set(row.id, bucket);
  }
  const out = new Map<string, RunRecord>();
  for (const [id, bucket] of grouped) {
    const tally = tallyOutcomes(bucket.rows);
    out.set(id, {
      succeeded: tally.workDone,
      failed: tally.engineBad + tally.executed - tally.workDone - tally.escalated,
      lastRunAt: bucket.last,
      executed: tally.executed,
      workDone: tally.workDone,
      refused: tally.refused,
      escalated: tally.escalated,
    });
  }
  return out;
}
