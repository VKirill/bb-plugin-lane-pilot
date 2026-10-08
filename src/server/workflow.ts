import { HARNESS_VERSION } from "../database";
import { LP_ALL_PROJECTS } from "../realtime-channel";
import { LP_TASK_PIPELINE, builtinWorkflow } from "../workflow/builtin";
import { createWorkflowCatalog } from "../workflow/catalog";
import { ENGINE_COMPAT_VERSION, WorkflowEngine } from "../workflow/engine";
import { createStatusResolver } from "../workflow/ops-store";
import { registerPureActions } from "../workflow/actions";
import { registerReducers } from "../workflow/reducers";
import { createWorkflowAgents } from "./workflow-agent";
import { createGoalAuditor } from "./workflow-goal-audit";
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
  // Open Workflows screens re-read a run when one of its steps moves: the project's channel and the global library's.
  const projectOf = new Map<string, string | null>();
  const onEvent = (runId: string) => {
    if (projectOf.size > 500) projectOf.clear();
    if (!projectOf.has(runId)) projectOf.set(runId, (db.prepare("SELECT project_id FROM lane_pilot_wf_run WHERE id=?").get(runId) as { project_id: string | null } | undefined)?.project_id ?? null);
    const project = projectOf.get(runId);
    if (project) ctx.realtime.notify(project, "workflow", undefined, runId);
    ctx.realtime.notify(LP_ALL_PROJECTS, "workflow", undefined, runId);
  };
  const statuses = createStatusResolver(db);
  const workflowCatalog = createWorkflowCatalog({ log: (message) => bb.log.warn(`Lane Pilot ${message}`), resolveStatus: statuses.resolve });
  const workflowAgents = createWorkflowAgents();
  const engine = new WorkflowEngine({
    db, harnessVersion: HARNESS_VERSION, compatVersion: ENGINE_COMPAT_VERSION,
    instanceId: (bb as unknown as { vk?: { instanceId?: string } }).vk?.instanceId,
    log: (message) => bb.log.info(`Lane Pilot ${message}`),
    resolveWorkflow: (id, version) => workflowCatalog.peek()?.resolve(id, version) ?? builtinWorkflow(id, version),
    isDisposed: ctx.isDisposed,
    onEvent,
    // A run that has goals is judged against them before it closes (K7).
    auditGoals: (input) => createGoalAuditor(ctx, services, workflowAgents)(input),
    // A chain run that outlives a reload gets its runtime again from its row (the PM chat, the project and the Lane Pilot run are in it).
    runtimeFor: chainRuntimeFor(ctx, services),
    // A reload ends a dispatch that was between its stages, as it always did: the attempt is blocked and the PM sends the task again.
    resumePolicy: (run) => (run.workflow_id === LP_TASK_PIPELINE || run.idem_key?.startsWith("lp-task:") ? "interrupt" : "continue"),
  });
  registerDispatchExecutors(engine);
  // The chains of workflows/: the code-only actions and the joins' reducers, then the executors that need the host (agents, the owner, code tasks, files).
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, workflowAgents);
  bb.onDispose(() => engine.dispose());
  return { workflowEngine: engine, workflowCatalog, workflowAgents };
}
