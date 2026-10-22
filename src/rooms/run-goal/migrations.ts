/**
 * The run-goal check (SMA atlas D2-3: «the whole composition», «phase verdict», the integration checker). One table, spread at the END of
 * `migrations` in storage/database.ts.
 *
 * lane_pilot_run_goal: one row per run that finished with two accepted tasks or more. `state` passed (every check of every task is green
 * together on main), failed (`red_json`: the task, the command and the commit bisect named) or skipped (`detail`: why nothing ran).
 */
export const runGoalMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_run_goal (
    run_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('passed','failed','skipped')),
    tasks INTEGER NOT NULL,
    head_sha TEXT,
    red_json TEXT NOT NULL DEFAULT '[]',
    detail TEXT,
    at INTEGER NOT NULL
  )`,
];
