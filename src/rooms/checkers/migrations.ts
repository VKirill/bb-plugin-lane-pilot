/**
 * Checking the checkers (src/rooms/checkers): a run plants known defects in accepted candidates and records, for every checker, whether it
 * caught each one. Spread at the end of `migrations` in storage/database.ts.
 *
 * - `lane_pilot_checker_run`: one scoring run (its source, settings and spend).
 * - `lane_pilot_checker_result`: one row per planted defect (or clean control) and checker; the scorecard is built from these rows.
 */
export const checkerMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_checker_run (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','done','stopped_budget','failed')),
    config_json TEXT NOT NULL DEFAULT '{}',
    spent_tokens INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE TABLE lane_pilot_checker_result (
    run_id TEXT NOT NULL REFERENCES lane_pilot_checker_run(id),
    defect_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    defect_class TEXT NOT NULL,
    checker TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('hit','miss','off_target','n/a','error','skipped_budget')),
    flagged INTEGER NOT NULL CHECK(flagged IN (0,1)),
    expected INTEGER NOT NULL CHECK(expected IN (0,1)),
    summary TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    tokens INTEGER,
    cost_usd REAL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, defect_id, checker)
  ) WITHOUT ROWID`,
  `CREATE INDEX lane_pilot_checker_run_started ON lane_pilot_checker_run(started_at)`,
];
