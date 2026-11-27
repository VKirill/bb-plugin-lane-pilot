/**
 * Append-only SQLite migrations owned by the `evolve` room.
 * `lane_pilot_evolve_flag` is created before the triggers that reference it.
 */
export const evolveMigrations = [
  `CREATE TABLE lane_pilot_evolve_flag (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE lane_pilot_evolve_case (
    case_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    split TEXT NOT NULL CHECK(split IN ('working','held_out')),
    task_class TEXT,
    verdict TEXT NOT NULL CHECK(verdict IN ('accept','reject')),
    graph_version INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    rotated_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_evolve_case_wf ON lane_pilot_evolve_case(workflow_id, split)`,
  `CREATE TRIGGER lane_pilot_evolve_case_frozen_update BEFORE UPDATE ON lane_pilot_evolve_case
    WHEN OLD.split = 'held_out' AND (SELECT value FROM lane_pilot_evolve_flag WHERE key = 'rotation') IS NOT 'owner'
    BEGIN SELECT RAISE(ABORT, 'held_out case is frozen'); END`,
  `CREATE TRIGGER lane_pilot_evolve_case_frozen_delete BEFORE DELETE ON lane_pilot_evolve_case
    WHEN OLD.split = 'held_out' AND (SELECT value FROM lane_pilot_evolve_flag WHERE key = 'rotation') IS NOT 'owner'
    BEGIN SELECT RAISE(ABORT, 'held_out case is frozen'); END`,
  `CREATE TABLE lane_pilot_evolve_ingest (
    run_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    ingested_at INTEGER NOT NULL
  )`,
  // Canonical lists: ARM_KINDS, HYPOTHESIS_SOURCES, HYPOTHESIS_STATES in packages/contracts/src/evolve.ts
  `CREATE TABLE lane_pilot_evolve_hypothesis (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    arm_kind TEXT NOT NULL CHECK(arm_kind IN ('model','form','check')),
    variant_json TEXT NOT NULL,
    variant_signature TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('census','fallback','catalog_change','lead_road','owner')),
    state TEXT NOT NULL CHECK(state IN ('queued','replaying','report_only','canary','promoted','retired','rejected')),
    draft_id TEXT,
    scorecard_json TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_evolve_hypothesis_wf ON lane_pilot_evolve_hypothesis(workflow_id, state)`,
  `CREATE TABLE lane_pilot_evolve_negative (
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    variant_signature TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (workflow_id, node_id, variant_signature, graph_version)
  )`,
  `CREATE TRIGGER lane_pilot_evolve_negative_append_only BEFORE UPDATE ON lane_pilot_evolve_negative BEGIN SELECT RAISE(ABORT, 'append-only'); END`,
  // Canonical list: EVOLVE_TRIAL_STATES in packages/contracts/src/evolve.ts
  `CREATE TABLE lane_pilot_evolve_trial (
    trial_id TEXT PRIMARY KEY,
    hypothesis_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    baseline_version INTEGER NOT NULL,
    candidate_draft_id TEXT NOT NULL,
    share REAL NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','promoted','retired','rolled_back')),
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    reason TEXT
  )`,
] as const;
