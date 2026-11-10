import type Database from "better-sqlite3";

/** The PM thread a backlog item was handed to, or undefined when it was never issued: only that thread closes the item. */
export function backlogIssuedTo(db: Pick<Database.Database, "prepare">, projectId: string, todoId: string): string | undefined {
  return (db.prepare("SELECT pm_thread_id FROM lane_pilot_backlog_issue WHERE project_id=? AND todo_id=?").get(projectId, todoId) as { pm_thread_id: string } | undefined)?.pm_thread_id;
}
