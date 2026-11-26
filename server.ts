import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { initRuntimeEnv } from "@lane-pilot/kit";
import { listUnfinishedStages, loadPrototypeConfig, loadProjectSettings, openDatabase, listProjectsWithGlobalSettings, openRunOfPmThread } from "./src/rooms/storage";
import { lanePilotOwnedTarget, withStandardServiceTier } from "./src/rooms/platform/server";
import { writerFallbackChain, writerFallbacks } from "@lane-pilot/models";
import { migrations as lanePilotMigrations } from "./src/rooms/migrations";
import { SETTINGS_REGISTRY } from "./src/rooms/settings-registry";
import { coupledSettingKeys, validateSettingChanges, validateSettingValue, validateSettingsObject } from "./src/rooms/settings";
import { createTaskReconcile } from "./src/rooms/runs/server";
import { conveyorStartLine } from "./src/rooms/runs";
import { createActivation } from "./src/rooms/native-agent/server";
import { placeEmployeeOn, compileEffectiveMainAgent, detectCompiledMainAgentCapability, pendingSwitch } from "./src/rooms/native-agent";
import { storeNativeSelection } from "./src/rooms/native-agent/server";
import { createMergeIntentRecovery, gateResolverFor, registerLandingSuiteAction } from "./src/rooms/verification/server";
import { registerCli } from "./src/rooms/tools/server";
import { createCore } from "./src/rooms/core/server/core";
import { createCanary, mountCanary, poolReadiness, type PoolChain } from "./src/rooms/stability/server";
import { mountNativeWiring } from "./src/rooms/core/server/native-wiring";
import { createMemoryProbe } from "./src/rooms/memory-probe/server";
import { createMemoryConflicts } from "./src/rooms/memory/server";
import { createReconcile, ensureLegacyWorktreesAdopted, reconcileWorktreeRegistry, registerWorktreeCleanupActions } from "./src/rooms/stability/server";
import { createStability } from "./src/rooms/stability/server";
import { isSandboxProject, lanePilotProjectOrNotice } from "./src/rooms/owner-waiting";
import { createAnalyzerRunner, cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees, closeAbandonedRuns, closeStaleRuns, conveyorState, coreHostsRequiredProvider, isTaskSatisfied, nextRunDeadline, registerWorktreeReleaseActions } from "./src/rooms/runs/server";
import { expireOverdueHandoffs } from "@lane-pilot/handoff";

import { createDeferrals, sdkOwnerMessagePort } from "./src/rooms/deferral/server";
import { createRollback } from "./src/rooms/rollback/server";
import { createBaseline } from "./src/rooms/baseline/server";
import { addRoad, doneRoad, getRoad, listRoad, parseLeadSettings, reopenRoad, taskWordPort } from "./src/rooms/lead/server";
import { loadEvalData, runMemoryEval } from "./src/rooms/memory-eval/server";
import type { StabilityPort } from "./src/rooms/contracts";
import { createIntakeTrain, createPhaseIntake, mountPhaseIntake } from "./src/rooms/workflow/server";
import { createGitWriter } from "./src/rooms/core/server";
import { registerConversationTools, registerQueueTool } from "./src/rooms/tasks/server";
import { mountOutbound, postEvent } from "./src/rooms/relay/server";
import { mountReports } from "./src/rooms/reports/server";
import { ownerWaitingRpc } from "./src/rooms/owner-waiting/server";
import { createMoney } from "./src/rooms/money";
import { mountPermits } from "./src/rooms/writer/server";
import { createFront } from "./src/rooms/front";
import { createBacklog, mountBacklog } from "./src/rooms/backlog/server";
import { createOwnerPresence, mountOwnerPresence } from "./src/rooms/owner-presence/server";
import { mountOutage, stampBeat } from "./src/rooms/outage/server";
import { buildCliInvocation } from "./src/rooms/writer";
import { argvValidationMap } from "./src/rooms/settings";
import { createPluginCheckers } from "./src/rooms/checkers/server";
import { createStageReturn } from "./src/rooms/stage-return/server";
import { pluginStopped } from "./src/rooms/contracts/errors";
import { registerRpc, ownerItemSweeps } from "./src/rooms/core/server/rpc";
import { mountOwnerBell } from "./src/rooms/owner-waiting/server";

