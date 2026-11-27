import { sha256Hex } from "@lane-pilot/kit";
import { wfRunRow } from "@lane-pilot/workflow-engine";
import { recordTrajectoryDeltaSafe, type TrajectoryDeltaLogSink } from "../../../platform/server";

export type HumanAnswerNoteInput = {
  runId: string;
  workflowId?: string | null | undefined;
  projectId?: string | null | undefined;
  threadId?: string | null | undefined;
  nodeId: string;
  option?: string | undefined;
  freeText?: string | undefined;
};

/**
 * Records an owner answer to a workflow human step as a `variant_selected` trajectory delta.
 * Fire-and-forget: lookup or write errors warn and never fail the workflow step.
 */
export function noteHumanAnswer(
  db: object,
  input: HumanAnswerNoteInput,
  log?: TrajectoryDeltaLogSink,
): void {
  let projectId = input.projectId ?? null;
  let workflowId = input.workflowId ?? null;
  if (projectId === null || workflowId === null) {
    try {
      const run = wfRunRow(db as never, input.runId);
      if (run) {
        if (projectId === null) projectId = run.project_id ?? null;
        if (workflowId === null) workflowId = run.workflow_id ?? null;
      }
    } catch { /* minimal test db may not have lane_pilot_wf_run */ }
  }
  const option = input.option?.trim() ?? "";
  const freeText = input.freeText?.trim() ?? "";
  const rawSummary = option && freeText && freeText !== option
    ? `${option}: ${freeText}`
    : (option || freeText || input.nodeId);
  const id = `tdelta_human_${sha256Hex(`${input.runId}|${input.nodeId}|${rawSummary}`).slice(0, 24)}`;

  recordTrajectoryDeltaSafe(
    db,
    {
      id,
      projectId,
      threadId: input.threadId ?? null,
      workflowId,
      stageArchetype: input.nodeId,
      interventionKind: "variant_selected",
      rawSummary,
    },
    { log, runId: input.runId, graphId: workflowId },
  );
}

/** Records a `rule_added` trajectory delta when a run's goals are amended. */
export function noteGoalsAmended(
  db: object,
  input: { runId: string; workflowId: string; projectId: string; threadId: string; version: number; reason: string },
  log?: TrajectoryDeltaLogSink,
): void {
  recordTrajectoryDeltaSafe(
    db,
    {
      id: `tdelta_goals_${sha256Hex(`${input.runId}|${input.version}|${input.reason}`).slice(0, 24)}`,
      projectId: input.projectId,
      threadId: input.threadId,
      workflowId: input.workflowId,
      stageArchetype: "goals",
      interventionKind: "rule_added",
      rawSummary: input.reason,
    },
    { log, runId: input.runId, graphId: input.workflowId },
  );
}

/** Records a `step_inserted` trajectory delta when a workflow node is re-run via amend. */
export function noteNodeRerun(
  db: object,
  input: { runId: string; workflowId: string; projectId: string; threadId: string; nodeId: string; stepKey: string; reason: string },
  log?: TrajectoryDeltaLogSink,
): void {
  recordTrajectoryDeltaSafe(
    db,
    {
      id: `tdelta_rerun_${sha256Hex(`${input.runId}|${input.stepKey}|${input.nodeId}|${input.reason}`).slice(0, 24)}`,
      projectId: input.projectId,
      threadId: input.threadId,
      workflowId: input.workflowId,
      stageArchetype: input.nodeId,
      interventionKind: "step_inserted",
      rawSummary: `rerun ${input.nodeId} (${input.stepKey})${input.reason ? `: ${input.reason}` : ""}`,
    },
    { log, runId: input.runId, graphId: input.workflowId },
  );
}
