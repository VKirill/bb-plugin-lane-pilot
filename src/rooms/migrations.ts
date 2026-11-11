// The composed Lane Pilot migration list, in apply order. Order is locked: tests/fixtures/migrations.lock.json hashes every statement.
// Owner rooms export their slices; storage applies whatever list it is handed (openDatabase default lives above storage).
import { handoffMigrations } from "@lane-pilot/handoff";
import { councilMigrations, councilRunMigrations } from "@lane-pilot/council";
import { ruleAudienceMigrations, ruleFormMigrations, ruleMechanismMigrations, ruleMigrations, ruleTrialMigrations, triageMigrations } from "@lane-pilot/run-insights";
import { workflowMigrations } from "@lane-pilot/workflow-engine";
import { workflowNotVerifiedMigrations, workflowOpsMigrations } from "@lane-pilot/workflow-engine";
import { draftMigrations } from "@lane-pilot/workflow-engine";
import { jevMigrations } from "@lane-pilot/jev";
import { anamnesisOwnerMigrations } from "./anamnesis/server";
import { learningMigrations } from "./learning/migrations";
import { pmReplayMigrations } from "./pm-replay";
import { scheduleAgentMigrations, scheduleMigrations } from "./schedule";
import { worldMigrations } from "./world";
import { harnessMigrations } from "./harness";
import { deferralKindMigrations, deferralMigrations, wallDeferralKindMigrations } from "./deferral";
import { rollbackMigrations } from "./rollback";
import { benchMigrations } from "./bench";
import { ownerWaitingMigrations } from "./owner-waiting";
import { leadMigrations } from "./lead";
import { baselineMigrations } from "./baseline";
import { stageReturnMigrations } from "./stage-return";
import { runGoalCoverageMigrations, runGoalMigrations } from "./run-goal";
import { phaseMigrations } from "./phase";
import { capabilityMigrations } from "./capability";
import { outageMigrations } from "./outage";
import { backlogMigrations } from "./backlog";
import { memoryTierMigrations } from "./memory-tiers";
import { hypothesisMigrations } from "./hypotheses";
import { wallMigrations } from "./wall";
import { checkerMigrations } from "./checkers";
import { memoryConflictMigrations } from "@lane-pilot/memory-core";
export const migrations = [
  `CREATE TABLE lane_pilot_project_settings (
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, binding_id, key)
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_run (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    pm_thread_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','running','accepted','blocked')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE lane_pilot_attempt (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    thread_id TEXT,
    state TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(run_id, task_id, id),
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run(id)
  )`,
  `CREATE TABLE lane_pilot_task (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('bb','cli')),
    contract_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run(id)
  )`,
  `CREATE TABLE lane_pilot_activation (
    project_id TEXT PRIMARY KEY,
    pm_thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    claimed_at INTEGER NOT NULL
  )`,
  `ALTER TABLE lane_pilot_run ADD COLUMN kind TEXT NOT NULL DEFAULT 'bb'`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN dirt_before_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE lane_pilot_run ADD COLUMN closed_at INTEGER`,
  `CREATE TABLE lane_pilot_run_next (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    pm_thread_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','running','accepted','blocked','closed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'bb',
    closed_at INTEGER,
    closed_by TEXT
  )`,
  `INSERT INTO lane_pilot_run_next (id,project_id,pm_thread_id,state,created_at,updated_at,kind,closed_at,closed_by)
    SELECT id,project_id,pm_thread_id,
      CASE WHEN closed_at IS NULL THEN state ELSE 'closed' END,
      created_at,updated_at,kind,closed_at,
      CASE WHEN closed_at IS NULL THEN NULL ELSE 'legacy' END
    FROM lane_pilot_run`,
  `CREATE TABLE lane_pilot_task_next (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('bb','cli')),
    contract_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run_next(id)
  )`,
  `INSERT INTO lane_pilot_task_next (id,run_id,kind,contract_json,created_at)
    SELECT id,run_id,kind,contract_json,created_at FROM lane_pilot_task`,
  `CREATE TABLE lane_pilot_attempt_next (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    thread_id TEXT,
    state TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    attempt_no INTEGER NOT NULL DEFAULT 1,
    dirt_before_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(run_id,task_id,id),
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run_next(id)
  )`,
  `INSERT INTO lane_pilot_attempt_next (id,run_id,task_id,thread_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json)
    SELECT id,run_id,task_id,thread_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json FROM lane_pilot_attempt`,
  `DROP TABLE lane_pilot_attempt`,
  `DROP TABLE lane_pilot_task`,
  `DROP TABLE lane_pilot_run`,
  `ALTER TABLE lane_pilot_run_next RENAME TO lane_pilot_run`,
  `ALTER TABLE lane_pilot_task_next RENAME TO lane_pilot_task`,
  `ALTER TABLE lane_pilot_attempt_next RENAME TO lane_pilot_attempt`,
  `ALTER TABLE lane_pilot_run ADD COLUMN writer_workspace_path TEXT`,
  `CREATE TABLE lane_pilot_attempt_reasoning (
    attempt_id TEXT PRIMARY KEY,
    trace_json TEXT NOT NULL,
    FOREIGN KEY(attempt_id) REFERENCES lane_pilot_attempt(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_task_plan (
    task_id TEXT PRIMARY KEY,
    plan TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES lane_pilot_task(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_stage_receipt (
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    contract_version INTEGER NOT NULL CHECK(contract_version = 1),
    state TEXT NOT NULL CHECK(state IN ('pending','running','passed','failed','blocked','skipped','canceled')),
    input_sha256 TEXT NOT NULL,
    output_sha256 TEXT,
    attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 2),
    provider_id TEXT,
    model TEXT,
    thread_id TEXT,
    result_json TEXT,
    reason TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, task_id, stage_id),
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run(id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES lane_pilot_task(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_memory (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('core','note')),
    audience TEXT NOT NULL CHECK(audience IN ('owner','subagent','export')),
    content TEXT NOT NULL,
    concepts_json TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(project_id,id)
  )`,
  `CREATE VIRTUAL TABLE lane_pilot_memory_fts USING fts5(id UNINDEXED, project_id UNINDEXED, content, concepts)`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN workspace_path TEXT`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN environment_id TEXT`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN workspace_decision_json TEXT`,
  `CREATE TABLE lane_pilot_stage_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','running','passed','failed','blocked','skipped','canceled')),
    input_sha256 TEXT NOT NULL,
    output_sha256 TEXT,
    attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 2),
    occurred_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_stage_event_project_time ON lane_pilot_stage_event(project_id, occurred_at DESC)`,
  `CREATE TRIGGER lane_pilot_stage_event_no_update BEFORE UPDATE ON lane_pilot_stage_event BEGIN SELECT RAISE(ABORT, 'stage events are append-only'); END`,
  `CREATE TRIGGER lane_pilot_stage_event_no_delete BEFORE DELETE ON lane_pilot_stage_event BEGIN SELECT RAISE(ABORT, 'stage events are append-only'); END`,
  `CREATE TABLE lane_pilot_gate_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    gate TEXT NOT NULL CHECK(gate IN ('owns-paths','validate','accept','verification')),
    status TEXT NOT NULL CHECK(status IN ('passed','rejected','failed','skipped')),
    input_sha256 TEXT NOT NULL,
    output_sha256 TEXT,
    attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 2),
    occurred_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_gate_event_project_time ON lane_pilot_gate_event(project_id, occurred_at DESC)`,
  `CREATE TRIGGER lane_pilot_gate_event_no_update BEFORE UPDATE ON lane_pilot_gate_event BEGIN SELECT RAISE(ABORT, 'gate events are append-only'); END`,
  `CREATE TRIGGER lane_pilot_gate_event_no_delete BEFORE DELETE ON lane_pilot_gate_event BEGIN SELECT RAISE(ABORT, 'gate events are append-only'); END`,
  `CREATE TABLE lane_pilot_task_git_base (
    task_id TEXT PRIMARY KEY REFERENCES lane_pilot_task(id),
    base_ref TEXT,
    base_sha TEXT,
    initial_head_sha TEXT NOT NULL,
    branch TEXT NOT NULL,
    compare_committed INTEGER NOT NULL CHECK(compare_committed IN (0,1)),
    captured_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `ALTER TABLE lane_pilot_run ADD COLUMN run_policy_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"pools":{"provider":5,"verification":2}}'`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN personal_bot TEXT NOT NULL DEFAULT ''`,
  `CREATE INDEX lane_pilot_memory_project_bot_audience ON lane_pilot_memory(project_id,personal_bot,audience)`,
  `ALTER TABLE lane_pilot_run ADD COLUMN writer_environment_id TEXT`,
  `ALTER TABLE lane_pilot_run ADD COLUMN run_gate TEXT NOT NULL DEFAULT 'none' CHECK(run_gate IN ('none','pre-merge'))`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN holder_thread_id TEXT`,
  `ALTER TABLE lane_pilot_run ADD COLUMN writer_host_id TEXT`,
  `ALTER TABLE lane_pilot_run ADD COLUMN helper_policy_json TEXT`,
  `CREATE TABLE lane_pilot_setting_generation (
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (project_id,binding_id,key)
  ) WITHOUT ROWID`,
  `INSERT INTO lane_pilot_setting_generation(project_id,binding_id,key,version)
    SELECT project_id,binding_id,key,version FROM lane_pilot_project_settings`,
  // Settings scopes of a native run, outermost first: the project is implicit, then section:<id>...
  `ALTER TABLE lane_pilot_run ADD COLUMN settings_scopes_json TEXT`,
  ...handoffMigrations,
  ...councilMigrations,
  ...ruleMigrations,
  ...triageMigrations,
  ...ruleTrialMigrations,
  // 0.1.91: failures are no longer memory (82% of the hub corpus were raw «attempt failed» logs, 2026-10-03 audit);
  // the triage table keeps them and rules carry what repeats. Also drop index rows whose record is gone.
  `DELETE FROM lane_pilot_memory WHERE concepts_json LIKE '%"lesson"%'`,
  `DELETE FROM lane_pilot_memory_fts WHERE id NOT IN (SELECT id FROM lane_pilot_memory)`,
  // 0.1.92: every attempt state change, including refused ones, so a skipped or overwritten state can be seen.
  `CREATE TABLE IF NOT EXISTS lane_pilot_attempt_transition (
    attempt_id TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, reason TEXT,
    refused INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_attempt_transition_attempt ON lane_pilot_attempt_transition(attempt_id, at)`,
  ...ruleAudienceMigrations,
  `CREATE TABLE lane_pilot_token_daily (
    day TEXT NOT NULL,
    project_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, project_id, provider_id, model)
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_token_cursor (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_json TEXT NOT NULL DEFAULT '{}',
    total_json TEXT NOT NULL DEFAULT '{}',
    last_model TEXT NOT NULL DEFAULT '',
    last_provider TEXT NOT NULL DEFAULT '',
    last_turn_id TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  )`,
  `ALTER TABLE lane_pilot_token_daily ADD COLUMN uncached_tokens INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE lane_pilot_token_daily ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE lane_pilot_token_daily ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0`,
  // 0.1.177: the Lane Pilot build that created the attempt; null on attempts made before. A parked task restarts when the
  // running build differs from the one its failed attempt ran under, not from the build that happened to park it.
  `ALTER TABLE lane_pilot_attempt ADD COLUMN harness_version TEXT`,
  // G9: how long each verification command ran, per project and command, so a slow check gets a timeout from its own history.
  `CREATE TABLE lane_pilot_check_duration (
    project_id TEXT NOT NULL, command_key TEXT NOT NULL, duration_ms INTEGER NOT NULL, exit_code INTEGER NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX lane_pilot_check_duration_key ON lane_pilot_check_duration(project_id, command_key, at)`,
  // G9: what the run is for, in one sentence from the PM's first dispatch (the chat holds it otherwise, and a closed chat loses it).
  `ALTER TABLE lane_pilot_run ADD COLUMN objective TEXT`,
  // K8 knowledge: a record can be replaced, expire, be evicted for budget (kept, hidden), come from a session or a file whose
  // state it follows, and carry how often it was mixed into a brief and how often that attempt was accepted.
  `ALTER TABLE lane_pilot_memory ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','expired'))`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN superseded_by TEXT`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN valid_until INTEGER`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN last_used_at INTEGER`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN accepted_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN trust TEXT NOT NULL DEFAULT 'confirmed' CHECK(trust IN ('confirmed','observed'))`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN origin TEXT NOT NULL DEFAULT 'maintainer'`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN source_file_id TEXT`,
  `CREATE INDEX lane_pilot_memory_scope_status ON lane_pilot_memory(project_id,personal_bot,audience,status)`,
  // W2: the workflow engine's journal (run, step, join arrival, effect, append-only events).
  ...workflowMigrations,
  // Workflow architect: drafts of workflows being built, with their version history.
  ...draftMigrations,
  // Receipts of workflow test runs (W7), goals of a run (K7), the automations of schedule triggers (W9).
  ...workflowOpsMigrations,
  // Jev judgments: one receipt per judgment asked (src/jev).
  ...jevMigrations,
  // Audit 2026-10-08 S1: who was given which Env Catalog name, for which task and check, when and where. Never the value.
  `CREATE TABLE lane_pilot_secret_issuance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT,
    task_id TEXT,
    consumer TEXT NOT NULL,
    thread_id TEXT,
    check_command TEXT,
    secret_name TEXT NOT NULL,
    host_id TEXT,
    network TEXT
  )`,
  `CREATE INDEX lane_pilot_secret_issuance_project ON lane_pilot_secret_issuance(project_id, at)`,
  // Schedule board: scheduled tasks and their runs (src/schedule). Always last.
  ...scheduleMigrations,
  // Learning from the owner's messages (src/learning): observations, learned items, other signals. Append only.
  ...learningMigrations,
  // The Pixel World: the one saved world (src/rooms/world).
  ...worldMigrations,
  // 0.1.232: the task results Lane Pilot told a PM (src/rooms/relay), one row per reported attempt transition.
  `CREATE TABLE lane_pilot_pm_notice (
    transition_id INTEGER PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    pm_thread_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  )`,
  // 0.1.247: a lesson's form (always | skill | check | hook | memory), its cue and confidence (the Harness² port).
  ...ruleFormMigrations,
  // 0.1.247: the writer harness that learns (src/rooms/harness): trees, trials, experience; the tree and arm on each attempt.
  ...harnessMigrations,
  // 0.1.261: OpenCode v1 (`acp-opencode`) is gone; saved provider choices move to OpenCode v2 (`opencode2`). Past results keep theirs.
  `UPDATE lane_pilot_project_settings SET value=replace(value,'"acp-opencode"','"opencode2"'), version=version+1,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
    WHERE value LIKE '%"acp-opencode"%' AND key NOT LIKE '%lastResult%'`,
  // The register of deferrals with the owner's terms (src/rooms/deferral).
  ...deferralMigrations,
  // SMA block 4: the memory probe (src/rooms/memory-probe/server/memory-probe.ts): one row per memory delivery path per run: did the token
  // planted through the write door reach what the agent of that path receives, and did an unrelated query pull nothing of ours.
  `CREATE TABLE lane_pilot_memory_probe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    token TEXT NOT NULL,
    path TEXT NOT NULL,
    found INTEGER NOT NULL,
    negative_ok INTEGER,
    latency_ms INTEGER NOT NULL,
    lp_version TEXT NOT NULL,
    detail TEXT
  )`,
  `CREATE INDEX lane_pilot_memory_probe_at ON lane_pilot_memory_probe(at)`,
  // SMA wall 4: the base, the merge and the changed files of every attempt, and the receipts of reverify / revert (src/rooms/rollback).
  ...rollbackMigrations,
  // SMA block 6 (P2-6): why a rule has its form, the mechanism that enforces it, and the mechanism proposals waiting for the night loop (src/rooms/rule-forms).
  ...ruleMechanismMigrations,
  // SMA block 4, P2-7: two memory notes that disagree are held until a person settles them (packages/memory-core/src/conflict-store.ts), and the
  // deferral register learns the kind `memory_conflict` (the table is rebuilt: a CHECK cannot be altered).
  ...memoryConflictMigrations,
  ...deferralKindMigrations,
  // LP-Bench (src/rooms/bench): the fixed task set, its runs and comparisons.
  ...benchMigrations,
  // SMA D0-3: «Waiting for the owner» (src/rooms/owner-waiting): the inbox of the night loop, what already went to Telegram, the push settings.
  ...ownerWaitingMigrations,
  // The baseline before a writer, the regression pass after acceptance and their findings (src/rooms/baseline).
  ...baselineMigrations,
  // The wall journal and the night loop (src/rooms/wall); the deferral register learns the kind `wall`.
  ...wallMigrations,
  ...wallDeferralKindMigrations,
  // Checking the checkers (src/rooms/checkers): planted-defect runs and the hit or miss of each checker.
  ...checkerMigrations,
  // Return to an earlier stage with added context (src/rooms/stage-return).
  ...stageReturnMigrations,
  // The run-goal verdict: every accepted task's checks together on the final main (src/rooms/run-goal).
  ...runGoalMigrations,
  // The capability table: a receipt per provider, adapter version and capability (src/rooms/capability).
  ...capabilityMigrations,
  // Gaps in the plugin's heartbeat: when Lane Pilot was not running (src/rooms/outage).
  ...outageMigrations,
  // Todos issued from a project's backlog to its PM (src/rooms/backlog).
  ...backlogMigrations,
  // The cold tier's promotions and the PM's memory misses (src/rooms/memory-tiers).
  ...memoryTierMigrations,
  // Ideas checked on the bench set (src/rooms/hypotheses).
  ...hypothesisMigrations,
  // The thread's info panel (src/rooms/runs/server/thread-live.ts) finds a chat's runs and a thread's task by thread id.
  `CREATE INDEX IF NOT EXISTS lane_pilot_run_pm_thread ON lane_pilot_run(pm_thread_id)`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_attempt_thread ON lane_pilot_attempt(thread_id)`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_stage_receipt_thread ON lane_pilot_stage_receipt(thread_id)`,
  // Memory of one section of a shared project (Мои проекты: several games and FeedGen in one BB project) stays with that section
  // (packages/memory-core: scope_json, the sections outermost first; '[]' the whole project).
  `ALTER TABLE lane_pilot_memory ADD COLUMN scope_json TEXT NOT NULL DEFAULT '[]'`,
  // Phases on rails and their append-only book (src/rooms/phase, SMA map: Phase graph).
  ...phaseMigrations,
  // The task graph's rails (src/rooms/tasks/rails.ts): where a row was born, a hold until a date (2999 = no date), the words it was closed with.
  `ALTER TABLE lane_pilot_task ADD COLUMN birth TEXT NOT NULL DEFAULT 'pm'`,
  `ALTER TABLE lane_pilot_task ADD COLUMN held_until INTEGER`,
  `ALTER TABLE lane_pilot_task ADD COLUMN closed_words TEXT`,
  // Schedule board: the `agent` kind (the kind CHECK of lane_pilot_schedule is rebuilt, rows and ids kept; src/rooms/schedule/store.ts). Append only.
  ...scheduleAgentMigrations,
  // The council is a graph (workflows/council.json): the run that drives a session (src/rooms/council). Append only.
  ...councilRunMigrations,
  // Run-goal coverage: passed only when every required check ran (src/rooms/run-goal). Append only; rebuilds the CHECK.
  ...runGoalCoverageMigrations,
  // Why an active note left the corpus. Cold reads return candidates; they do not promote, so the reason stays the one the write door recorded.
  `ALTER TABLE lane_pilot_memory ADD COLUMN expired_reason TEXT`,
  // A user workflow run not verified against its goals is `not_verified` (the wf_run CHECK is rebuilt; packages/workflow-engine/src/ops-store.ts). Append only.
  ...workflowNotVerifiedMigrations,
  // Hash of the files a note named when it was written (packages/memory-core/src/fingerprint.ts). Append only.
  `ALTER TABLE lane_pilot_memory ADD COLUMN file_fingerprint TEXT`,
  // The page a thread reconcile had reached. A reload continues from it instead of scanning from the first page again.
  `CREATE TABLE lane_pilot_reconcile_cursor (scan_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, page INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  // When the fact itself began to hold (Graphiti-style validity window, arXiv X-3); NULL = since it was written. Append only.
  `ALTER TABLE lane_pilot_memory ADD COLUMN valid_from INTEGER`,
  // The task that produced the record: an audit trail from a stored note back to its run (arXiv #10). Append only.
  `ALTER TABLE lane_pilot_memory ADD COLUMN origin_task_id TEXT`,
  // Verifier signals on the row: each source that vouched for the fact (arXiv #21 MemGuard). Append only.
  `ALTER TABLE lane_pilot_memory ADD COLUMN verification_json TEXT`,
  // Bench task validator (src/rooms/bench/validator.ts). Null on a code task. `artifact` checks that the result exists and is not empty.
  `ALTER TABLE lane_pilot_bench_task ADD COLUMN validator TEXT`,
  // Critic mixes (packages/memory-core/src/lifecycle.ts). Not a writer use, so usefulness ignores it. Append only.
  `ALTER TABLE lane_pilot_memory ADD COLUMN critic_count INTEGER NOT NULL DEFAULT 0`,
  // One row per retrieval that reached an agent. Ids and token count only; no note text (F07-1). Append only.
  `CREATE TABLE IF NOT EXISTS lane_pilot_memory_receipt (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, returned_ids TEXT NOT NULL, packed_ids TEXT NOT NULL, tokens INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  // Jev receipt: the state's field names and serialized sizes (names+sizes, never content; audit C-requirement). Append only.
  `ALTER TABLE lane_pilot_jev_receipt ADD COLUMN fields_json TEXT`,
  // Bench task stability mark (C5): regression = accepted on every repeat, flaky = mixed. Flaky tasks stay out of verdicts. Append only.
  `CREATE TABLE lane_pilot_bench_mark (set_id TEXT NOT NULL, task_id TEXT NOT NULL, mark TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', marked_at INTEGER NOT NULL, PRIMARY KEY(set_id, task_id))`,
  // J-002: one append-only fact per accepted task. The wave-idle memory maintainer summarizes pending facts in one batch
  // (summarized_at) instead of running a writer per task. Rows are never updated except the summary stamp.
  `CREATE TABLE lane_pilot_accepted_fact (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT PRIMARY KEY,
    fact_json TEXT NOT NULL,
    summarized_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  // Diff-hidden audit (Mirage / ToCS pattern): check sensitivity and blind passes when diff is hidden. Append only.
  `CREATE TABLE IF NOT EXISTS lane_pilot_diff_hidden_audit (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, checker TEXT NOT NULL, with_diff_json TEXT NOT NULL, diff_hidden_json TEXT NOT NULL, phantom INTEGER NOT NULL, blind_pass INTEGER NOT NULL, diff_sensitive INTEGER NOT NULL, recorded_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_diff_hidden_audit_recorded ON lane_pilot_diff_hidden_audit(recorded_at)`,
  // Monthly model routing rebench (Epoch / TokenRouter pattern): evaluate Jev model choices vs outcomes. Append only.
  `CREATE TABLE IF NOT EXISTS lane_pilot_model_rebench (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, month TEXT NOT NULL, evaluated_count INTEGER NOT NULL, accuracy REAL NOT NULL, win_rate REAL NOT NULL, report_json TEXT NOT NULL, recorded_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_model_rebench_recorded ON lane_pilot_model_rebench(recorded_at)`,
  // Skill switch metric (Skill Entropy / arXiv 2608.05139): track skill switching in tasks vs failure. Append only.
  `CREATE TABLE IF NOT EXISTS lane_pilot_skill_metric (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT, project_id TEXT NOT NULL, skill_count INTEGER NOT NULL, switch_count INTEGER NOT NULL, skills_json TEXT NOT NULL, outcome TEXT NOT NULL, recorded_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_skill_metric_recorded ON lane_pilot_skill_metric(recorded_at)`,
  // W31 rank 6: why an attempt was canceled — a closed code list (cancel.ts CANCEL_CODES), NULL for cancels before 0.1.396. Append only.
  `ALTER TABLE lane_pilot_attempt ADD COLUMN cancel_code TEXT`,
  // WT1: what the hourly worktree janitor did per host — freed bytes and the copies it kept for the morning line. Append only.
  `CREATE TABLE IF NOT EXISTS lane_pilot_janitor (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, host TEXT NOT NULL, removed INTEGER NOT NULL, freed_bytes INTEGER NOT NULL, tmp_removed INTEGER NOT NULL, tmp_freed_bytes INTEGER NOT NULL, kept_json TEXT NOT NULL DEFAULT '[]')`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_janitor_at ON lane_pilot_janitor(at)`,
  // WT2: every Lane Pilot worktree copy, one row at create (server-side, in the host.call wrapper) and released_at at remove/merge.
  `CREATE TABLE IF NOT EXISTS lane_pilot_worktree (id INTEGER PRIMARY KEY, host TEXT NOT NULL, path TEXT NOT NULL, branch TEXT, owner_kind TEXT NOT NULL, owner_id TEXT, created_at INTEGER NOT NULL, released_at INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lane_pilot_worktree_open ON lane_pilot_worktree(host, path) WHERE released_at IS NULL`,
  // The lead's decision journal: every question to the owner with the prediction made before his answer (src/rooms/lead). Append only.
  ...leadMigrations,
  // H2: an attempt parked while every writer is held re-asks at wake_at; NULL while it is not parked. Append only.
  `ALTER TABLE lane_pilot_attempt ADD COLUMN wake_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_attempt_wake ON lane_pilot_attempt(wake_at) WHERE wake_at IS NOT NULL`,
  // H1: the sampled input of a Jev receipt (one in five, 8 KB cap), for the nightly model relabeler. Append only.
  `ALTER TABLE lane_pilot_jev_receipt ADD COLUMN input_json TEXT`,
  // A3: which skills a PM session opened (PostToolUse hook → `pm-skill-use`), the name as shown. Append only.
  `CREATE TABLE IF NOT EXISTS lane_pilot_pm_skill_use (id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', skill TEXT NOT NULL, used_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_pm_skill_use_at ON lane_pilot_pm_skill_use(used_at)`,
  // A4 shipgate: one row per integration-gate run — what it ran on (head), the batch it checked, and its verdict,
  // so a PM/ship decision reads the gate state after the merge instead of guessing from «all tasks accepted».
  `CREATE TABLE lane_pilot_gate_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    command TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','passed','failed','not_run')),
    head TEXT,
    reason TEXT,
    batch_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_gate_run_project ON lane_pilot_gate_run(project_id, id)`,
  // Stream L2: the PM replay set (scenarios grown nightly from the owner's corrections) and each replay's verdict
  // (src/rooms/pm-replay). Append only.
  ...pmReplayMigrations,
  // Errand episodes, phase A (src/rooms/errands/episodes.ts): the facts of an errand run written when it ends;
  // (run_id, extractor_version) lets a later extractor re-read the same run. Append only.
  `CREATE TABLE lane_pilot_errand_episode (
    run_id TEXT NOT NULL,
    extractor_version INTEGER NOT NULL,
    project_id TEXT,
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT NOT NULL,
    verified TEXT,
    checks_json TEXT,
    thread_id TEXT,
    model TEXT,
    provider_id TEXT,
    skills_offered_json TEXT,
    trace_json TEXT,
    trace_stats_json TEXT,
    enrichment_state TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, extractor_version)
  )`,
  `CREATE INDEX lane_pilot_errand_episode_updated ON lane_pilot_errand_episode(updated_at)`,
  // Errand episodes, phase B (src/rooms/errands/episode-enrich.ts): what the hourly sweep's analyst wrote — the masked
  // summary, the failure class, the model's process-key candidate. `process_key` itself stays NULL: stream E owns it.
  // Append only.
  `ALTER TABLE lane_pilot_errand_episode ADD COLUMN process_key TEXT`,
  `ALTER TABLE lane_pilot_errand_episode ADD COLUMN enriched_model TEXT`,
  `ALTER TABLE lane_pilot_errand_episode ADD COLUMN enriched_at INTEGER`,
  `ALTER TABLE lane_pilot_errand_episode ADD COLUMN summary_json TEXT`,
  `ALTER TABLE lane_pilot_errand_episode ADD COLUMN failure_class TEXT`,
  `ALTER TABLE lane_pilot_errand_episode ADD COLUMN process_key_proposed TEXT`,
  `ALTER TABLE lane_pilot_errand_episode ADD COLUMN enrichment_reason TEXT`,
  // Stream M1b: the owner anamnesis moves to the hub (src/rooms/anamnesis/migrations.ts) — the same columns as the
  // Mac-mini file store under the lane_pilot_owner_ prefix, so one base holds it next to the rest of Lane Pilot's data.
  ...anamnesisOwnerMigrations,
  // Meaning search (packages/memory-core/src/vectors.ts): one vector per active record, made by src/rooms/memory/server/embeddings.ts. Append only.
  `CREATE TABLE IF NOT EXISTS lane_pilot_memory_vec (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, model TEXT NOT NULL, content_sha TEXT NOT NULL, vec BLOB NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_memory_vec_project ON lane_pilot_memory_vec(project_id, model)`,
  // The daily read-back of role profiles (src/rooms/native-agent/profile-check.ts): one report row a day.
  `CREATE TABLE IF NOT EXISTS lane_pilot_profile_check (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, report_json TEXT NOT NULL)`,
  // Structured failure fields: a verification timeout or red check is read from failure_code/check_name/timeout_sec, not
  // parsed out of the human reason (listCheckTimeouts) or a run-goal's detail. Append only; existing rows backfilled once.
  `ALTER TABLE lane_pilot_attempt ADD COLUMN failure_code TEXT`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN check_name TEXT`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN timeout_sec INTEGER`,
  `UPDATE lane_pilot_attempt SET failure_code='verification_timeout',
    check_name=substr(reason, instr(reason, 'verification failed (') + 21,
      instr(reason, '): verification timed out after ') - instr(reason, 'verification failed (') - 21),
    timeout_sec=CAST(substr(reason, instr(reason, '): verification timed out after ') + 32,
      instr(substr(reason, instr(reason, '): verification timed out after ') + 32), 's') - 1) AS INTEGER)
    WHERE instr(reason, 'verification failed (') > 0 AND instr(reason, '): verification timed out after ') > 0`,
  `UPDATE lane_pilot_attempt SET failure_code='verification_failed',
    check_name=substr(reason, instr(reason, 'verification failed (') + 21,
      instr(reason, '): ') - instr(reason, 'verification failed (') - 21)
    WHERE instr(reason, 'verification failed (') > 0 AND instr(reason, '): verification timed out after ') = 0 AND instr(reason, '): ') > 0`,
  `ALTER TABLE lane_pilot_run_goal ADD COLUMN failure_code TEXT`,
  `UPDATE lane_pilot_run_goal SET failure_code='check_failed' WHERE state='skipped' AND detail LIKE 'the check failed:%'`,
  // Contract editions (SMA tb_contract): every change of a task's words mints a new numbered, hashed edition; the earlier
  // ones stay readable. Append-only by trigger: a fix writes a new edition, never rewrites history.
  `CREATE TABLE lane_pilot_task_contract_edition (
    task_id TEXT NOT NULL,
    edition INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    contract_json TEXT NOT NULL,
    plan TEXT,
    reason TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (task_id, edition)
  )`,
  `CREATE TRIGGER lane_pilot_task_contract_edition_no_update BEFORE UPDATE ON lane_pilot_task_contract_edition BEGIN SELECT RAISE(ABORT,'contract editions are append-only'); END`,
  `CREATE TRIGGER lane_pilot_task_contract_edition_no_delete BEFORE DELETE ON lane_pilot_task_contract_edition BEGIN SELECT RAISE(ABORT,'contract editions are append-only'); END`,
  // The barrier's outcome on the attempt row itself (sma av_record): gate, status, why, tree and the verdict's summary.
  `ALTER TABLE lane_pilot_attempt ADD COLUMN barrier_json TEXT`,
  // A miss the owner flagged ("I had to remind you") keeps the record that held the answer, so memory-eval gains a gold case (sma k_v_mem_miss).
  `ALTER TABLE lane_pilot_memory_miss ADD COLUMN kind TEXT NOT NULL DEFAULT 'empty'`,
  `ALTER TABLE lane_pilot_memory_miss ADD COLUMN note_id TEXT`,
  // The attempt ledger (SMA ar_ledger): the attempt row is the current state; its transition log is the ledger —
  // appended, never rewritten or removed, like the stage and gate event journals. An attempt row is not deleted either.
  `CREATE TRIGGER lane_pilot_attempt_transition_no_update BEFORE UPDATE ON lane_pilot_attempt_transition BEGIN SELECT RAISE(ABORT,'attempt transitions are append-only'); END`,
  `CREATE TRIGGER lane_pilot_attempt_transition_no_delete BEFORE DELETE ON lane_pilot_attempt_transition BEGIN SELECT RAISE(ABORT,'attempt transitions are append-only'); END`,
  `CREATE TRIGGER lane_pilot_attempt_no_delete BEFORE DELETE ON lane_pilot_attempt BEGIN SELECT RAISE(ABORT,'attempts are append-only'); END`,

  // Task drafts the PM proposes before the owner says «да» (SMA m_sw_chat_draft, m_sw_batch_draft): the contract(s)
  // wait in `proposed`; the one enqueue path records a result per contract (results_json), the draft is `created` once every contract is, `partial` while some failed.
  `CREATE TABLE lane_pilot_task_draft (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    project_id TEXT NOT NULL,
    thread_id TEXT,
    kind TEXT NOT NULL DEFAULT 'task',
    contracts_json TEXT NOT NULL,
    objective TEXT,
    plan TEXT,
    state TEXT NOT NULL DEFAULT 'proposed',
    task_ids_json TEXT,
    results_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // The landing record (SMA k_lib_landing): how many checks were green when the attempt's merge went in; nullable, beside merge_commit and changed_json.
  `ALTER TABLE lane_pilot_attempt_change ADD COLUMN checks_green INTEGER`,
  // The world counter (SMA m_wrappers): bumped inside the same transaction as every state write, so a commit order exists.
  `ALTER TABLE lane_pilot_attempt ADD COLUMN world_seq INTEGER`,
  // The landing suite verdict (SMA k_lib_landing): {suite, head, at} of the check run on the merged head; the sweep fills it.
  `ALTER TABLE lane_pilot_attempt_change ADD COLUMN suite_json TEXT`,
];
