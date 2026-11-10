import type Database from "better-sqlite3";

/** The lane_pilot_task_draft rows (SMA m_sw_chat_draft): plain CRUD for the tasks room's draft logic. */
export type TaskDraftRow = { id: string; run_id: string | null; project_id: string; thread_id: string | null; kind: string;
  contracts_json: string; objective: string | null; plan: string | null; state: string; task_ids_json: string | null; created_at: number; updated_at: number };
type Db = Pick<Database.Database, "prepare" | "transaction">;

export function insertTaskDraftRow(db: Db, row: TaskDraftRow): void {
  db.prepare(`INSERT INTO lane_pilot_task_draft(id,run_id,project_id,thread_id,kind,contracts_json,objective,plan,state,task_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.run_id, row.project_id, row.thread_id, row.kind, row.contracts_json, row.objective, row.plan, row.state, row.task_ids_json, row.created_at, row.updated_at);
}
export function getTaskDraftRow(db: Db, id: string): TaskDraftRow | null {
  return (db.prepare("SELECT * FROM lane_pilot_task_draft WHERE id=?").get(id) as TaskDraftRow | undefined) ?? null;
}
/** proposed→created in one transaction; returns the number of rows flipped (0 = the draft was already claimed). */
export function claimTaskDraftRow(db: Db, id: string, at: number): number {
  return db.transaction(() => db.prepare("UPDATE lane_pilot_task_draft SET state='created', updated_at=? WHERE id=? AND state='proposed'").run(at, id).changes)();
}
export function saveDraftTaskIds(db: Db, id: string, taskIdsJson: string, at: number): void {
  db.prepare("UPDATE lane_pilot_task_draft SET task_ids_json=?, updated_at=? WHERE id=?").run(taskIdsJson, at, id);
}
