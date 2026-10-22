/**
 * Backlog items issued to a PM (src/rooms/backlog). One table, spread at the END of `migrations` in storage/database.ts.
 *
 * lane_pilot_backlog_issue: one row per todo item handed to a project's PM, so it is never handed twice; the daily caps count these rows.
 */
export const backlogMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_backlog_issue (
    project_id TEXT NOT NULL,
    todo_id TEXT NOT NULL,
    pm_thread_id TEXT NOT NULL,
    estimate INTEGER,
    issued_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, todo_id)
  )`,
];
