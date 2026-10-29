/**
 * The run-goal check (SMA atlas D2-3: «the whole composition», «phase verdict», the integration checker). One table, spread at the END of
 * `migrations` in storage/database.ts.
 *
 * lane_pilot_run_goal: one row per run that finished with two accepted tasks or more. `state` passed (every required check ran
 * green), failed (`red_json`), partial or inconclusive (the required set was not all run; counts in planned/ran/skipped_checks)
 * or skipped (`detail`: the pass itself did not run).
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

/** Widens `state` (SQLite cannot alter a CHECK) and stores how much of the required set ran. Append-only; spread at the end of `migrations`. */
export const runGoalCoverageMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_run_goal_next (
    run_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('passed','failed','skipped','partial','inconclusive')),
    tasks INTEGER NOT NULL,
    head_sha TEXT,
    red_json TEXT NOT NULL DEFAULT '[]',
    detail TEXT,
    at INTEGER NOT NULL,
    planned INTEGER NOT NULL DEFAULT 0,
    ran INTEGER NOT NULL DEFAULT 0,
    skipped_checks INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT INTO lane_pilot_run_goal_next (run_id,project_id,state,tasks,head_sha,red_json,detail,at)
    SELECT run_id,project_id,state,tasks,head_sha,red_json,detail,at FROM lane_pilot_run_goal`,
  `DROP TABLE lane_pilot_run_goal`,
  `ALTER TABLE lane_pilot_run_goal_next RENAME TO lane_pilot_run_goal`,
];
