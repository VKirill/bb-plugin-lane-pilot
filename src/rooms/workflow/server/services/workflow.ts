import { installWorkflowAdmission } from "./workflow-admission";
import { HARNESS_VERSION, createStatusResolver, getRunSettingsScopes, loadProjectSettings } from "../../../storage";
import type { VerificationGatePort } from "../../../contracts/integration-gate";
import type { IsTaskSatisfied } from "../../../contracts";
import { LP_ALL_PROJECTS } from "@lane-pilot/ui-kit/realtime-channel";
import { GLOBAL_SETTINGS_PROJECT_ID, workflowBudgetDefaults } from "@lane-pilot/settings-catalog";
import { postOwnerItem } from "../../../owner-waiting";
import { invalidateRpcTags, stopThreadTree } from "../../../platform/server";
import { ENGINE_COMPAT_VERSION, WorkflowEngine, createWorkflowCatalog, registerPureActions, registerReducers, wfRunProjectId, wfRunRow } from "@lane-pilot/workflow-engine";
import { createWorkflowAgents } from "./workflow-agent";
import { SPECIALIST_ROLES } from "../../../critique/server";
import { isEmployeeSpecialist } from "../../../contracts/employee-manifest";
import { createGoalAuditor } from "./workflow-goal-audit";
import { chainRuntimeFor, registerChainExecutors } from "./workflow-executors";
import { createRootObserver } from "./workflow-root-observation";
import { notifyWorkflowIfEnded } from "./pm-notice";
import type { LeadRoadApi } from "../../../contracts";
import { createAfterAcceptStarter, mountWorkflowAttemptFinished, registerAfterAcceptExecutors, type OnAttemptFinished } from "./after-accept";
import { registerInvoiceActions } from "./workflow-invoice";
import { registerTelegramActions } from "./workflow-telegram";
import type { ServerCore } from "../../../contracts/server";

import type { MemoryStageApi } from "../../../memory/server";
import type {DispatchWriter, TaskUsage, IsLiveFolder, StartWriterTask, WriterStateApi} from "../../../platform/server";

import type { DocsApi } from "../../../docs/server";
import type { StabilityApi } from "../../../stability/server";

