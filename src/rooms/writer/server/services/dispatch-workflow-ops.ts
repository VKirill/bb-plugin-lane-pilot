import { parseJsonOr } from "@lane-pilot/kit";
import { wfLatestPipelineRunId, wfLiveRunHasStep, wfRunInputsJson } from "@lane-pilot/workflow-engine";
import { LP_TASK_PIPELINE } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import type { RunSummary, StepContext, WorkflowEngine } from "../../../workflow";
import { endedAttemptReply, type DispatchRuntime, type DispatchServices } from "./dispatch-runtime";
import type { RoundFindings } from "./plan-revise";
export { buildQueuedReply, dispatchReply, endedAttemptReply, type DispatchRuntime } from "./dispatch-runtime";

/**
 * The built-in workflow `lp-task-pipeline` (workflows/lp-task-pipeline.json) executed by the workflow engine.
 * Each executor wraps a stage function (pm-read, the critiques, the writer loop); this is the only path a dispatch takes, and the
 * equivalence test pins the receipts it leaves.
 */

/** Why the task pipeline cannot start on this engine, or null when it can: no engine, no pipeline graph, or a graph the engine refuses. */
export function pipelineUnavailable(engine: WorkflowEngine | undefined): string | null {
  if (!engine) return "the workflow engine is not running";
  const workflow = engine.resolveWorkflow(LP_TASK_PIPELINE);
  if (!workflow) return `built-in workflow ${LP_TASK_PIPELINE} is not loaded`;
  const problems = engine.preflight(workflow);
  return problems.length ? problems.slice(0, 3).join("; ") : null;
}

const need = (ctx: StepContext<DispatchRuntime>): DispatchRuntime => {
  if (!ctx.runtime) throw new Error("the dispatch was interrupted by a plugin reload; send the task again");
  return ctx.runtime;
};
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const endedReply = (r: DispatchRuntime) => endedAttemptReply(r.ctx.db, r.runId, r.taskId, r.attemptId);

/** The agent-typed nodes also hand over a line saying what was done: the engine requires a handoff from every agent. */
const handoffOf = (stage: string, state: string, reason?: string) => `${stage} ${state}${reason ? `: ${reason}` : ""}`;

/** What the planner loop of this pipeline run did so far (SMA n1269): the outputs of its finished plan-critique and plan-revise steps, in order. */
export type PlannerLoopState = { critiques: Array<{ allowed?: boolean; reason?: string; findings?: unknown[]; round?: number }>; revises: Array<{ revised?: boolean; reason?: string; plannerThreadId?: string; fromSha?: string; planSha?: string; edition?: number }> };
export function plannerLoopState(engine: Pick<WorkflowEngine, "snapshot"> | undefined, pipelineRunId: string): PlannerLoopState {
  const steps = (engine?.snapshot?.(pipelineRunId)?.steps ?? []).filter((step) => step.scope === "" && step.state === "succeeded");
  const outputs = (node: string) => steps.filter((step) => step.node_id === node).map((step) => parseJsonOr(step.output_json ?? "null", null) as Record<string, unknown> | null).filter((row): row is Record<string, unknown> => !!row);
  return { critiques: outputs("plan-critique") as PlannerLoopState["critiques"], revises: outputs("plan-revise") as PlannerLoopState["revises"] };
}
/** The findings of every critic round of the loop, the latest last. */
const roundsOf = (loop: PlannerLoopState): RoundFindings[] => loop.critiques.filter((row) => row.allowed === false)
  .map((row, index) => ({ round: index + 1, ...(row.reason ? { reason: row.reason } : {}), findings: Array.isArray(row.findings) ? row.findings : [] }));

/** The graph step a stage function runs for: its helper threads carry these ids in their metadata. */
const stepRef = (ctx: StepContext<DispatchRuntime>) => ({ runId: ctx.runId, stepKey: ctx.stepKey, nodeId: ctx.nodeId });

const engineServices = new WeakMap<WorkflowEngine, { ctx?: ServerCore; services: DispatchServices }>();

export { engineServices, need, text, endedReply, handoffOf, roundsOf, stepRef };
export const dispatchRunKey = (attemptId: string, resume = 0): string => `lp-task:${attemptId}${resume ? `:resume-${resume}` : ""}`;

