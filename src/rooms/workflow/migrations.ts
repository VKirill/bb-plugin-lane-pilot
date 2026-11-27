export const workflowRoomMigrations = [
  `CREATE TABLE lane_pilot_route_miss (
    miss_id TEXT PRIMARY KEY,
    project_id TEXT,
    source TEXT NOT NULL CHECK(source IN ('pm_route','errand_route')),
    kind TEXT NOT NULL CHECK(kind IN ('no_candidate','weak_match','blocked','near_miss')),
    brief_hash TEXT NOT NULL,
    brief_excerpt TEXT NOT NULL,
    top_workflow_id TEXT,
    confidence INTEGER,
    category TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_route_miss_created ON lane_pilot_route_miss(created_at)`,
  // Canonical list: OWNER_REFUSAL_REASONS in packages/contracts/src/run-verdicts.ts
  `CREATE TABLE lane_pilot_wf_run_verdict (
    run_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    graph_version INTEGER NOT NULL,
    verdict TEXT NOT NULL CHECK(verdict IN ('accept','reject')),
    source TEXT NOT NULL CHECK(source IN ('owner','human_node')),
    reason TEXT CHECK(reason IS NULL OR reason IN ('wrong_result','too_costly','off_brand','bad_timing','unsafe','other')),
    note TEXT,
    decided_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_wf_run_verdict_wf_decided ON lane_pilot_wf_run_verdict(workflow_id, decided_at)`,
] as const;
