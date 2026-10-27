import { HARNESS_VERSION } from "../../storage";
import { LP_ALL_PROJECTS } from "@lane-pilot/ui-kit/realtime-channel";
import { BUILTIN_SOURCES, LP_TASK_PIPELINE, builtinWorkflow } from "../builtin";
import { createWorkflowCatalog } from "@lane-pilot/workflow-engine";
import { ENGINE_COMPAT_VERSION, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { RunRow } from "../../storage";
import { createStatusResolver } from "../../storage";
import { registerPureActions } from "@lane-pilot/workflow-engine";
import { registerReducers } from "@lane-pilot/workflow-engine";
import { createWorkflowAgents } from "./workflow-agent";
import { SPECIALIST_ROLES } from "../../critique/server";
import { createGoalAuditor } from "./workflow-goal-audit";
import { chainRuntimeFor, registerChainExecutors } from "./workflow-executors";
import { notifyWorkflowIfEnded } from "./pm-notice";
import { registerDispatchExecutors } from "../../writer/server";
import { registerInvoiceActions } from "./workflow-invoice";
import { registerAnamnesisActions } from "../../anamnesis";
import { anamnesisFor } from "../../anamnesis";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";

/**
 * The one workflow engine of this plugin instance, with the executors of the built-in workflows. It stops at a step
 * boundary when the instance is disposed. A drain does not stop it: the stages of the dispatch pipeline write no checkout
 * (the host calls that do are gated by the drain themselves), and stopping them would only end more dispatches at a reload.
 */
export function createWorkflowEngine(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  // Open Workflows screens re-read a run when one of its steps moves: the project's channel and the global library's.
  const projectOf = new Map<string, string | null>();
  const engineRef: { current: WorkflowEngine | null } = { current: null };
  const onEvent = (runId: string) => {
    if (projectOf.size > 500) projectOf.clear();
    if (!projectOf.has(runId)) projectOf.set(runId, (db.prepare("SELECT project_id FROM lane_pilot_wf_run WHERE id=?").get(runId) as { project_id: string | null } | undefined)?.project_id ?? null);
    const project = projectOf.get(runId);
    if (project) ctx.realtime.notify(project, "workflow", undefined, runId);
    ctx.realtime.notify(LP_ALL_PROJECTS, "workflow", undefined, runId);
    const run = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id=?").get(runId) as RunRow | undefined;
    if (!run) return;
    const unmet = engineRef.current?.lastAudit(runId)?.unmet.map((entry) => entry.id);
    void notifyWorkflowIfEnded({ bb: ctx.bb, db, log: (message) => ctx.log(message), run, unmetGoalIds: unmet }).catch((cause: unknown) => {
      ctx.log(`Lane Pilot workflow ${runId}: PM notice failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };
  const statuses = createStatusResolver(db);
  const workflowCatalog = createWorkflowCatalog({ builtin: BUILTIN_SOURCES, log: (message) => bb.log.warn(`Lane Pilot ${message}`), resolveStatus: statuses.resolve });
  const workflowAgents = createWorkflowAgents();
  const engine = new WorkflowEngine({
    db, harnessVersion: HARNESS_VERSION, compatVersion: ENGINE_COMPAT_VERSION,
    instanceId: (bb as unknown as { vk?: { instanceId?: string } }).vk?.instanceId,
    log: (message) => bb.log.info(`Lane Pilot ${message}`),
    resolveWorkflow: (id, version) => workflowCatalog.peek()?.resolve(id, version) ?? builtinWorkflow(id, version),
    // A node that runs as an agent the owner deleted is refused at the start with a message, not after the earlier steps ran.
    specialistKnown: (id) => (SPECIALIST_ROLES.includes(id as never) ? true : ctx.knownCustomAgentIds()?.has(id) ?? null),
    isDisposed: ctx.isDisposed,
    onEvent,
    // A run that has goals is judged against them before it closes (K7).
    auditGoals: (input) => createGoalAuditor(ctx, services, workflowAgents)(input),
    // A chain run that outlives a reload gets its runtime again from its row (the PM chat, the project and the Lane Pilot run are in it).
    runtimeFor: chainRuntimeFor(ctx, services),
    // A reload ends a dispatch that was between its stages, as it always did: the attempt is blocked and the PM sends the task again.
    resumePolicy: (run) => (run.workflow_id === LP_TASK_PIPELINE || run.idem_key?.startsWith("lp-task:") ? "interrupt" : "continue"),
  });
  engineRef.current = engine;
  registerDispatchExecutors(engine);
  // The chains of workflows/: the code-only actions and the joins' reducers, then the executors that need the host (agents, the owner, code tasks, files).
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, workflowAgents);
  // The invoice check of `invoice-send` (a Jev judgment behind a chain action).
  registerInvoiceActions(engine, ctx);
  // The public-only facts of the anamnesis for `about-site`, `resume` and `year-review`, and the check of what they wrote.
  registerAnamnesisActions(engine, ctx, (core) => anamnesisFor(core).hub);
  bb.onDispose(() => engine.dispose());
  return { workflowEngine: engine, workflowCatalog, workflowAgents };
}
