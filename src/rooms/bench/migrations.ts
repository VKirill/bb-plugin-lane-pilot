/**
 * LP-Bench (SMA plan P0-1): a fixed set of real past tasks with a known right result, run again on a changed arm and compared in
 * pairs. Spread at the end of `migrations` in storage/database.ts.
 *
 * - `lane_pilot_bench_set`/`lane_pilot_bench_task`: a set version and its tasks. Never changed after it is written («набор не меняешь»):
 *   the triggers refuse UPDATE and DELETE; a different set is a new version. `manifest_sha256` is the hash of the tasks (contract,
 *   base commit, solution patch hash) and is checked again before every run.
 * - `lane_pilot_bench_run`: one series (arm, repeat). `lane_pilot_bench_result`: one row per task of the series.
 * - `lane_pilot_bench_noise`: two identical arms compared; the threshold of `compare` is calibrated on it.
 * - `lane_pilot_bench_project`: what a bench sandbox project runs under (the harness tree an arm names), read when a writer attempt starts.
 * - `lane_pilot_bench_verdict`: a comparison that decided something (a harness tree adopted or retired by the bench).
 */
export const benchMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_bench_set (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    manifest_sha256 TEXT NOT NULL,
    task_count INTEGER NOT NULL,
    candidate_count INTEGER NOT NULL,
    rejected_json TEXT NOT NULL DEFAULT '[]',
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE lane_pilot_bench_task (
    set_id TEXT NOT NULL REFERENCES lane_pilot_bench_set(id),
    task_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    host_id TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    stratum TEXT NOT NULL,
    hard INTEGER NOT NULL CHECK(hard IN (0,1)),
    risk TEXT NOT NULL,
    area TEXT NOT NULL DEFAULT '',
    initial_head_sha TEXT NOT NULL,
    solution_commit TEXT NOT NULL,
    solution_patch_sha256 TEXT NOT NULL,
    contract_json TEXT NOT NULL,
    warm_json TEXT NOT NULL,
    PRIMARY KEY(set_id, task_id)
  ) WITHOUT ROWID`,
  `CREATE TRIGGER lane_pilot_bench_set_frozen_u BEFORE UPDATE ON lane_pilot_bench_set BEGIN SELECT RAISE(ABORT, 'a bench set is never changed: write a new version'); END`,
  `CREATE TRIGGER lane_pilot_bench_set_frozen_d BEFORE DELETE ON lane_pilot_bench_set BEGIN SELECT RAISE(ABORT, 'a bench set is never changed: write a new version'); END`,
  `CREATE TRIGGER lane_pilot_bench_task_frozen_u BEFORE UPDATE ON lane_pilot_bench_task BEGIN SELECT RAISE(ABORT, 'a bench set is never changed: write a new version'); END`,
  `CREATE TRIGGER lane_pilot_bench_task_frozen_d BEFORE DELETE ON lane_pilot_bench_task BEGIN SELECT RAISE(ABORT, 'a bench set is never changed: write a new version'); END`,
  `CREATE TABLE lane_pilot_bench_run (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES lane_pilot_bench_set(id),
    arm TEXT NOT NULL,
    repeat_no INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','done','stopped_budget','failed')),
    stop_reason TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    budget_tokens INTEGER,
    budget_hours REAL,
    spent_tokens INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    UNIQUE(set_id, arm, repeat_no)
  )`,
  `CREATE TABLE lane_pilot_bench_result (
    run_id TEXT NOT NULL REFERENCES lane_pilot_bench_run(id),
    task_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('accepted','not_accepted','error','skipped_budget')),
    accepted INTEGER NOT NULL CHECK(accepted IN (0,1)),
    bench_task_id TEXT,
    lp_run_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    stages_passed INTEGER NOT NULL DEFAULT 0,
    stages_failed INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER,
    cost_usd REAL,
    cost_state TEXT NOT NULL CHECK(cost_state IN ('measured','partial','not_measured')),
    seconds INTEGER,
    reason TEXT,
    metrics_json TEXT NOT NULL DEFAULT '[]',
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, task_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_bench_noise (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES lane_pilot_bench_set(id),
    arm_a TEXT NOT NULL,
    arm_b TEXT NOT NULL,
    noise_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE lane_pilot_bench_verdict (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES lane_pilot_bench_set(id),
    arm_a TEXT NOT NULL,
    arm_b TEXT NOT NULL,
    harness_id TEXT,
    passed INTEGER NOT NULL CHECK(passed IN (0,1)),
    report_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE lane_pilot_bench_project (
    project_id TEXT PRIMARY KEY,
    harness TEXT NOT NULL DEFAULT 'none',
    source_project_id TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_bench_verdict_harness ON lane_pilot_bench_verdict(harness_id, created_at)`,
];
