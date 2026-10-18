/**
 * The writer harness as data (0.1.247, the Harness² port, phases 1–5): one tree per (project, area, writer), its trial
 * against the tree it replaces, and what the reflection learned from the trial. Attempts record which tree they ran under
 * and in which arm of a trial, so the trial is read from the attempts themselves; no stage writes metrics twice.
 */
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
