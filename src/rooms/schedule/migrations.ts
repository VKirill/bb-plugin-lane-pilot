/**
 * The schedule board's tables. Appended at the END of `migrations` in src/rooms/migrations.ts, as a spread, never into an earlier array
 * (tests/migration-lineage.test.ts pins the statements the hub already applied).
 *
 * `lane_pilot_schedule_run.run_key` is `<schedule id>:<scheduled time>` for a tick and `<schedule id>:manual:<nonce>` for a run
 * started by hand. It is UNIQUE: a tick materialised twice (a retried tick, two instances during a reload) is one row.
 */
export const scheduleMigrations: string[] = [
  `CREATE TABLE lane_pilot_schedule (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK(kind IN ('workflow','errand','script')),
    task_json TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('cron','once')),
    cron TEXT,
    timezone TEXT,
    run_at INTEGER,
    missed_policy TEXT NOT NULL DEFAULT 'run_once' CHECK(missed_policy IN ('run_once','skip','run_all')),
    missed_limit INTEGER NOT NULL DEFAULT 5,
    overlap TEXT NOT NULL DEFAULT 'skip' CHECK(overlap IN ('skip','queue','parallel')),
    timeout_sec INTEGER NOT NULL,
    max_failures INTEGER NOT NULL DEFAULT 3,
    state TEXT NOT NULL CHECK(state IN ('active','paused','done')),
    pause_reason TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    cursor_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_schedule_project ON lane_pilot_schedule(project_id, state)`,
  `CREATE TABLE lane_pilot_schedule_run (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES lane_pilot_schedule(id) ON DELETE CASCADE,
    run_key TEXT NOT NULL UNIQUE,
    scheduled_at INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('tick','catchup','manual')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','succeeded','failed','timed_out','skipped','canceled')),
    reason TEXT,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    deadline_at INTEGER,
    ref_kind TEXT,
    ref_id TEXT,
    host_id TEXT,
    exit_code INTEGER,
    output TEXT,
    error TEXT,
    truncated INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX lane_pilot_schedule_run_schedule ON lane_pilot_schedule_run(schedule_id, scheduled_at)`,
  `CREATE INDEX lane_pilot_schedule_run_status ON lane_pilot_schedule_run(status)`,
];

/**
 * 0.1.338: the `agent` kind. SQLite cannot change a CHECK, so both tables are rebuilt (the run table first: it holds the foreign key, and
 * dropping the parent with `foreign_keys=ON` would cascade-delete its runs). Every row and id is copied. Appended at the very END of
 * `migrations` in src/rooms/migrations.ts (the hub records migrations by index), never into `scheduleMigrations`.
 */
export const scheduleAgentMigrations: string[] = [
  `CREATE TABLE lane_pilot_schedule_next (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK(kind IN ('workflow','errand','script','agent')),
    task_json TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('cron','once')),
    cron TEXT,
    timezone TEXT,
    run_at INTEGER,
    missed_policy TEXT NOT NULL DEFAULT 'run_once' CHECK(missed_policy IN ('run_once','skip','run_all')),
    missed_limit INTEGER NOT NULL DEFAULT 5,
    overlap TEXT NOT NULL DEFAULT 'skip' CHECK(overlap IN ('skip','queue','parallel')),
    timeout_sec INTEGER NOT NULL,
    max_failures INTEGER NOT NULL DEFAULT 3,
    state TEXT NOT NULL CHECK(state IN ('active','paused','done')),
    pause_reason TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    cursor_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `INSERT INTO lane_pilot_schedule_next (id,project_id,name,description,kind,task_json,trigger_type,cron,timezone,run_at,missed_policy,missed_limit,overlap,timeout_sec,max_failures,state,pause_reason,consecutive_failures,cursor_at,created_by,created_at,updated_at)
    SELECT id,project_id,name,description,kind,task_json,trigger_type,cron,timezone,run_at,missed_policy,missed_limit,overlap,timeout_sec,max_failures,state,pause_reason,consecutive_failures,cursor_at,created_by,created_at,updated_at FROM lane_pilot_schedule`,
  `CREATE TABLE lane_pilot_schedule_run_next (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES lane_pilot_schedule_next(id) ON DELETE CASCADE,
    run_key TEXT NOT NULL UNIQUE,
    scheduled_at INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('tick','catchup','manual')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','succeeded','failed','timed_out','skipped','canceled')),
    reason TEXT,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    deadline_at INTEGER,
    ref_kind TEXT,
    ref_id TEXT,
    host_id TEXT,
    exit_code INTEGER,
    output TEXT,
    error TEXT,
    truncated INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT INTO lane_pilot_schedule_run_next (id,schedule_id,run_key,scheduled_at,trigger,status,reason,queued_at,started_at,finished_at,deadline_at,ref_kind,ref_id,host_id,exit_code,output,error,truncated)
    SELECT id,schedule_id,run_key,scheduled_at,trigger,status,reason,queued_at,started_at,finished_at,deadline_at,ref_kind,ref_id,host_id,exit_code,output,error,truncated FROM lane_pilot_schedule_run`,
  `DROP TABLE lane_pilot_schedule_run`,
  `DROP TABLE lane_pilot_schedule`,
  `ALTER TABLE lane_pilot_schedule_next RENAME TO lane_pilot_schedule`,
  `ALTER TABLE lane_pilot_schedule_run_next RENAME TO lane_pilot_schedule_run`,
  `CREATE INDEX lane_pilot_schedule_project ON lane_pilot_schedule(project_id, state)`,
  `CREATE INDEX lane_pilot_schedule_run_schedule ON lane_pilot_schedule_run(schedule_id, scheduled_at)`,
  `CREATE INDEX lane_pilot_schedule_run_status ON lane_pilot_schedule_run(status)`,
];
