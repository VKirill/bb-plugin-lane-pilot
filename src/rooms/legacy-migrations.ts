/**
 * Frozen migration slices of rooms and packages scheduled for deletion in Phase 2.
 * Copied verbatim from their original homes so `src/rooms/migrations.ts` stays append-only
 * and byte-identical with `tests/fixtures/migrations.lock.json` after those rooms are removed.
 * No logic, no room imports.
 */

export const councilMigrations: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lane_pilot_council (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    question TEXT NOT NULL,
    agenda_json TEXT NOT NULL,
    criteria_json TEXT NOT NULL,
    seats_json TEXT NOT NULL,
    state TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 0,
    max_rounds INTEGER NOT NULL,
    decision_json TEXT,
    decision_path TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_council_project ON lane_pilot_council(project_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS lane_pilot_council_message (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    council_id TEXT NOT NULL REFERENCES lane_pilot_council(id) ON DELETE CASCADE,
    seat_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
];

export const councilRunMigrations: readonly string[] = [
  `ALTER TABLE lane_pilot_council ADD COLUMN wf_run_id TEXT`,
];

export const ruleMigrations: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lane_pilot_rule_proposal (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    rule TEXT NOT NULL,
    author TEXT NOT NULL CHECK(author IN ('sweep','pm','owner')),
    state TEXT NOT NULL CHECK(state IN ('proposed','accepted','rejected','revoked')),
    occurrences INTEGER NOT NULL,
    task_count INTEGER NOT NULL,
    examples_json TEXT NOT NULL,
    memory_id TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY(project_id, id)
  ) WITHOUT ROWID`,
  // 0.1.38: proposals written by the analyzer model cite the tasks they come from.
  `CREATE TABLE lane_pilot_rule_proposal_v2 (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    rule TEXT NOT NULL,
    author TEXT NOT NULL CHECK(author IN ('sweep','pm','owner','model')),
    state TEXT NOT NULL CHECK(state IN ('proposed','accepted','rejected','revoked')),
    occurrences INTEGER NOT NULL,
    task_count INTEGER NOT NULL,
    examples_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    memory_id TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY(project_id, id)
  ) WITHOUT ROWID`,
  `INSERT INTO lane_pilot_rule_proposal_v2
    (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at)
    SELECT id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at
    FROM lane_pilot_rule_proposal`,
  `DROP TABLE lane_pilot_rule_proposal`,
  `ALTER TABLE lane_pilot_rule_proposal_v2 RENAME TO lane_pilot_rule_proposal`,
];

export const ruleTrialMigrations: readonly string[] = [
  // 0.1.43: rules adopt themselves. A rule the system adopted is on trial until the tasks it was given to show
  // whether the mistake still recurs; owner decisions are never touched by the trial.
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN decided_by TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN trial_state TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN revision_started_at INTEGER`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN retired_reason TEXT`,
  `CREATE TABLE IF NOT EXISTS lane_pilot_rule_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_rule_event_project ON lane_pilot_rule_event(project_id, at DESC)`,
  // A rule belongs to the section where its mistakes happened (outermost first, [] = the whole project).
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN scope_json TEXT NOT NULL DEFAULT '[]'`,
];

export const ruleAudienceMigrations: readonly string[] = [
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN audience TEXT NOT NULL DEFAULT 'writer'`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0`,
];

export const ruleFormMigrations: readonly string[] = [
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN form TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN cue TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN confidence TEXT`,
];

export const ruleMechanismMigrations: readonly string[] = [
  // Why the rule has its form, who set it (heuristic | jev | owner | reflection), and the mechanism (commit / test / lint code) that enforces it.
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN form_reason TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN form_by TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN mechanized_by TEXT`,
  `ALTER TABLE lane_pilot_rule_proposal ADD COLUMN mechanized_at INTEGER`,
  // A mechanism proposal generated for a rule of form check that keeps recurring: the task contract waits here for the night loop or
  // self-repair; nothing is dispatched or merged by the generator (rules are night_proposes).
  `CREATE TABLE IF NOT EXISTS lane_pilot_rule_promotion (
    rule_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    mechanism TEXT NOT NULL,
    state TEXT NOT NULL,
    task_json TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, rule_id)
  ) WITHOUT ROWID`,
];

export const triageMigrations: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lane_pilot_failure_triage (
    project_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    reason_sha256 TEXT NOT NULL,
    reason TEXT NOT NULL,
    origin TEXT,
    origin_confidence REAL,
    category TEXT,
    category_confidence REAL,
    same_rule_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('ok','error')),
    detail TEXT,
    failed_at INTEGER NOT NULL,
    triaged_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, attempt_id)
  ) WITHOUT ROWID`,
];

export const anamnesisOwnerMigrations: string[] = [
  `CREATE TABLE lane_pilot_owner_records(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, statement TEXT NOT NULL DEFAULT '', attributes TEXT NOT NULL DEFAULT '{}',
    sensitivity TEXT NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL, first_seen INTEGER, last_seen INTEGER,
    manual_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, authored_by TEXT)`,
  `CREATE INDEX lane_pilot_owner_records_kind ON lane_pilot_owner_records(kind, status)`,
  `CREATE TABLE lane_pilot_owner_evidence(
    record_id TEXT NOT NULL REFERENCES lane_pilot_owner_records(id) ON DELETE CASCADE, source TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, quote TEXT,
    PRIMARY KEY(record_id, source, ref))`,
  `CREATE INDEX lane_pilot_owner_evidence_source ON lane_pilot_owner_evidence(source)`,
  `CREATE TABLE lane_pilot_owner_history(
    id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
    changes TEXT NOT NULL DEFAULT '{}')`,
  `CREATE INDEX lane_pilot_owner_history_record ON lane_pilot_owner_history(record_id, id)`,
  `CREATE TABLE lane_pilot_owner_tombstones(id TEXT PRIMARY KEY, cutoff INTEGER NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_checkpoints(source TEXT PRIMARY KEY, at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_sources(source TEXT PRIMARY KEY, enabled INTEGER NOT NULL, changed_at INTEGER NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_loads(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, mode TEXT NOT NULL, report TEXT NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_notes_files(file TEXT PRIMARY KEY, hash TEXT NOT NULL, written_at INTEGER NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_notes_lines(record_id TEXT PRIMARY KEY, file TEXT NOT NULL, line TEXT NOT NULL)`,
];

export const learningMigrations: string[] = [
  `CREATE TABLE lane_pilot_learning_obs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    judged_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    chars INTEGER NOT NULL,
    excerpt TEXT,
    state TEXT NOT NULL CHECK(state IN ('skipped','observed','candidate','extracted','ignored')),
    skip_reason TEXT,
    sensitive INTEGER NOT NULL DEFAULT 0,
    jev_status TEXT,
    receipt_id INTEGER,
    kind TEXT,
    kind_p REAL,
    learn_p REAL,
    durable REAL,
    scope TEXT,
    frustration REAL,
    deadline REAL,
    route TEXT,
    second_status TEXT,
    second_kind TEXT,
    second_learn_p REAL,
    second_durable REAL,
    second_route TEXT,
    second_ms INTEGER,
    second_tokens INTEGER,
    final_route TEXT,
    body TEXT,
    prev TEXT,
    review TEXT,
    reviewed_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_learning_obs_state ON lane_pilot_learning_obs(state, at)`,
  `CREATE INDEX lane_pilot_learning_obs_project ON lane_pilot_learning_obs(project_id, at)`,
  `CREATE INDEX lane_pilot_learning_obs_judged ON lane_pilot_learning_obs(judged_at)`,
  `CREATE TABLE lane_pilot_learning_item (
    id TEXT PRIMARY KEY,
    obs_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('rule','preference','decision','deadline','fact')),
    text TEXT NOT NULL,
    audience TEXT,
    reach TEXT NOT NULL,
    due_at INTEGER,
    state TEXT NOT NULL CHECK(state IN ('adopted','proposed','pending_owner','accepted','duplicate','rejected','dropped','noted')),
    target TEXT,
    evidence TEXT NOT NULL,
    duplicate_of TEXT,
    confirmations INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    announced_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_learning_item_project ON lane_pilot_learning_item(project_id, created_at)`,
  `CREATE INDEX lane_pilot_learning_item_state ON lane_pilot_learning_item(state, announced_at)`,
  `CREATE TABLE lane_pilot_learning_signal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    project_id TEXT,
    ref TEXT NOT NULL,
    p REAL,
    detail TEXT,
    state TEXT NOT NULL DEFAULT 'observed',
    at INTEGER NOT NULL,
    UNIQUE(kind, ref)
  )`,
];

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

export const worldMigrations: string[] = [
  `CREATE TABLE lane_pilot_world (
    id TEXT PRIMARY KEY,
    schema INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    tick_at INTEGER NOT NULL,
    saved_at INTEGER NOT NULL
  )`,
];

export const harnessMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_harness (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    area TEXT NOT NULL DEFAULT '',
    writer_key TEXT NOT NULL DEFAULT '*',
    version INTEGER NOT NULL,
    parent_id TEXT,
    tree_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('base','candidate','trial','adopted','retired')),
    created_by TEXT NOT NULL,
    notes TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    trial_started_at INTEGER,
    decided_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_harness_key ON lane_pilot_harness(project_id, area, writer_key, state)`,
  `CREATE TABLE lane_pilot_harness_experience (
    harness_id TEXT PRIMARY KEY,
    edits_md TEXT NOT NULL,
    cue TEXT,
    lesson TEXT,
    evidence TEXT,
    confidence TEXT,
    rule_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN harness_tree_id TEXT`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN harness_arm TEXT`,
  `CREATE INDEX lane_pilot_attempt_harness ON lane_pilot_attempt(harness_tree_id, created_at)`,
];

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

export const phaseMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_phase (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    pm_thread_id TEXT NOT NULL,
    run_id TEXT,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    stage TEXT NOT NULL CHECK(stage IN ('discussion','planning','design','execution','verification','acceptance','lessons','closed')),
    state TEXT NOT NULL CHECK(state IN ('active','pause_requested','paused','stopped','closed')),
    record_json TEXT NOT NULL DEFAULT '{}',
    edition INTEGER NOT NULL DEFAULT 1,
    poked_key TEXT,
    poked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_phase_live ON lane_pilot_phase(state, updated_at)`,
  `CREATE INDEX lane_pilot_phase_pm ON lane_pilot_phase(pm_thread_id, created_at)`,
  `CREATE TABLE lane_pilot_phase_part (
    phase_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    section TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY(phase_id, seq)
  )`,
  `CREATE TRIGGER lane_pilot_phase_part_no_update BEFORE UPDATE ON lane_pilot_phase_part BEGIN SELECT RAISE(ABORT, 'phase book parts are append-only'); END`,
  `CREATE TRIGGER lane_pilot_phase_part_no_delete BEFORE DELETE ON lane_pilot_phase_part BEGIN SELECT RAISE(ABORT, 'phase book parts are append-only'); END`,
];

export const capabilityMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_capability (
    provider_id TEXT NOT NULL,
    version TEXT NOT NULL,
    capability TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('supported','not_supported')),
    model TEXT,
    detail TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (provider_id, version, capability)
  )`,
];

export const hypothesisMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_hypothesis (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('proposed','benching','adopted','held','rejected')),
    set_version TEXT,
    verdict_json TEXT,
    previous_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

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

export const passportMigrations = [
  `CREATE TABLE IF NOT EXISTS lane_pilot_passport (
    project_id TEXT NOT NULL,
    scope_key TEXT NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL DEFAULT 1,
    passport_json TEXT NOT NULL,
    passport_md TEXT NOT NULL,
    completeness_score INTEGER NOT NULL DEFAULT 0,
    confirmed_count INTEGER NOT NULL DEFAULT 0,
    hypothesis_count INTEGER NOT NULL DEFAULT 0,
    unknown_count INTEGER NOT NULL DEFAULT 0,
    taboo_count INTEGER NOT NULL DEFAULT 0,
    primary_locale TEXT NOT NULL DEFAULT '',
    markets_json TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    sha256 TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL DEFAULT 'system',
    PRIMARY KEY (project_id, scope_key)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS lane_pilot_passport_verbatim (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    scope_key TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    thread_id TEXT,
    run_id TEXT,
    question_asked TEXT NOT NULL DEFAULT '',
    owner_verbatim TEXT NOT NULL,
    extracted_paths_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lp_passport_verbatim_proj
    ON lane_pilot_passport_verbatim (project_id, scope_key, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS lane_pilot_passport_pending (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    scope_key TEXT NOT NULL DEFAULT '',
    field_path TEXT NOT NULL,
    old_claim_json TEXT NOT NULL,
    proposed_claim_json TEXT NOT NULL,
    verbatim_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','rejected')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lp_passport_pending_proj
    ON lane_pilot_passport_pending (project_id, scope_key, state, created_at DESC)`,
] as const;
