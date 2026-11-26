export const trajectoryDeltaMigrations = [
  `CREATE TABLE lane_pilot_trajectory_delta (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    thread_id TEXT,
    workflow_id TEXT,
    stage_archetype TEXT NOT NULL,
    intervention_kind TEXT NOT NULL CHECK(intervention_kind IN ('skill_request','rule_added','step_inserted','reference_branch','variant_selected')),
    resolved_skills_json TEXT NOT NULL DEFAULT '[]',
    masked_summary TEXT NOT NULL,
    owner_accepted INTEGER NOT NULL DEFAULT 1 CHECK(owner_accepted IN (0, 1)),
    processed_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_trajectory_delta_unprocessed ON lane_pilot_trajectory_delta(processed_at, created_at)`,
  `CREATE INDEX lane_pilot_trajectory_delta_project ON lane_pilot_trajectory_delta(project_id, created_at)`,
  `CREATE TRIGGER lane_pilot_trajectory_delta_no_delete BEFORE DELETE ON lane_pilot_trajectory_delta BEGIN SELECT RAISE(ABORT, 'trajectory deltas are append-only'); END`,
] as const;
