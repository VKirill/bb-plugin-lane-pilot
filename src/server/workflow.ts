import { HARNESS_VERSION } from "../database";
import { LP_ALL_PROJECTS } from "../realtime-channel";
import { ANALYZE_PLAN_EXECUTE, builtinWorkflow } from "../workflow/builtin";
import { WorkflowEngine } from "../workflow/engine";
import { registerDispatchExecutors } from "./writer/dispatch-workflow";
import type { ServerCore } from "./core";

/**
 * The one workflow engine of this plugin instance, with the executors of the built-in workflows. It stops at a step
 * boundary when the instance is disposed. A drain does not stop it: the stages of the dispatch pipeline write no checkout
 * (the host calls that do are gated by the drain themselves), and stopping them would only end more dispatches at a reload.
 */
export function createWorkflowEngine(ctx: ServerCore) {
  const { bb, db } = ctx;
  // Open Workflows screens re-read a run when one of its steps moves: the project's channel and the global library's.
  const projectOf = new Map<string, string | null>();
  const onEvent = (runId: string) => {
    if (projectOf.size > 500) projectOf.clear();
    if (!projectOf.has(runId)) projectOf.set(runId, (db.prepare("SELECT project_id FROM lane_pilot_wf_run WHERE id=?").get(runId) as { project_id: string | null } | undefined)?.project_id ?? null);
    const project = projectOf.get(runId);
    if (project) ctx.realtime.notify(project, "workflow", undefined, runId);
    ctx.realtime.notify(LP_ALL_PROJECTS, "workflow", undefined, runId);
  };
  const engine = new WorkflowEngine({
    db, harnessVersion: HARNESS_VERSION,
    instanceId: (bb as unknown as { vk?: { instanceId?: string } }).vk?.instanceId,
    log: (message) => bb.log.info(`Lane Pilot ${message}`),
    resolveWorkflow: (id, version) => builtinWorkflow(id, version),
    isDisposed: ctx.isDisposed,
    onEvent,
    // A reload ends a dispatch that was between its stages, as it always did: the attempt is blocked and the PM sends the task again.
    resumePolicy: (run) => (run.workflow_id === ANALYZE_PLAN_EXECUTE ? "interrupt" : "continue"),
  });
  registerDispatchExecutors(engine);
  bb.onDispose(() => engine.dispose());
  return { workflowEngine: engine };
}
