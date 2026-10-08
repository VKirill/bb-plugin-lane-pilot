import { getRunSettingsScopes, listOpenAttempts, listUnfinishedStages, loadProjectSettings, openDatabase } from "./src/database";
import { createTaskReconcile } from "./src/server/task-reconcile";
import { createActivation } from "./src/server/activation";
import { registerCli } from "./src/rooms/tools/server/cli";
import { createCore } from "./src/server/core";
import { createCanary, mountCanary } from "./src/rooms/stability/server/canary";
import { createCouncil } from "./src/rooms/council/server/council";
import { createDocsNightly } from "./src/rooms/docs/server/docs-nightly";
import { mountNativeWiring } from "./src/server/native-wiring";
import { createProbes } from "./src/rooms/stability/server/probes";
import { createReconcile } from "./src/rooms/stability/server/reconcile";
import { createStability } from "./src/rooms/stability/server/stability";
import { adoptWaitingRules } from "./src/rooms/self-repair/server/insights";
import { createRuleScan } from "./src/rooms/self-repair/server/rule-scan";
import { cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees, closeAbandonedRuns, pluginStopped } from "./src/server/run-finish";
import { registerRpc } from "./src/server/rpc";
import { mountAnamnesis } from "./src/rooms/anamnesis/wiring";
import { registerLaneWorktreeProvider } from "./src/server/environment-provider";
import { scheduleIsolated } from "./src/server/schedules";
import { DRAIN_SNAPSHOT_KEY, skipRedundantStartupScans } from "./src/rooms/stability/server/deploy-drain";
import { DEFAULT_SILENCE_NUDGE_MIN, sweepWriterSilence } from "./src/server/writer-silence";
import { threadPendingInteractions } from "./src/rooms/relay/server/owner-ask";
import type { Services } from "./src/server/services";
import { createStageChildren } from "./src/rooms/qa/server/children";
import { createDocsStage } from "./src/rooms/docs/server/docs";
import { createMemoryStage } from "./src/rooms/memory/server/memory";
import { createNightStages } from "./src/rooms/night/server/night";
import { createOnboardingStage } from "./src/rooms/project-life/server/onboarding";
import { createProjectLifeStage } from "./src/rooms/project-life/server/project-life";
import { createQaStages } from "./src/rooms/qa/server/qa";
import { registerTools } from "./src/rooms/tools/server/tools";
import { bindToolLocale, toolLocale } from "./src/rooms/tools/server/tool-presentation";
import { createWriterHost } from "./src/server/writer-host";
import { createWriterState } from "./src/server/writer/state";
import { createWriterSpawn } from "./src/server/writer/spawn";
import { createWriterVerify } from "./src/server/writer/verify";
import { createWriterFinish } from "./src/server/writer/finish";
import { createWriterStart } from "./src/server/writer/start";
import { createWriterDispatch } from "./src/server/writer/dispatch";
import { createWorkflowEngine } from "./src/server/workflow";
import { createWorkflowTriggersService } from "./src/server/workflow-triggers-live";
import { createScheduleService } from "./src/rooms/schedule/server/schedule-service";
import { relayFor } from "./src/rooms/relay/server/relay";
import { mountLearning } from "./src/rooms/learning/service";
import { installThreadSignals } from "@lane-pilot/thread-observe";
import { mountLifecycleEvents } from "./src/server/lifecycle-events";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export { experimental_vkLifecycle } from "./src/rooms/native-install/native-install-lifecycle";

export { rpcContract } from "./src/contracts";

