import type { LanePilotDatabase } from "../../storage";
import { wfLatestPipelineRunId, wfPipelineWriterStepKey } from "@lane-pilot/workflow-engine";
import { graphStepMetadata } from "../../platform/server";

/**
 * The graph step a writer thread belongs to: the `writer` node of the task's `lp-task-pipeline` run (the run is linked to the Lane Pilot run and
 * the task, whichever attempt starts the thread). A task with no pipeline run, or a database without the engine's tables, gives null.
 */
export function pipelineWriterStep(db: LanePilotDatabase, runId: string, taskId: string): { runId: string; nodeId: string; stepKey?: string } | null {
  try {
    const run = wfLatestPipelineRunId(db, runId, taskId);
    if (!run) return null;
    const stepKey = wfPipelineWriterStepKey(db, run);
    return { runId: run, nodeId: "writer", ...(stepKey ? { stepKey } : {}) };
  } catch {
    return null;
  }
}

/** The metadata of a thread started for that step (`{}` when the task has no pipeline run). */
export function pipelineWriterTag(db: LanePilotDatabase, runId: string, taskId: string): Record<string, string> {
  return graphStepMetadata(pipelineWriterStep(db, runId, taskId));
}
