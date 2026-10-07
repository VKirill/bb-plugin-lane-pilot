import { HARNESS_VERSION } from "../database";
import { LP_TASK_PIPELINE, builtinWorkflow } from "../workflow/builtin";
import { createWorkflowCatalog } from "../workflow/catalog";
import { WorkflowEngine } from "../workflow/engine";
import { registerPureActions } from "../workflow/actions";
import { registerReducers } from "../workflow/reducers";
import { createWorkflowAgents } from "./workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "./workflow-executors";
import { registerDispatchExecutors } from "./writer/dispatch-workflow";
import type { ServerCore } from "./core";
import type { Services } from "./services";

/**
 * The one workflow engine of this plugin instance, with the executors of the built-in workflows. It stops at a step
 * boundary when the instance is disposed. A drain does not stop it: the stages of the dispatch pipeline write no checkout
 * (the host calls that do are gated by the drain themselves), and stopping them would only end more dispatches at a reload.
 */
export function createWorkflowEngine(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const workflowCatalog = createWorkflowCatalog({ log: (message) => bb.log.warn(`Lane Pilot ${message}`) });
  const engine = new WorkflowEngine({
    db, harnessVersion: HARNESS_VERSION,
    instanceId: (bb as unknown as { vk?: { instanceId?: string } }).vk?.instanceId,
    log: (message) => bb.log.info(`Lane Pilot ${message}`),
    resolveWorkflow: (id, version) => workflowCatalog.peek()?.resolve(id, version) ?? builtinWorkflow(id, version),
    isDisposed: ctx.isDisposed,
    // A chain run that outlives a reload gets its runtime again from its row (the PM chat, the project and the Lane Pilot run are in it).
    runtimeFor: chainRuntimeFor(ctx, services),
    // A reload ends a dispatch that was between its stages, as it always did: the attempt is blocked and the PM sends the task again.
    resumePolicy: (run) => (run.workflow_id === LP_TASK_PIPELINE || run.idem_key?.startsWith("lp-task:") ? "interrupt" : "continue"),
  });
  registerDispatchExecutors(engine);
  // The chains of workflows/: the code-only actions and the joins' reducers, then the executors that need the host (agents, the owner, code tasks, files).
  registerPureActions(engine);
  registerReducers(engine);
  const workflowAgents = createWorkflowAgents();
  registerChainExecutors(engine, ctx, services, workflowAgents);
  bb.onDispose(() => engine.dispose());
  return { workflowEngine: engine, workflowCatalog, workflowAgents };
}