/** Entry only: storage, the shared core, every module on one services bag, then the registrations. */
export default async function plugin(bb: BbPluginApi) {
  const db = openDatabase(bb);
  // BB's thread events wake the watchers of writers and helper threads; without them they poll as before.
  installThreadSignals(bb);
  const ctx = createCore(bb, db);
  bindToolLocale(bb, await toolLocale(bb));
  const services = {} as Services;
  mountNativeWiring(ctx);
  Object.assign(
    services,
    createReconcile(ctx, services),
    createActivation(ctx, services),
    createWriterState(ctx),
    createWorkflowEngine(ctx, services),
    createWorkflowTriggersService(ctx, services),
    createWriterSpawn(ctx, services),
    createWriterVerify(ctx, services),
    createWriterFinish(ctx, services),
    createWriterStart(ctx, services),
    createWriterDispatch(ctx, services),
    createQaStages(ctx),
    createStageChildren(ctx),
    createDocsStage(ctx, services),
    createOnboardingStage(ctx, services),
    createMemoryStage(ctx, services),
    createProjectLifeStage(ctx, services),
    createNightStages(ctx, services),
    createDocsNightly(ctx, services),
    createProbes(ctx, services),
    createWriterHost(ctx),
    { council: createCouncil(ctx) },
    { canary: createCanary(ctx) },
    { ruleScan: createRuleScan(ctx, services) },
    createStability(ctx, services),
    createScheduleService(ctx, services),
  );
  mountLifecycleEvents(ctx, { onQueued: (name, entry) => {
    const id = entry && typeof entry === "object" ? Reflect.get(entry, "id") : undefined;
    if (typeof id === "string") return relayFor(ctx).queueEvent(name, id).then(() => undefined);
  } });
  registerRpc(ctx, services);
  mountCanary(ctx, services.canary);
  // Learning from the owner's messages (src/learning): registers its PM tool before the tool families fold, so it comes first.
  mountLearning(ctx, services);
  registerTools(ctx, services);
  registerCli(ctx, services);
  // What Lane Pilot learns about its owner by itself (the daily pass and new messages); inert until the owner switches it on.
  mountAnamnesis(ctx);
  // Writer attempts get BB environments of this provider unless workspace.provider is off; a BB without the API
  // registers nothing and every attempt keeps the old worktree path.
  registerLaneWorktreeProvider(ctx);
  const sweepRuns = (signal?: AbortSignal) => closeAbandonedRuns(bb, db, Date.now(), signal).then((closed) => {
    if (closed.length) bb.log.info(`Lane Pilot closed ${closed.length} runs whose PM chat is gone: ${closed.join(", ")}`);
  }, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot run sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const snapshotWorktree = async (hostId: string, worktreePath: string, name: string) =>
    await ctx.host.call("gitWorktreeSnapshot", { requestedHostId:hostId, worktreePath, name }, { hostId, timeoutMs:300_000 });
  const sweepEnvironments = (signal?: AbortSignal) => cleanupFinishedAttemptEnvironments(bb, db, snapshotWorktree, Date.now(), signal).then((removed) => {
    if (removed.length) bb.log.info(`Lane Pilot released ${removed.length} worktree(s) of finished attempts`);
  }, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot worktree sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const releasedLaneWorktrees = new Set<string>();
  const removeLaneWorktree = async (hostId:string, basePath:string, worktreePath:string) =>
    (await ctx.host.call("gitRemoveWorktree", { requestedHostId:hostId, basePath, worktreePath }, { hostId, timeoutMs:60_000 })).removed;
  scheduleIsolated(bb, "attempt-worktree-sweep", "*/10 * * * *", (signal) => Promise.all([sweepEnvironments(signal),
    cleanupStickyLaneWorktrees(db, removeLaneWorktree, releasedLaneWorktrees, Date.now(), signal).then((removed) => {
      if (removed.length) bb.log.info(`Lane Pilot released ${removed.length} area worktree(s) after their sticky window`);
    }, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot area worktree sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`))]).then(() => undefined), { timeoutMs: 20 * 60_000 });
  const taskReconcile = createTaskReconcile(ctx, services);
  // The same ordered pass as at start-up, minus the resume of attempts in flight: a lost retry or a landed merge is found
  // within five minutes, not at the next reload.
  scheduleIsolated(bb, "task-reconcile", "*/5 * * * *", (signal) => taskReconcile.reconcileTasks({ phase: "periodic",
    step: async (name, work) => {
      if (signal?.aborted || ctx.isDisposed()) return;
      try { await work(); } catch (cause) { bb.log.warn(`Lane Pilot ${name} skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
    } }), { timeoutMs: 10 * 60_000 });
  const sweepSilentWriters = (signal?: AbortSignal) => sweepWriterSilence({
    bb, signal, getThread:(threadId) => ctx.getThreadBounded(threadId), isDisposed:ctx.isDisposed, log:(line) => bb.log.info(line),
    waitingForOwner:async (threadId) => await ctx.ownerAsk.pending(threadId) || (await threadPendingInteractions(bb, threadId)) > 0,
    openAttempts:() => listOpenAttempts(db),
    silenceMinutes:(projectId, runId) => {
      const minutes = Number(loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId))["writer.silence_nudge_min"]);
      return Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_SILENCE_NUDGE_MIN;
    },
  }).then(() => undefined, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot writer silence sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  scheduleIsolated(bb, "writer-silence-sweep", "*/5 * * * *", sweepSilentWriters, { timeoutMs: 10 * 60_000 });
  // Mondays 05:00: away from the nightly docs (03:00) and rules (03:30) passes.
  // 05:10, not 05:00: BB starts at most 8 isolated runs at once and the hour start already has several.
  scheduleIsolated(bb, "stability-drill", "10 5 * * 1", (signal) => services.stability.drill(Date.now(), signal).then(() => undefined,
    (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot fire drill skipped: ${cause instanceof Error ? cause.message : String(cause)}`)), { timeoutMs: 30 * 60_000 });
  // Recovery reads writer workspaces through the host, which is not callable while the factory registers; a service
  // starts once loading is done. (Run in the factory, a finished writer was failed with «host plugin calls are
  // unavailable during factory registration».)
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
        // changes is the three periodic scans below: the old instance finished its checkout writes and checks and
        // left nothing half done for them to find, and they run again within 5-15 minutes on their own schedules.
        // «Clean» is the old instance's own snapshot (in flight at its deadline is not clean), not only `afterDrain`.
        const vk = (bb as unknown as { vk?: { startReason?: string; afterDrain?: boolean } }).vk;
        let skipScans = false;
        if (vk?.startReason) {
          bb.log.info(`Lane Pilot startup recovery: ${vk.startReason}${vk.afterDrain ? ", after a clean drain" : ""}`);
          await step("drain snapshot", async () => {
            const snapshot = await bb.storage.kv.get<{ action?: string; clean?: boolean; inFlight?: unknown[] }>(DRAIN_SNAPSHOT_KEY);
            if (snapshot) {
              bb.log.info(`Lane Pilot drain before this start: ${snapshot.action ?? "?"}, ${snapshot.clean ? "nothing in flight" : `${snapshot.inFlight?.length ?? 0} call(s) cut`}`);
              skipScans = skipRedundantStartupScans(vk, snapshot);
              await bb.storage.kv.delete(DRAIN_SNAPSHOT_KEY);
            }
          });
          if (skipScans) bb.log.info("Lane Pilot startup recovery: run, worktree and parked-task scans left to their schedules after a clean drain");
        }
        // A reload drops the loops that watch background helpers; the stages are idempotent and find their child thread
        // again. Started in the factory, their first host call failed with «unavailable during factory registration».
        await step("resume of background helpers", () => {
          for (const stage of listUnfinishedStages(db, ["memory-maintenance", "project-life"])) {
            if (stage.stageId === "memory-maintenance") services.maintainMemoryAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
            else services.maintainProjectLifeAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
          }
        });
        await step("restore of the breakers", () => services.stability.restoreBreakers());
        // A version's first start is its deploy time: the canary counts the attempts from here.
        await step("canary start", () => services.canary.noteStart());
        await taskReconcile.reconcileTasks({ phase: "startup", step, afterResume: async () => {
          if (!skipScans) await step("run sweep", sweepRuns);
          if (!skipScans) await step("worktree sweep", sweepEnvironments);
        } });
        await step("adoption of waiting rules", () => {
          const adopted = adoptWaitingRules(db);
          if (adopted) bb.log.info(`Lane Pilot put ${adopted} waiting rule(s) on trial`);
        });
        await step("recovery of lost owner questions", () => ctx.ownerAsk.recoverLost());
        await step("browser check recovery", () => {
          const adopted = services.resumeBrowserQaThreads();
          if (adopted) bb.log.info(`Lane Pilot adopted ${adopted} browser check(s) left running by a reload`);
        });
      })();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    },
  });
  // Schedules of workflows follow their files: a workflow unpublished or edited outside the tab loses or changes its automation within the hour.
  scheduleIsolated(bb, "workflow-schedules", "23 * * * *", () => { for (const projectId of services.workflowTriggers.scheduledProjects()) services.workflowTriggers.syncSoon(projectId); }, { timeoutMs: 60_000 });
  scheduleIsolated(bb, "runs-sweep", "2,17,32,47 * * * *", sweepRuns, { timeoutMs: 10 * 60_000 });
  // The schedule board (src/schedule): every minute the due fire times become runs (keyed by schedule and time, so a repeated tick adds
  // nothing) and the runs are started and watched for up to 50 s. Runs live in the database: a reload loses no tick and no run.
  scheduleIsolated(bb, "schedule-board-tick", "* * * * *", (signal) => services.schedules.tick(signal).then(() => undefined,
    (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot schedule tick skipped: ${cause instanceof Error ? cause.message : String(cause)}`)), { timeoutMs: 2 * 60_000 });
  bb.log.info("Lane Pilot PM-to-writer pipeline loaded");
}
