import type { LanePilotDatabase } from "../database";

export type AcceptedFactRow = { taskId: string; runId: string; fact: unknown; summarizedAt: number | null; createdAt: number };

/** J-002: the append-only fact of one accepted task. INSERT OR IGNORE keeps the first write: a fact is never overwritten. */
export function appendAcceptedFact(db: LanePilotDatabase, input: { projectId: string; runId: string; taskId: string; fact: unknown; at?: number }): void {
  db.prepare("INSERT OR IGNORE INTO lane_pilot_accepted_fact (project_id,run_id,task_id,fact_json,created_at) VALUES(?,?,?,?,?)")
    .run(input.projectId, input.runId, input.taskId, JSON.stringify(input.fact ?? {}), input.at ?? Date.now());
}

const factRow = (row: { task_id: string; run_id: string; fact_json: string; summarized_at: number | null; created_at: number }): AcceptedFactRow => {
  let fact: unknown = {};
  try { fact = JSON.parse(row.fact_json) as unknown; } catch { /* a broken row is still a row: the task stays covered */ }
  return { taskId: row.task_id, runId: row.run_id, fact, summarizedAt: row.summarized_at, createdAt: row.created_at };
};

export function listAcceptedFacts(db: LanePilotDatabase, runId: string): AcceptedFactRow[] {
  return (db.prepare("SELECT task_id,run_id,fact_json,summarized_at,created_at FROM lane_pilot_accepted_fact WHERE run_id=? ORDER BY created_at")
    .all(runId) as Array<{ task_id: string; run_id: string; fact_json: string; summarized_at: number | null; created_at: number }>).map(factRow);
}

/** Facts of this run no wave-idle summary has covered yet — the batch the next idle memory maintainer gets. */
export function listPendingAcceptedFacts(db: LanePilotDatabase, runId: string): AcceptedFactRow[] {
  return (db.prepare("SELECT task_id,run_id,fact_json,summarized_at,created_at FROM lane_pilot_accepted_fact WHERE run_id=? AND summarized_at IS NULL ORDER BY created_at")
    .all(runId) as Array<{ task_id: string; run_id: string; fact_json: string; summarized_at: number | null; created_at: number }>).map(factRow);
}

export function markAcceptedFactsSummarized(db: LanePilotDatabase, runId: string, taskIds: readonly string[], at = Date.now()): void {
  if (!taskIds.length) return;
  const stamp = db.prepare("UPDATE lane_pilot_accepted_fact SET summarized_at=? WHERE run_id=? AND task_id=? AND summarized_at IS NULL");
  db.transaction(() => { for (const taskId of taskIds) stamp.run(at, runId, taskId); })();
}
