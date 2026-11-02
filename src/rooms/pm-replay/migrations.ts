/**
 * Tables of the PM replay room (src/rooms/pm-replay), appended to the plugin's migrations, append only.
 *
 * - `lane_pilot_pm_scenario`: one replay scenario — the moment before a PM's wrong action plus the owner's triggering
 *   message, grown by the nightly harvest or seeded by `bb lane-pilot pm-replay import` (the manual pm-live-eval set).
 *   `rule_id` ties a scenario to the PM rule it proves.
 * - `lane_pilot_pm_replay`: one graded run of a scenario on one arm (an arm is the PM prompt fingerprint plus the rule
 *   ids it carries): verdict, the judge's why, the calls, the cost.
 */
export const pmReplayMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_pm_scenario (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_thread TEXT,
    source_seq INTEGER,
    msg TEXT NOT NULL,
    responses_json TEXT NOT NULL DEFAULT '{}',
    expect_json TEXT NOT NULL DEFAULT '[]',
    forbid_json TEXT NOT NULL DEFAULT '[]',
    arg_check_json TEXT NOT NULL DEFAULT '{}',
    should TEXT,
    fail_if TEXT,
    rule_id TEXT,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','retired'))
  )`,
  `CREATE INDEX lane_pilot_pm_scenario_state ON lane_pilot_pm_scenario(state, created_at)`,
  `CREATE INDEX lane_pilot_pm_scenario_rule ON lane_pilot_pm_scenario(rule_id)`,
  `CREATE TABLE lane_pilot_pm_replay (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id TEXT NOT NULL,
    arm TEXT NOT NULL,
    sample INTEGER NOT NULL DEFAULT 1,
    verdict TEXT NOT NULL,
    why TEXT,
    calls_json TEXT NOT NULL DEFAULT '[]',
    cost_usd REAL NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_pm_replay_scenario ON lane_pilot_pm_replay(scenario_id, arm, at)`,
  `CREATE INDEX lane_pilot_pm_replay_arm ON lane_pilot_pm_replay(arm, at)`,
];
