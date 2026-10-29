import type { LanePilotDatabase } from "./db";

import { workflowFinish } from "./business-outcome";
import { legacyDefinitionSha256, type StoredWorkflow } from "./store";
import type { Workflow } from "./schema";
import type { WorkflowProblem } from "./validate";

/**
 * What the owner's side of the workflow library keeps beside the journal: the receipts of green test runs of a workflow file
 * (W7), and later the goals of a run and the triggers' automations. Appended to the END of the plugin's migrations (they are positional).
 */
export const PIPELINE_RUNS_ATTRIBUTION = `UPDATE lane_pilot_wf_run SET workflow_id='lp-task-pipeline'
  WHERE workflow_id='analyze-plan-execute' AND parent_run_id IS NULL AND (idem_key LIKE 'lp-task:%' OR link_attempt_id IS NOT NULL)`;

export const workflowOpsMigrations: string[] = [
  // The last test run of a workflow file, keyed by the exact definition that was tested: a file edited afterwards has no receipt.
  `CREATE TABLE lane_pilot_wf_test (
    workflow_id TEXT NOT NULL,
    definition_sha256 TEXT NOT NULL,
    green INTEGER NOT NULL,
    results_json TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY(workflow_id, definition_sha256)
  )`,
  // The BB automation that runs a workflow's schedule trigger (W9): one per workflow, project and schedule trigger; the signature says what it was made from.
  `CREATE TABLE lane_pilot_wf_trigger (
    workflow_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    automation_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(workflow_id, project_id, slot)
  )`,
  // K7: the goals a run was started for (JSON, the router's shape); their changes and the audit before closing are events of the run.
  `ALTER TABLE lane_pilot_wf_run ADD COLUMN goals_json TEXT`,
  // Stats per real workflow: until 0.1.187 the per-task pipeline (one run per dispatched task, keyed `lp-task:<attempt>`) was called
  // analyze-plan-execute, the id the outer chain of the chains spec has now. Those runs are attributed to the pipeline they were.
  PIPELINE_RUNS_ATTRIBUTION,
  // A user run whose goals were empty or whose audit could not be made is `not_verified`, not `succeeded`. SQLite cannot widen a CHECK, so the table is rebuilt.
  `CREATE TABLE lane_pilot_wf_run_nv (
    id TEXT PRIMARY KEY,
    idem_key TEXT UNIQUE,
    workflow_id TEXT NOT NULL,
    workflow_version INTEGER NOT NULL,
    workflow_sha256 TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    project_id TEXT,
    link_run_id TEXT,
    link_task_id TEXT,
    link_attempt_id TEXT,
    parent_run_id TEXT,
    parent_step_key TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('running','waiting','succeeded','failed','blocked','interrupted','canceled','not_verified')),
    reason TEXT,
    mode TEXT,
    inputs_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    harness_version TEXT,
    steps_used INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    wait_ms INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    goals_json TEXT
  );
  INSERT INTO lane_pilot_wf_run_nv(id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,parent_run_id,parent_step_key,depth,status,reason,mode,inputs_json,output_json,harness_version,steps_used,tokens_used,cost_micro_usd,wait_ms,owner_id,lease_until,created_at,updated_at,goals_json)
    SELECT id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,parent_run_id,parent_step_key,depth,status,reason,mode,inputs_json,output_json,harness_version,steps_used,tokens_used,cost_micro_usd,wait_ms,owner_id,lease_until,created_at,updated_at,goals_json FROM lane_pilot_wf_run;
  DROP TABLE lane_pilot_wf_run;
  ALTER TABLE lane_pilot_wf_run_nv RENAME TO lane_pilot_wf_run;
  CREATE UNIQUE INDEX lane_pilot_wf_run_child ON lane_pilot_wf_run(parent_run_id, parent_step_key) WHERE parent_run_id IS NOT NULL;
  CREATE INDEX lane_pilot_wf_run_status ON lane_pilot_wf_run(status);
  CREATE INDEX lane_pilot_wf_run_link ON lane_pilot_wf_run(link_run_id, link_task_id)`,
];

export type StatusVerdict = { status: Workflow["status"]; notes: WorkflowProblem[] };

/**
 * The status a workflow has here, which is not always the status its file says:
 * - a file of the owner (global or project) that says `tested` or `published` counts only with a green test receipt for exactly
 *   this definition; without it the workflow is a `draft` (it is not offered, not run by the PM), so a hand-written `published` cannot skip the tests;
 * - a `tested` workflow (the built-in own chains, or the owner's) is `published` after a live run of this definition that did the job. Canvas positions are not part of that definition.
 */
export function createStatusResolver(db: LanePilotDatabase) {
  const receipt = (workflowId: string, sha256: string) =>
    db.prepare("SELECT green, results_json, at FROM lane_pilot_wf_test WHERE workflow_id=? AND definition_sha256=?").get(workflowId, sha256) as { green: number; results_json: string; at: number } | undefined;
  /**
   * The newest live run of this version that did the job: engine succeeded, the output is completed work, and the run was of this
   * definition (`definitionSha256`, which ignores canvas positions, or the older hash that still includes them).
   */
  const liveSuccess = (workflowId: string, version: number, rule?: Workflow["live_success"], sha?: { current: string; legacy: string }) => {
    const rows = db.prepare("SELECT id, updated_at, output_json, workflow_sha256 FROM lane_pilot_wf_run WHERE workflow_id=? AND workflow_version=? AND status='succeeded' AND parent_run_id IS NULL ORDER BY updated_at DESC LIMIT 200")
      .all(workflowId, version) as Array<{ id: string; updated_at: number; output_json: string | null; workflow_sha256: string }>;
    const proves = (row: { output_json: string | null; workflow_sha256: string }) => {
      if (sha && row.workflow_sha256 !== sha.current && row.workflow_sha256 !== sha.legacy) return false;
      try {
        const parsed = JSON.parse(row.output_json ?? "null") as unknown;
        const output = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        return workflowFinish(output, rule ?? null).ok;
      } catch { return false; }
    };
    const hit = rows.find(proves);
    return hit ? { id: hit.id, updated_at: hit.updated_at } : undefined;
  };

  return {
    recordTest(workflowId: string, sha256: string, green: boolean, results: unknown, at = Date.now()): void {
      db.prepare(`INSERT INTO lane_pilot_wf_test(workflow_id, definition_sha256, green, results_json, at) VALUES (?,?,?,?,?)
        ON CONFLICT(workflow_id, definition_sha256) DO UPDATE SET green=excluded.green, results_json=excluded.results_json, at=excluded.at`)
        .run(workflowId, sha256, green ? 1 : 0, JSON.stringify(results ?? null), at);
    },
    receipt,
    liveSuccess,
    resolve(item: StoredWorkflow): StatusVerdict {
      const { workflow } = item;
      const file = workflow.status;
      if (file === "draft" || file === "deprecated") return { status: file, notes: [] };
      if (item.origin !== "builtin") {
        const tested = receipt(workflow.id, item.sha256) ?? receipt(workflow.id, legacyDefinitionSha256(workflow));
        if (!tested?.green) {
          return { status: "draft", notes: [{ level: "warning", code: "untested",
            message: `The file says "${file}", but there is no green test run for exactly this version of it: it counts as a draft until its tests pass (run its tests from the Workflows tab).` }] };
        }
      }
      if (file === "tested" && liveSuccess(workflow.id, workflow.version, workflow.live_success, { current: item.sha256, legacy: legacyDefinitionSha256(workflow) })) return { status: "published", notes: [] };
      return { status: file, notes: [] };
    },
  };
}
export type StatusResolver = ReturnType<typeof createStatusResolver>;
