/**
 * Rolling work back (SMA wall 4: every job rolls back to the state before it, and the record names that state; the
 * record of a failed attempt included). Two tables, created by these statements and spread at the END of `migrations` in
 * storage/database.ts.
 *
 * lane_pilot_attempt_change: one row per attempt, filled as the attempt goes. `base_sha` is the commit its worktree started
 * from, `merge_parent` main's HEAD right before its merge, `merge_commit` the merge, `changed_json` the files it changed
 * (deletions as D), `worktree_json` what its worktree held when the stop was confirmed or the worktree was returned.
 *
 * lane_pilot_task_receipt: what `bb lane-pilot reverify` and `bb lane-pilot revert` found and did. Append only.
 */
export const rollbackMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_attempt_change (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    base_sha TEXT,
    merge_parent TEXT,
    merge_commit TEXT,
    outcome TEXT,
    changed_json TEXT NOT NULL DEFAULT '[]',
    worktree_json TEXT,
    recorded_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_attempt_change_task ON lane_pilot_attempt_change(task_id)`,
  `CREATE TABLE lane_pilot_task_receipt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('reverify','revert')),
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT,
    base_sha TEXT,
    change_sha TEXT,
    result_commit TEXT,
    state TEXT NOT NULL CHECK(state IN ('passed','failed','merged','dry_run','refused','error')),
    summary TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX lane_pilot_task_receipt_task ON lane_pilot_task_receipt(task_id, at)`,
  `CREATE TRIGGER lane_pilot_task_receipt_no_update BEFORE UPDATE ON lane_pilot_task_receipt BEGIN SELECT RAISE(ABORT, 'task receipts are append-only'); END`,
  `CREATE TRIGGER lane_pilot_task_receipt_no_delete BEFORE DELETE ON lane_pilot_task_receipt BEGIN SELECT RAISE(ABORT, 'task receipts are append-only'); END`,
];
