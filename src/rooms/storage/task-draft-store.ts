import type Database from "better-sqlite3";

/** The lane_pilot_task_draft rows (SMA m_sw_chat_draft): plain CRUD for the tasks room's draft logic. */
export type TaskDraftRow = { id: string; run_id: string | null; project_id: string; thread_id: string | null; kind: string;
  contracts_json: string; objective: string | null; plan: string | null; state: string; task_ids_json: string | null; results_json: string | null; created_at: number; updated_at: number };
type Db = Pick<Database.Database, "prepare" | "transaction">;

export function insertTaskDraftRow(db: Db, row: TaskDraftRow): void {
  db.prepare(`INSERT INTO lane_pilot_task_draft(id,run_id,project_id,thread_id,kind,contracts_json,objective,plan,state,task_ids_json,results_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.run_id, row.project_id, row.thread_id, row.kind, row.contracts_json, row.objective, row.plan, row.state, row.task_ids_json, row.results_json, row.created_at, row.updated_at);
}
export function getTaskDraftRow(db: Db, id: string): TaskDraftRow | null {
  return (db.prepare("SELECT * FROM lane_pilot_task_draft WHERE id=?").get(id) as TaskDraftRow | undefined) ?? null;
}
/** The draft after one more contract was settled: its per-contract results, the created ids and the state. */
export function saveDraftResults(db: Db, id: string, state: string, resultsJson: string, taskIdsJson: string, at: number): void {
  db.prepare("UPDATE lane_pilot_task_draft SET state=?, results_json=?, task_ids_json=?, updated_at=? WHERE id=?").run(state, resultsJson, taskIdsJson, at, id);
}
/** Drafts not touched since `before` go; returns how many. */
export function pruneTaskDraftRows(db: Db, before: number): number {
  return db.prepare("DELETE FROM lane_pilot_task_draft WHERE updated_at<?").run(before).changes;
}

/** Batch drafts of one project (or of all of them) touched since `since`, newest first — the board's batch cards. */
export function listBatchDraftRows(db: Db, input: { projectId?: string | null; since?: number; limit?: number }): TaskDraftRow[] {
  const since = input.since ?? 0;
  const limit = input.limit ?? 200;
  return (input.projectId
    ? db.prepare("SELECT * FROM lane_pilot_task_draft WHERE kind='batch' AND project_id=? AND updated_at>=? ORDER BY updated_at DESC LIMIT ?").all(input.projectId, since, limit)
    : db.prepare("SELECT * FROM lane_pilot_task_draft WHERE kind='batch' AND updated_at>=? ORDER BY updated_at DESC LIMIT ?").all(since, limit)) as TaskDraftRow[];
}