import { registerLaneWorktreeProvider } from "./src/rooms/native-agent/server";
import { bindSubthreadProjectSettings, checkTickDeps } from "./src/rooms/platform/server";
import { clearDrainSnapshot, readDrainSnapshot } from "./src/rooms/stability/server";
import { tokenCursorRow, tokenDailyByModel } from "./src/rooms/usage/server";

import { onAttemptFinished, walkWriterChain } from "./src/rooms/writer/server";
import { createStageChildren, createQaStages, createWorkspaceStatus } from "./src/rooms/qa/server";
import { createDocs } from "./src/rooms/docs/server";
import { createMemoryStage, mountMemoryEmbeddings, mountThreadBlock } from "./src/rooms/memory/server";
import { mountErrands } from "./src/rooms/errands/server";
import { registerTools } from "./src/rooms/tools/server";
import { bindToolLocale, toolLocale } from "./src/rooms/platform/server";
import { createWriterHost } from "./src/rooms/writer/server";
import { createWriterState } from "./src/rooms/writer/server";
import { createWriterVerify } from "./src/rooms/writer/server";
import { createWriterFinish } from "./src/rooms/writer/server";
import { createWriterStart } from "./src/rooms/writer/server";
import { createAttemptReopen, createWriterReassign, recheckPlanFact, registerDispatchExecutors, restoreProviderBreaker, taskUsage } from "./src/rooms/writer/server";
import { stageHelperSettings } from "./src/rooms/settings/server";
import { createWorkflowEngine } from "./src/rooms/workflow/server";
import { architectStarter, createWorkflowLibrary } from "./src/rooms/workflow/server";
import { createWorkflowTriggersService } from "./src/rooms/workflow/server";
import { createScheduleService, ensureProjectSchedules, ensureSystemSchedules, startBoardClock, registerAgentRoutineActions, registerScheduleScriptActions, scheduleAgentApi } from "./src/rooms/schedule/server";
import { registerSpecialistActions } from "./src/rooms/critique/server";
import { knownOwnerLocale, relayFor } from "./src/rooms/relay/server";

import { memorySettingsFor } from "./src/rooms/memory/server";

import { installThreadSignals } from "@lane-pilot/thread-observe";
import { mountLifecycleEvents } from "./src/rooms/core/server/lifecycle-events";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { ActivationApi, AgentOpsApi } from "./src/rooms/contracts/agent-ops";
import type { MergeIntentsApi } from "./src/rooms/contracts/merge-intents";
import type { VerificationGatePort } from "./src/rooms/contracts/integration-gate";
import type { IsTaskSatisfied } from "./src/rooms/contracts";

import type { ReconcileApi } from "./src/rooms/stability/server";
import type { ArchitectApi, AttemptReopenApi, RecheckPlanFact, RunVerification, StageHelperSettings, TaskUsage, WorkflowEngineApi, WorkflowLibraryApi, WorkflowTriggersApi as WorkflowTriggersPort, WriterDispatchApi as WriterDispatchPort, WriterHostApi as WriterHostPort, WriterReassignApi, WriterStartApi as WriterStartPort, WriterStateApi as WriterStatePort } from "./src/rooms/platform/server";

export type { Services } from "./src/rooms/services";
import { rooms } from "./src/rooms/registry";
import type { Services } from "./src/rooms/services";

export { experimental_vkLifecycle } from "./src/rooms/native-install";

import { rpcContract } from "./src/rooms/core/server/plugin-contracts";
export { rpcContract };

