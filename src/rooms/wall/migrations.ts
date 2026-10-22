/**
 * The wall journal and the night loop. Spread at the END of `migrations` in storage/database.ts; never renumbered.
 *
 * - lane_pilot_wall_entry: the journal. One row per night and (class, LP version, project): how many failures, in how many tasks, which
 *   sources saw it (attempt / triage / gate event / stage receipt / plugin log), the gates and the stages it broke in, a few sample attempts.
 * - lane_pilot_wall_class: one row per class: its recurrence among the last 10 / 100 / 500 finished attempts (the 3/10, 5/100, 6/500
 *   ladder), open or closed, and where the class stands on the wall ladder.
 * - lane_pilot_wall_repair: one night repair of a class (a round): queued for the self-repair tick, merged, deployed, accepted or rolled back.
 * - lane_pilot_wall_night: what a night did and what it spent against its cap.
 * - lane_pilot_wall: the wall ladder of a repeating failure, for a class (kind class) or a task family (kind task): moves, the hunt, the
 *   backlog entry. Its backlog rows are also in the register of deferrals (kind `wall`, needs_owner_term).
 * - lane_pilot_wall_rerun: a re-run of a failed attempt from its earliest affected stage after the head changed: the stages reused by input
 *   hash and the ones that went stale.
 * The deferral register learns the kind `wall` (the table is rebuilt: a CHECK cannot be altered).
 */
export const wallMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_wall_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    night TEXT NOT NULL,
    class_key TEXT NOT NULL,
    failure_class TEXT NOT NULL,
    reason_norm TEXT NOT NULL,
    origin TEXT NOT NULL,
    lp_version TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    tasks INTEGER NOT NULL,
    sources_json TEXT NOT NULL DEFAULT '{}',
    gates_json TEXT NOT NULL DEFAULT '{}',
    stages_json TEXT NOT NULL DEFAULT '{}',
    samples_json TEXT NOT NULL DEFAULT '[]',
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    UNIQUE(night, class_key, lp_version, project_id)
  )`,
  `CREATE INDEX lane_pilot_wall_entry_class ON lane_pilot_wall_entry(class_key, night)`,
  `CREATE TABLE lane_pilot_wall_class (
    class_key TEXT PRIMARY KEY,
    failure_class TEXT NOT NULL,
    reason_norm TEXT NOT NULL,
    origin TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    total INTEGER NOT NULL,
    c10 INTEGER NOT NULL, c100 INTEGER NOT NULL, c500 INTEGER NOT NULL,
    w10 INTEGER NOT NULL, w100 INTEGER NOT NULL, w500 INTEGER NOT NULL,
    rung INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','closed')),
    recur7 INTEGER NOT NULL,
    recur1 INTEGER NOT NULL,
    failed_moves INTEGER NOT NULL DEFAULT 0,
    hunt_state TEXT NOT NULL DEFAULT 'none',
    after_hunt_failed INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'moves',
    closed_at INTEGER,
    fixed_in TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE lane_pilot_wall_repair (
    id TEXT PRIMARY KEY,
    class_key TEXT NOT NULL,
    night TEXT NOT NULL,
    round INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('engineer','informed')),
    state TEXT NOT NULL,
    signature TEXT NOT NULL,
    thread_id TEXT,
    brief_json TEXT NOT NULL,
    version_before TEXT NOT NULL,
    shipped_version TEXT,
    merged_commit TEXT,
    branch TEXT,
    tokens_est INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER,
    verdict TEXT,
    policy_json TEXT,
    acceptance_json TEXT,
    outcome TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_wall_repair_class ON lane_pilot_wall_repair(class_key, created_at)`,
  `CREATE INDEX lane_pilot_wall_repair_state ON lane_pilot_wall_repair(state)`,
  `CREATE TABLE lane_pilot_wall_night (
    night TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    dry_run INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NOT NULL,
    spend_tokens INTEGER NOT NULL DEFAULT 0,
    cap_tokens INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE lane_pilot_wall (
    wall_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('class','task')),
    subject TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK(state IN ('stopped','hunting','hunted','backlog','closed')),
    moves INTEGER NOT NULL DEFAULT 0,
    hunt_state TEXT NOT NULL DEFAULT 'none',
    pack_json TEXT,
    findings_json TEXT,
    message_sent_at INTEGER,
    deferral_id TEXT,
    analysis_json TEXT,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    closed_by TEXT
  )`,
  `CREATE INDEX lane_pilot_wall_state ON lane_pilot_wall(state)`,
  `CREATE TABLE lane_pilot_wall_rerun (
    id TEXT PRIMARY KEY,
    class_key TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('sandbox','bench','real')),
    from_stage TEXT,
    reused_json TEXT NOT NULL DEFAULT '[]',
    stale_json TEXT NOT NULL DEFAULT '[]',
    head_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL CHECK(state IN ('planned','dispatched','listed','skipped')),
    note TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(class_key, attempt_id, head_json)
  )`,
];

/** The register of deferrals learns the kind `wall`: a repeating failure the ladder ended in the backlog, waiting for a person's term. */
export const wallDeferralKindMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_deferral_next (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    what TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('drill_scenario','skipped_test','gate','plan_decision','memory_conflict','wall')),
    area TEXT NOT NULL DEFAULT '',
    due_at INTEGER,
    due_source TEXT,
    owner_ref TEXT,
    owner_quote TEXT,
    state TEXT NOT NULL CHECK(state IN ('open','overdue','closed','needs_owner_term')),
    history_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'cli',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    closed_by TEXT
  )`,
  `INSERT INTO lane_pilot_deferral_next SELECT id,project_id,what,kind,area,due_at,due_source,owner_ref,owner_quote,state,history_json,source,created_at,updated_at,closed_at,closed_by FROM lane_pilot_deferral`,
  `DROP TABLE lane_pilot_deferral`,
  `ALTER TABLE lane_pilot_deferral_next RENAME TO lane_pilot_deferral`,
  `CREATE INDEX lane_pilot_deferral_state ON lane_pilot_deferral(state, due_at)`,
];
