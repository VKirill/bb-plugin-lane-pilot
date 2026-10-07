import type { LanePilotDatabase } from "../database";
import type { StoredWorkflow } from "./store";
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
];

export type StatusVerdict = { status: Workflow["status"]; notes: WorkflowProblem[] };

/**
 * The status a workflow has here, which is not always the status its file says:
 * - a file of the owner (global or project) that says `tested` or `published` counts only with a green test receipt for exactly
 *   this definition; without it the workflow is a `draft` (it is not offered, not run by the PM), so a hand-written `published` cannot skip the tests;
 * - a `tested` workflow (the built-in own chains, or the owner's) whose current version has had a live run that succeeded is `published`.
 */
export function createStatusResolver(db: LanePilotDatabase) {
  const receipt = (workflowId: string, sha256: string) =>
    db.prepare("SELECT green, results_json, at FROM lane_pilot_wf_test WHERE workflow_id=? AND definition_sha256=?").get(workflowId, sha256) as { green: number; results_json: string; at: number } | undefined;
  const liveSuccess = (workflowId: string, version: number) =>
    db.prepare("SELECT id, updated_at FROM lane_pilot_wf_run WHERE workflow_id=? AND workflow_version=? AND status='succeeded' AND parent_run_id IS NULL ORDER BY updated_at DESC LIMIT 1")
      .get(workflowId, version) as { id: string; updated_at: number } | undefined;

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
        const tested = receipt(workflow.id, item.sha256);
        if (!tested?.green) {
          return { status: "draft", notes: [{ level: "warning", code: "untested",
            message: `The file says "${file}", but there is no green test run for exactly this version of it: it counts as a draft until its tests pass (run its tests from the Workflows tab).` }] };
        }
      }
      if (file === "tested" && liveSuccess(workflow.id, workflow.version)) return { status: "published", notes: [] };
      return { status: file, notes: [] };
    },
  };
}
export type StatusResolver = ReturnType<typeof createStatusResolver>;