/** Entry only: storage, the shared core, every module on one services bag, then the registrations. */
export default async function plugin(originalBb: BbPluginApi) {
  initRuntimeEnv({ log: (message) => originalBb.log.debug(message) });
  // Lane Pilot's own threads run on the standard service tier while the rest of bb keeps Fast: every spawn and every
  // send a module below makes goes through this one plugin-local view; the original api is untouched.
  const bb = withStandardServiceTier(originalBb, (request) =>
    lanePilotOwnedTarget(originalBb, (threadId) => openRunOfPmThread(db, threadId), request));
  const db = openDatabase(bb, { migrations: lanePilotMigrations, validateSetting: { validateSettingValue, validateSettingsObject, coupledSettingKeys, validateSettingChanges } });
  // BB's thread events wake the watchers of writers and helper threads; without them they poll as before.
  installThreadSignals(bb);
  const ctx = createCore(bb, db);
  bindToolLocale(bb, toolLocale(await knownOwnerLocale(bb)));
  // The register of deferrals: the first entries (skipped tests, old plan decisions) are written once; terms come only from the owner's messages.
  const deferrals = createDeferrals({ db, port: sdkOwnerMessagePort(bb), log: ctx.log });
  // A failing seed must not keep the plugin from starting: the register only adds the morning list.
  try { deferrals.seed(); } catch (cause) { bb.log.warn(`Lane Pilot: deferral seed skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const services = {} as Services;
  const rollback = createRollback(ctx, services);
  Object.assign(services, {
    buildCliInvocation: (input) => buildCliInvocation({ ...input, validate: argvValidationMap, isNativeKey: (key) => SETTINGS_REGISTRY.get(key)?.channel === "OWN" || key.startsWith("night_review.") }),
    taskWords: taskWordPort,
    laneProject: lanePilotProjectOrNotice,
    leadRoad: { addRoad, doneRoad, getRoad, listRoad, reopenRoad },
    memorySettings: memorySettingsFor,
    scheduleAgents: scheduleAgentApi(),
    memoryEval: { load: loadEvalData, run: runMemoryEval },
    onAttemptFinished,
  } satisfies Pick<Services, "buildCliInvocation" | "taskWords" | "laneProject" | "leadRoad" | "memorySettings" | "scheduleAgents" | "memoryEval" | "onAttemptFinished">);
  mountNativeWiring(ctx); bindSubthreadProjectSettings(ctx.bb, (pid) => loadProjectSettings(db, pid));
  services.tokenCursorRow = tokenCursorRow;
  // The writer pool must exist before project-git and dispatch are composed: the Git guard and live admission share it.
  Object.assign(services, createWriterState(ctx) satisfies WriterStatePort);
  const { writerSpawn, writerDispatch } = createGitWriter(ctx, services);
  Object.assign(
    services,
    createReconcile(ctx, services) satisfies ReconcileApi,
    createActivation(ctx, services) satisfies ActivationApi,
    createMergeIntentRecovery(ctx, services) satisfies MergeIntentsApi,
    {
      resolveIntegrationGate: gateResolverFor(ctx),
      placeEmployeeOn: (agentId: string, sources: Parameters<AgentOpsApi["placeEmployeeOn"]>[1]) => placeEmployeeOn(ctx.bb, agentId, sources),
      storeNativeSelection: (input: { projectId: string; agentId: string; parentRunId?: string }) => storeNativeSelection(ctx, input),
      compileEffectiveMainAgent,
      detectCompiledMainAgentCapability,
      pendingSwitch: (threadId: string) => pendingSwitch(ctx.bb.storage.kv, threadId),
    } satisfies AgentOpsApi & { resolveIntegrationGate: VerificationGatePort },
    { isTaskSatisfied } satisfies { isTaskSatisfied: IsTaskSatisfied },
    createWorkflowEngine(ctx, services) satisfies WorkflowEngineApi,
    createWorkflowTriggersService(ctx, services) satisfies WorkflowTriggersPort,
    writerSpawn,
    createWriterVerify(ctx, services) satisfies { runVerification: RunVerification },
    createWriterFinish(ctx, services),
    createWriterStart(ctx, services) satisfies WriterStartPort,
    writerDispatch satisfies WriterDispatchPort,
    createQaStages(ctx),
    createStageChildren(ctx),
    createDocs(ctx),
    createMemoryStage(ctx, services),
    createWorkspaceStatus(ctx),
    createWriterHost(ctx) satisfies WriterHostPort,
    // providerBreaker is another field of this bag: the canary reads it at call time through the thunk.
    // The readiness thunk does the same for the hold sources and the per-project writer chains, so the
    // «not green» answer names every blocked worker with its reason (SMA m_ac_pool_ready, m_not_green).
    { canary: createCanary(ctx, () => services.providerBreaker, async () => poolReadiness(
      listProjectsWithGlobalSettings(db).flatMap((projectId): PoolChain[] => {
        const config = loadPrototypeConfig(db, projectId);
        if (!config) return [];
        const settings = loadProjectSettings(db, projectId);
        const primary = {
          providerId: typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : config.writerProviderId,
          model: typeof settings["writer.model"] === "string" && settings["writer.model"] ? settings["writer.model"] as string : config.writerModel,
        };
        return [{ projectId, hostId: config.hostId, settings,
          members: writerFallbackChain(primary, writerFallbacks(settings), { providerId: config.pmProviderId, model: config.pmModel }) }];
      }),
      (members, input) => walkWriterChain(members, input, {
        breaker: services.providerBreaker, presence: services.ownerPresence, usage: services.providerUsage,
        coreHosts: (providerId: string) => coreHostsRequiredProvider(bb, providerId), log: ctx.log }))) },
    { memoryProbe: createMemoryProbe(ctx) },
    { ruleScan: createAnalyzerRunner(ctx) },
    { deferrals },
    // deferrals is another field of this bag: memoryConflicts reads it at call time through the thunk.
    { memoryConflicts: createMemoryConflicts({ db, deferrals: () => services.deferrals, log: ctx.log }) },
    rollback,
    { recoverRevertIntents: rollback.rollback.recoverRevertIntents },
    createBaseline(ctx, services),
    { architect: architectStarter(ctx, services) satisfies ArchitectApi },
    { workflowLibrary: createWorkflowLibrary(ctx, services) satisfies WorkflowLibraryApi },
    { recheckPlanFact: ((input: { projectId: string; runId: string; taskId: string; hostId: string }) => recheckPlanFact(ctx, input)) satisfies RecheckPlanFact },
    { taskUsage: taskUsage satisfies TaskUsage },
    { stageHelperSettings: stageHelperSettings satisfies StageHelperSettings },
    { attemptReopen: createAttemptReopen(ctx, services) satisfies AttemptReopenApi },
    { writerReassign: createWriterReassign(ctx) satisfies WriterReassignApi },
    createStageReturn(ctx, services),
    { phaseIntake: createPhaseIntake(ctx, createIntakeTrain(ctx, services)) },
    createMoney(ctx),
    createFront(ctx),
    createBacklog(ctx),
    createOwnerPresence(ctx),
    { checkers: createPluginCheckers(ctx) },
    createStability(ctx, services) satisfies { stability: StabilityPort },
    createScheduleService(ctx, services),
  );
  // Tick wiring (SMA m_tick_deps): every service the schedules ask for by name exists before the first tick;
  // the report stays on lp.tick-deps for inspection.
  { const tickDeps = checkTickDeps(services as unknown as Record<string, unknown>);
    if (tickDeps.missing.length) bb.log.error(`Lane Pilot tick deps missing: ${tickDeps.missing.join(", ")}`);
    await bb.storage.kv.set("lp.tick-deps", tickDeps).catch(() => undefined); }
  // The writer's `lp.*` executors (the task pipeline and its steps): writer registers them on the shared engine; workflow only mounts the delegates.
  registerDispatchExecutors(services.workflowEngine, ctx.bb, { services: services as never, ctx });
  await restoreProviderBreaker(bb.storage.kv as never, services.providerBreaker).catch(() => undefined);
  // The two code steps of `agent-routine`, the graph a schedule of kind agent runs (registered here: the schedule room imports the workflow room, not the other way).
  registerAgentRoutineActions(services.workflowEngine, ctx, services);
  registerScheduleScriptActions(services.workflowEngine, ctx);
  // The worktree cleanup is two Lane Pilot schedules on the board (graph lp.worktree-cleanup, docs/worktrees.md): its step, then the rows made once.
  registerWorktreeCleanupActions(services.workflowEngine, ctx, { cleanupStickyLaneWorktrees, cleanupFinishedAttemptEnvironments });
  // Unified post-merge landing suite (graph lp.landing-suite ← event lp.attempt.merged) and attempt worktree release (graph lp.worktree-release).
  registerLandingSuiteAction(services.workflowEngine, ctx, services);
  registerWorktreeReleaseActions(services.workflowEngine, ctx);
  void ensureSystemSchedules({ list: () => services.schedules.store.list(), save: (raw, by) => services.schedules.save(raw, by), kv: bb.storage.kv, log: ctx.log })
    .catch((cause: unknown) => ctx.log(`Lane Pilot system schedules not made: ${cause instanceof Error ? cause.message : String(cause)}`));
  void (async () => {
    const listed = await bb.sdk.projects.list({ includePersonal: true }).catch(() => []);
    const projectIds = listed.map((p) => p.id).filter((id) => Boolean(id) && id !== GLOBAL_SETTINGS_PROJECT_ID && !isSandboxProject(id));
    const leadCron = parseLeadSettings(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID)).tickCron;
    await ensureProjectSchedules({ list: () => services.schedules.store.list(), save: (raw, by) => services.schedules.save(raw, by), kv: bb.storage.kv, log: ctx.log }, projectIds, { leadCron });
  })().catch((cause: unknown) => ctx.log(`Lane Pilot project schedules not made: ${cause instanceof Error ? cause.message : String(cause)}`));
  // The brief step of `specialist`, the graph behind lane_pilot_specialist.
  registerSpecialistActions(services.workflowEngine, ctx);
  // Rooms in src/rooms/registry.ts mount their own schedules, listeners and graph steps here, once the services bag is complete.
  for (const room of rooms) await room.startup?.(ctx, services);
  mountPhaseIntake(ctx, services.phaseIntake);
  mountLifecycleEvents(ctx, { onQueued: (name, entry) => {
    const id = entry && typeof entry === "object" ? Reflect.get(entry, "id") : undefined;
    if (typeof id === "string") return relayFor(ctx).queueEvent(name, id).then(() => undefined);
  }, onEnvironmentRemoved: async (attemptIds, environmentId) => {
    const result = await services.resumeOrphans(undefined, attemptIds);
    ctx.log(`Lane Pilot: environment ${environmentId} removed — resumeOrphans: ${result.resumed.length} resumed, ${result.skipped.length} skipped, ${result.finished.length} finished`);
  } });
  registerRpc(ctx, services, rpcContract);
  mountCanary(ctx, services.canary, {
    engine: services.workflowEngine,
    emitEvent: services.workflowTriggers.emitEvent,
    onAttemptFinished: services.onAttemptFinished,
  });
  // Each task that ends is posted to the project's webhook (events.webhook_url) with nine fields; the UI version grows with every attempt change.
  mountOutbound(ctx);
  // Per-project calendar rows (lp.backlog-scan) invoke the workflow executor with force for each scheduled project.
  mountBacklog(ctx, services.backlog, services.workflowEngine);
  // Where the owner typed in a BB thread Lane Pilot did not start; writers keep off that provider for ten minutes.
  mountOwnerPresence(ctx, services.ownerPresence);
  // A gap in the heartbeat longer than 5 minutes is an outage on record; then one beat a minute.
  await mountOutage(ctx).catch((cause: unknown) => bb.log.warn(`Lane Pilot: outage record skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  // Every ordinary thread of a project gets the L1 memory showcase (M2); PM and plugin threads are left out inside.
  mountThreadBlock(ctx);
  mountMemoryEmbeddings(ctx, services);
  registerQueueTool(
    ctx,
    services.taskWords,
    (key, payload) => services.workflowEngine.wake(LP_EVENTS.WRITER_ANSWERED, key, payload),
    (projectId, taskId, payload) => Promise.all([
      services.workflowEngine.wake(LP_EVENTS.TASK_SETTLED, taskId, payload),
      services.workflowEngine.wake(LP_EVENTS.TASK_SETTLED, projectId, payload),
    ]),
  );
  registerConversationTools(ctx, { spendByModel: (projectId, day) => tokenDailyByModel(ctx.db, projectId, day) });
  mountPermits(ctx);
  // The bell «awaits a decision»: event-driven browser notification with durable quiet-hours & daily-cap wait.
  mountOwnerBell(ctx, ownerItemSweeps(services), {
    engine: services.workflowEngine,
    emitEvent: services.workflowTriggers.emitEvent,
  });
  // The owner's Telegram topic: «Ждут владельца» and daily digest run on SYSTEM_SCHEDULES via workflow actions.
  const waiting = ownerWaitingRpc(ctx.db, ownerItemSweeps(services), ctx.log, postEvent);
  mountReports(ctx, {
    engine: services.workflowEngine,
    digest: () => waiting.owner_waiting_digest(),
    ack: (keys) => waiting.owner_waiting_ack({ keys }),
  });
  // The errand starter the PM tools and the scheduled errands share: a services field like the rest, built here — not inside registerTools.
  services.errands = mountErrands(ctx, services);
  // lane_pilot_learned members are family members from other rooms: passed as contributors,
  // the fold mounts them itself, so their call order against registerTools does not matter.
  registerTools(ctx, services, rooms.flatMap((room) => (room.tools ? [() => room.tools!(ctx, services)] : [])));
  registerCli(ctx, services, lanePilotMigrations);
  // Writer attempts get BB environments of this provider unless workspace.provider is off; a BB without the API
  // registers nothing and every attempt keeps the old worktree path.
  registerLaneWorktreeProvider(ctx);
  const sweepRuns = (signal?: AbortSignal) => Promise.resolve().then(async () => {
    const closed = await closeAbandonedRuns(bb, db, Date.now(), signal);
    if (closed.length) bb.log.info(`Lane Pilot closed ${closed.length} runs whose PM chat is gone: ${closed.join(", ")}`);
    const stale = await closeStaleRuns(bb, db, Date.now(), signal);
    if (stale.length) bb.log.info(`Lane Pilot closed ${stale.length} runs past their lifetime: ${stale.join(", ")}`);
  }).catch((cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot run sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const snapshotWorktree = async (hostId: string, worktreePath: string, name: string) =>
    await ctx.host.call("gitWorktreeSnapshot", { requestedHostId:hostId, worktreePath, name }, { hostId, timeoutMs:300_000 });
  const sweepEnvironments = (signal?: AbortSignal) => cleanupFinishedAttemptEnvironments(bb, db, snapshotWorktree, Date.now(), signal).then((removed) => {
    if (removed.length) bb.log.info(`Lane Pilot released ${removed.length} worktree(s) of finished attempts`);
  }, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot worktree sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const releasedLaneWorktrees = new Set<string>();
  const removeLaneWorktree = async (hostId:string, basePath:string, worktreePath:string) =>
    (await ctx.host.call("gitRemoveWorktree", { requestedHostId:hostId, basePath, worktreePath, release:true }, { hostId, timeoutMs:300_000 })).removed;
  const taskReconcile = createTaskReconcile(ctx, services);
  // Startup recovery runs one ordered `reconcile(db, now)` pass at plugin ready (no periodic task-reconcile, attempt-worktree-sweep, or runs-sweep loops).
  bb.background.service("startup-recovery", {
    async start(signal) {
      // The recovery runs beside the service, not inside it: a reload must stop the service at once, and a step that
      // waits on host calls (worktree snapshots, a deploy drain) kept it running past the reload, which left the
      // plugin «degraded: service startup-recovery did not stop» (2026-10-04). Each step checks whether to go on.
      const step = async (name:string, work:() => Promise<unknown> | unknown) => {
        if (signal.aborted || ctx.isDisposed()) return;
        try { await work(); } catch (cause) { bb.log.warn(`Lane Pilot ${name} skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
      };
      void (async () => {
        // VK core: why this instance started and whether the one before it drained (read here, not in the factory,
        // where `afterDrain` is still false). Resuming stages and writers runs in every case. What a clean drain
        // changes is the optional startup scans below.
        const vk = (bb as unknown as { vk?: { startReason?: string; afterDrain?: boolean } }).vk;
        if (vk?.startReason) {
          bb.log.info(`Lane Pilot startup recovery: ${vk.startReason}${vk.afterDrain ? ", after a clean drain" : ""}`);
          await step("drain snapshot", async () => {
            const snapshot = await readDrainSnapshot(bb.storage.kv);
            if (snapshot) {
              bb.log.info(`Lane Pilot drain before this start: ${snapshot.action ?? "?"}, ${snapshot.clean ? "nothing in flight" : `${snapshot.inFlight?.length ?? 0} call(s) cut`}`);
              await clearDrainSnapshot(bb.storage.kv);
            }
          });
        }
        // A reload drops the loops that watch background helpers; the stages are idempotent and find their child thread
        // again. Started in the factory, their first host call failed with «unavailable during factory registration».
        await step("resume of background helpers", () => {
          // The after-acceptance graph run of a task is keyed by the task: a run the reload cut off is picked up again, one that never existed starts.
          for (const stage of listUnfinishedStages(db, ["memory-maintenance"])) {
            services.startAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
          }
        });
        await step("restore of the breakers", () => services.stability.restoreBreakers());
        await step("workflow trigger sync", () => services.workflowTriggers.syncTriggers());
        // A version's first start is its deploy time: the canary counts the attempts from here.
        await step("canary start", () => services.canary.noteStart());
        // SMA m_say_pipeline: a conveyor left off is said once at the start, with the way out; the work waiting behind it is no surprise.
        await step("conveyor start line", async () => { const line = conveyorStartLine(await conveyorState(bb.storage.kv as never)); if (line) bb.log.warn(line); });
        await taskReconcile.reconcile(db, Date.now(), { step, afterResume: async () => {
          await step("handoff expiry", () => {
            const expired = expireOverdueHandoffs(db);
            if (expired.length) bb.log.info(`Lane Pilot handoffs expired: ${expired.join(", ")}`);
          });
          await step("run sweep", () => sweepRuns(signal));
          await step("worktree sweep", async () => {
            await ensureLegacyWorktreesAdopted(ctx);
            await reconcileWorktreeRegistry(ctx);
            await sweepEnvironments(signal);
            const removed = await cleanupStickyLaneWorktrees(db, removeLaneWorktree, releasedLaneWorktrees, Date.now(), signal);
            if (removed.length) bb.log.info(`Lane Pilot released ${removed.length} area worktree(s) after their sticky window`);
          });
        } });
        // SMA m_confirm_later: a stop the start-up resume could not see is asked again about two minutes in.
        const cancelRecheck = setTimeout(() => { void step("cancel re-check", () => services.recheckCancels()); }, 120_000);
        signal.addEventListener("abort", () => clearTimeout(cancelRecheck), { once: true });
        await step("recovery of lost owner questions", () => ctx.ownerAsk.recoverLost());
        await step("browser check recovery", () => {
          const adopted = services.resumeBrowserQaThreads();
          if (adopted) bb.log.info(`Lane Pilot adopted ${adopted} browser check(s) left running by a reload`);
        });
      })();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    },
  });
  await startBoardClock(ctx, services, (at) => {
    void stampBeat(ctx, at);
    const due = nextRunDeadline(db);
    if (due !== null && at >= due) void sweepRuns();
  });
  bb.log.info("Lane Pilot PM-to-writer pipeline loaded");
}
