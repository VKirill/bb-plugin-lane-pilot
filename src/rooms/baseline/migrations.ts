/**
 * The baseline before a writer and the regression pass after acceptance (SMA atlas delta D1-3 and D1-2). Three tables, created by
 * these statements and spread at the END of `migrations` in storage/database.ts.
 *
 * lane_pilot_baseline: one row per task start. The task's verification[] on the base the attempt starts from: which checks were already
 * green, which red, which were skipped (too slow, carry secrets). `verdict` already_built means every check ran and passed;
 * `action` says what the mode did (proceed, notified, stopped). `after_json` is filled when the work is merged and its checks run on
 * main: which checks were green on the base and red after the change.
 *
 * lane_pilot_regression: a check that was green when its task was accepted and is red on the current main. `kind` regression is a check
 * that was green at the task's own merge commit too; `unstable` is red at its own merge as well (flaky or the machine), never put
 * on the morning list. The culprit is found by `git bisect` in a throwaway worktree between the merge and main; nothing is reverted.
 *
 * lane_pilot_regress_pass: one row per project per pass, with the numbers and what was skipped and why.
 */
export const baselineMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_baseline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT,
    base_sha TEXT,
    state TEXT NOT NULL CHECK(state IN ('ran','skipped','error')),
    verdict TEXT NOT NULL CHECK(verdict IN ('already_built','partial','red','unknown')),
    mode TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('proceed','notified','stopped')),
    summary TEXT NOT NULL,
    checks_json TEXT NOT NULL DEFAULT '[]',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    after_json TEXT
  )`,
  `CREATE INDEX lane_pilot_baseline_task ON lane_pilot_baseline(run_id, task_id)`,
  `CREATE INDEX lane_pilot_baseline_base ON lane_pilot_baseline(project_id, base_sha)`,
  `CREATE TABLE lane_pilot_regression (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    found_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT,
    command TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('regression','unstable')),
    state TEXT NOT NULL CHECK(state IN ('open','closed')) DEFAULT 'open',
    green_at TEXT,
    red_at TEXT,
    bisect_status TEXT NOT NULL CHECK(bisect_status IN ('found','none','failed','skipped')),
    culprit_commit TEXT,
    culprit_task TEXT,
    culprit_subject TEXT,
    note TEXT,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    closed_at INTEGER,
    closed_reason TEXT
  )`,
  `CREATE UNIQUE INDEX lane_pilot_regression_open ON lane_pilot_regression(task_id, command) WHERE state='open'`,
  `CREATE INDEX lane_pilot_regression_project ON lane_pilot_regression(project_id, state)`,
  `CREATE TABLE lane_pilot_regress_pass (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    head_sha TEXT,
    dry_run INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX lane_pilot_regress_pass_project ON lane_pilot_regress_pass(project_id, at)`,
];
