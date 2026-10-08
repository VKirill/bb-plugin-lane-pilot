import type { LanePilotDatabase } from "../database";
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
  /**
   * The newest live run of this version that proves the chain: a succeeded top-level run, and, when the chain says which final
   * statuses count (`live_success`), one that ended with one of them (a run also succeeds on the branches that did not do the job).
   */
  const liveSuccess = (workflowId: string, version: number, rule?: Workflow["live_success"]) => {
    const rows = db.prepare("SELECT id, updated_at, output_json FROM lane_pilot_wf_run WHERE workflow_id=? AND workflow_version=? AND status='succeeded' AND parent_run_id IS NULL ORDER BY updated_at DESC LIMIT 200")
      .all(workflowId, version) as Array<{ id: string; updated_at: number; output_json: string | null }>;
    const proves = (row: { output_json: string | null }) => {
      if (!rule) return true;
      try { return rule.in.includes(String((JSON.parse(row.output_json ?? "null") as Record<string, unknown> | null)?.[rule.output])); } catch { return false; }
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
      if (file === "tested" && liveSuccess(workflow.id, workflow.version, workflow.live_success)) return { status: "published", notes: [] };
      return { status: file, notes: [] };
    },
  };
}
export type StatusResolver = ReturnType<typeof createStatusResolver>;
