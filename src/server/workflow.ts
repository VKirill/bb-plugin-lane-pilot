import { HARNESS_VERSION } from "../database";
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
  const engine = new WorkflowEngine({
    db, harnessVersion: HARNESS_VERSION,
    instanceId: (bb as unknown as { vk?: { instanceId?: string } }).vk?.instanceId,
    log: (message) => bb.log.info(`Lane Pilot ${message}`),
    resolveWorkflow: (id, version) => builtinWorkflow(id, version),
    isDisposed: ctx.isDisposed,
    // A reload ends a dispatch that was between its stages, as it always did: the attempt is blocked and the PM sends the task again.
    resumePolicy: (run) => (run.workflow_id === ANALYZE_PLAN_EXECUTE ? "interrupt" : "continue"),
  });
  registerDispatchExecutors(engine);
  bb.onDispose(() => engine.dispose());
  return { workflowEngine: engine };
}