/** Starts the dispatch pipeline as a workflow run keyed by the attempt; baseRef goes into inputs so restarts retain it. */
export function startDispatchRun(engine: WorkflowEngine, runtime: DispatchRuntime, resume = 0): { runId: string; done: Promise<RunSummary> } {
  engineServices.set(engine, { services: runtime.services, ctx: runtime.ctx });
  const workflow = engine.resolveWorkflow(LP_TASK_PIPELINE);
  if (!workflow) throw new Error(`built-in workflow ${LP_TASK_PIPELINE} is not loaded`);
  return engine.start({
    workflow, inputs: { taskId: runtime.taskId, attemptId: runtime.attemptId, ...(runtime.baseRef === undefined ? {} : { baseRef: runtime.baseRef }) },
    key: dispatchRunKey(runtime.attemptId, resume), runtime,
    link: { projectId: runtime.projectId, runId: runtime.runId, taskId: runtime.taskId, attemptId: runtime.attemptId },
  });
}

/** The newest pipeline run of a task (`lp-task-pipeline`, linked to the Lane Pilot run and the task), or null. */
export const dispatchRunOf = (db: ServerCore["db"], runId: string, taskId: string): string | null => wfLatestPipelineRunId(db, runId, taskId);

/** True while a plan-revise step exists on a live pipeline run (PM updates stop the planner loop via PM_STOPPED_PLANNER_LOOP). */
export function plannerLoopActive(db: ServerCore["db"], runId: string, taskId: string): boolean {
  const pipelineRunId = dispatchRunOf(db, runId, taskId);
  return pipelineRunId ? wfLiveRunHasStep(db, pipelineRunId, "plan-revise") : false;
}

export type DispatchRerun = { ok: true; pipelineRunId: string; settled: boolean; critique: { allowed: boolean; reason?: string } | null } | { ok: false; reason: string };

/** Re-runs a waiting task's pipeline from `pm-read` with updated contract and plan, resolving once it waits for writer, ends, or hits `waitMs`. */
export async function rerunDispatchStages(engine: WorkflowEngine, runtime: DispatchRuntime, waitMs: number): Promise<DispatchRerun> {
  const pipelineRunId = dispatchRunOf(runtime.ctx.db, runtime.runId, runtime.taskId);
  if (!pipelineRunId) return { ok: false, reason: "no_pipeline_run" };
  // The PM's baseRef is kept only in the pipeline run's inputs.
  try {
    const baseRef = (parseJsonOr(wfRunInputsJson(runtime.ctx.db, pipelineRunId) || "{}", {}) as { baseRef?: unknown }).baseRef;
    if (typeof baseRef === "string") runtime.baseRef = baseRef;
  } catch (cause) { runtime.ctx.log(`workflow ${pipelineRunId}: no baseRef: ${cause instanceof Error ? cause.message : String(cause)}`); }
  engine.cancel(pipelineRunId, "the task was updated");
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
  // The drive of the canceled run winds down on its own; the re-run is refused until it has.
  const until = Date.now() + 5_000;
  let again = await engine.rerunNode(pipelineRunId, "pm-read", runtime);
  while (!again.ok && again.reason === "run_active" && Date.now() < until) {
    await pause();
    again = await engine.rerunNode(pipelineRunId, "pm-read", runtime);
  }
  if (!again.ok) return { ok: false, reason: again.reason };
  const deadline = Date.now() + waitMs;
  while (engine.get(pipelineRunId)?.status === "running" && Date.now() < deadline) await pause();
  const status = engine.get(pipelineRunId)?.status;
  const critique = engine.snapshot(pipelineRunId)?.steps.filter((step) => (step.node_id === "plan-critique" || step.node_id === "plan-critique-quick") && step.state === "succeeded").at(-1);
  let verdict: { allowed: boolean; reason?: string } | null = null;
  const out = parseJsonOr(critique?.output_json ?? "null", null) as { allowed?: unknown; reason?: unknown } | null;
  if (out && typeof out.allowed === "boolean") verdict = { allowed: out.allowed, ...(typeof out.reason === "string" ? { reason: out.reason } : {}) };
  return { ok: true, pipelineRunId, settled: status !== "running", critique: verdict };
}
