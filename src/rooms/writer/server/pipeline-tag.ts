import type { LanePilotDatabase } from "../../storage";
import { graphStepMetadata } from "../../core/server";

/**
 * The graph step a writer thread belongs to: the `writer` node of the task's `lp-task-pipeline` run (the run is linked to the Lane Pilot run and
 * the task, whichever attempt starts the thread). A task with no pipeline run, or a database without the engine's tables, gives `{}`.
 */
export function pipelineWriterTag(db: LanePilotDatabase, runId: string, taskId: string): Record<string, string> {
  try {
    const run = db.prepare("SELECT id FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline' AND link_run_id=? AND link_task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(runId, taskId) as { id: string } | undefined;
    if (!run) return {};
    const step = db.prepare("SELECT step_key FROM lane_pilot_wf_step WHERE run_id=? AND node_id='writer' ORDER BY visit DESC LIMIT 1").get(run.id) as { step_key: string } | undefined;
    return graphStepMetadata({ runId: run.id, nodeId: "writer", ...(step ? { stepKey: step.step_key } : {}) });
  } catch {
    return {};
  }
}