import type { BaselineApi } from "../../../baseline/server";
import type { WorkflowTriggersApi } from "./workflow-triggers-live";
import { SCHEDULE_RUN_KEY_PREFIX } from "../../../contracts";
import { LP_TASK_PIPELINE } from "../../../contracts";
import {BUILTIN_SOURCES, builtinWorkflow, logBuiltinLibraryStatus} from "../../builtin";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  baseline: BaselineApi;
  dispatchWriter: DispatchWriter;
  taskUsage: TaskUsage;
  docsPlaces: DocsApi["docsPlaces"];
  isLiveFolder: IsLiveFolder;
  isTaskSatisfied: IsTaskSatisfied;
  runMemoryMaintenance: MemoryStageApi["runMemoryMaintenance"];
  stability: StabilityApi;
  resolveIntegrationGate: VerificationGatePort;
  startWriterTask: StartWriterTask;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
  leadRoad: LeadRoadApi;
  onAttemptFinished: OnAttemptFinished;
  schedules?: {
    save: (
      raw: {
        projectId: string;
        name: string;
        description?: string;
        task: { kind: "workflow"; workflowId: string; inputs?: Record<string, unknown>; liveTrial?: boolean };
        when: { type: "cron"; cron: string; timezone?: string };
      },
      by: string,
    ) => unknown;
    settleWorkflowRun?: (wfRunId: string) => Promise<void>;
  };
  backlog?: { scan: (now?: number) => Promise<unknown> };
  phaseIntake?: unknown;
}

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
    if (!projectOf.has(runId)) projectOf.set(runId, wfRunProjectId(db, runId));
    const project = projectOf.get(runId);
    if (project) ctx.realtime.notify(project, "workflow", undefined, runId);
    ctx.realtime.notify(LP_ALL_PROJECTS, "workflow", undefined, runId);
    // Workflow runs sit on the watched task board too: mark its tags stale on every step move.
    invalidateRpcTags(ctx.bb, project ? [`task-board:${project}`, "task-board:all"] : ["task-board:all"]);
    const run = wfRunRow(db, runId);
    if (!run) return;
    if (run.idem_key?.startsWith(SCHEDULE_RUN_KEY_PREFIX) || run.status !== "running") {
      void services.schedules?.settleWorkflowRun?.(runId);
    }
    const unmet = engineRef.current?.lastAudit(runId)?.unmet.map((entry) => entry.id);
    void notifyWorkflowIfEnded({ bb: ctx.bb, db, leadRoad: services.leadRoad, log: (message) => ctx.log(message), run, unmetGoalIds: unmet }).catch((cause: unknown) => {
      ctx.log(`Lane Pilot workflow ${runId}: PM notice failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };
  const statuses = createStatusResolver(db);
  logBuiltinLibraryStatus({ info: (message) => bb.log.info(`Lane Pilot ${message}`), warn: (message) => bb.log.warn(`Lane Pilot ${message}`) });
  const workflowCatalog = createWorkflowCatalog({ builtin: BUILTIN_SOURCES, log: (message) => bb.log.warn(`Lane Pilot ${message}`), resolveStatus: statuses.resolve });
  const workflowAgents = createWorkflowAgents();
  const engine: WorkflowEngine = new WorkflowEngine({
    db, harnessVersion: HARNESS_VERSION, compatVersion: ENGINE_COMPAT_VERSION,
    instanceId: bb.vk?.instanceId,
    log: (message) => bb.log.info(`Lane Pilot ${message}`),
    logger: {
      debug: (message) => bb.log.debug(`Lane Pilot ${message}`),
      info: (message) => bb.log.info(`Lane Pilot ${message}`),
      warn: (message) => bb.log.warn(`Lane Pilot ${message}`),
      error: (message) => bb.log.error(`Lane Pilot ${message}`),
    },
    resolveWorkflow: (id, version) => workflowCatalog.peek()?.resolve(id, version) ?? builtinWorkflow(id, version),
    // A node that runs as an agent the owner deleted is refused at the start with a message, not after the earlier steps ran.
    specialistKnown: (id) => (SPECIALIST_ROLES.includes(id as never) || isEmployeeSpecialist(id) ? true : ctx.knownCustomAgentIds()?.has(id) ?? null),
    isDisposed: ctx.isDisposed,
    onEvent,
    // A run that has goals is judged against them before it closes (K7).
    auditGoals: (input) => createGoalAuditor(ctx, services, workflowAgents)(input),
    // A chain run that outlives a reload gets its runtime again from its row (the PM chat, the project and the Lane Pilot run are in it).
    runtimeFor: chainRuntimeFor(ctx, services),
    // Root runs journal a measured checkout snapshot before the first step and before the goal audit (review588).
    observeRun: createRootObserver(ctx, services),
    // A reload ends a dispatch that was between its stages, as it always did: the attempt is blocked and the PM sends the task again.
    resumePolicy: (run) => ((run.workflow_id === LP_TASK_PIPELINE || run.idem_key?.startsWith("lp-task:")) && run.status !== "waiting" ? "interrupt" : "continue"),
    resolveBudgetDefaults: (run) => workflowBudgetDefaults(
      loadProjectSettings(db, run.project_id ?? GLOBAL_SETTINGS_PROJECT_ID, run.link_run_id ? getRunSettingsScopes(db, run.link_run_id) : []),
    ),
    stopThread: (threadId) => stopThreadTree(bb, threadId).then((res) => res.killed),
    onHoldOwner: (info) => {
      postOwnerItem(db as never, {
        key: `wf-cost-hold:${info.runId}:${info.stepKey}`,
        source: "workflow",
        kind: "blocked",
        reason: "blocked",
        projectId: info.projectId,
        what: `Workflow step ${info.nodeId} paused: cost could not be measured`,
        why: info.detail,
        wake: true,
        evidence: [{ kind: "run", ref: info.runId, label: info.stepKey }],
      });
    },
  });
  const stopAdmissionTracking = installWorkflowAdmission(db, engine);
  bb.onDispose(() => { void engine.idle().then(stopAdmissionTracking, stopAdmissionTracking); });
  engineRef.current = engine;
  // What runs once a task is accepted (memory and project life), started by the merge.
  registerAfterAcceptExecutors(engine, ctx, services);
  // The chains of workflows/: the code-only actions and the joins' reducers, then the executors that need the host (agents, the owner, code tasks, files).
  registerPureActions(engine);
  registerReducers(engine);
  registerChainExecutors(engine, ctx, services, workflowAgents);
  // The invoice check of `invoice-send` (a Jev judgment behind a chain action).
  registerInvoiceActions(engine, ctx);
  registerTelegramActions(engine, ctx);
  bb.onDispose(() => engine.dispose());
  const startAfterAcceptance = createAfterAcceptStarter(engine, ctx);
  mountWorkflowAttemptFinished(ctx, { onAttemptFinished: services.onAttemptFinished, startAfterAcceptance });
  return { workflowEngine: engine, workflowCatalog, startAfterAcceptance };
}

export type WorkflowEngineApi = ReturnType<typeof createWorkflowEngine>;
