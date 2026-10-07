import { getRunSettingsScopes, listOpenAttempts, listUnfinishedStages, loadProjectSettings, openDatabase } from "./src/database";
import { closeOrphanWriterStages } from "./src/server/stage-records";
import { createActivation } from "./src/server/activation";
import { registerCli } from "./src/server/cli";
import { createCore } from "./src/server/core";
import { createCouncil } from "./src/server/council";
import { createDocsNightly } from "./src/server/docs-nightly";
import { mountNativeWiring } from "./src/server/native-wiring";
import { createProbes } from "./src/server/probes";
import { createReconcile } from "./src/server/reconcile";
import { createStability } from "./src/server/stability";
import { adoptWaitingRules } from "./src/server/insights";
import { createRuleScan } from "./src/server/rule-scan";
import { cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees, closeAbandonedRuns, pluginStopped } from "./src/server/run-finish";
import { registerRpc } from "./src/server/rpc";
import { scheduleIsolated } from "./src/server/schedules";
import { DRAIN_SNAPSHOT_KEY } from "./src/server/deploy-drain";
import { DEFAULT_SILENCE_NUDGE_MIN, sweepWriterSilence } from "./src/server/writer-silence";
import type { Services } from "./src/server/services";
import { createStageChildren } from "./src/server/stages/children";
import { createDocsStage } from "./src/server/stages/docs";
import { createMemoryStage } from "./src/server/stages/memory";
import { createNightStages } from "./src/server/stages/night";
import { createOnboardingStage } from "./src/server/stages/onboarding";
import { createProjectLifeStage } from "./src/server/stages/project-life";
import { createQaStages } from "./src/server/stages/qa";
import { registerTools } from "./src/server/tools";
import { createWriterHost } from "./src/server/writer-host";
import { createWriterState } from "./src/server/writer/state";
import { createWriterSpawn } from "./src/server/writer/spawn";
import { createWriterVerify } from "./src/server/writer/verify";
import { createWriterFinish } from "./src/server/writer/finish";
import { createWriterStart } from "./src/server/writer/start";
import { createWriterDispatch } from "./src/server/writer/dispatch";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export { experimental_vkLifecycle } from "./src/native-install-lifecycle";

export { rpcContract } from "./src/contracts";

/** Entry only: storage, the shared core, every module on one services bag, then the registrations. */
export default async function plugin(bb: BbPluginApi) {
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const services = {} as Services;
  mountNativeWiring(ctx);
  Object.assign(
    services,
    createReconcile(ctx, services),
    createActivation(ctx, services),
    createWriterState(ctx),
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
    { ruleScan: createRuleScan(ctx, services) },
    createStability(ctx, services),
  );
  registerRpc(ctx, services);
  registerTools(ctx, services);
  registerCli(ctx, services);
  const sweepRuns = () => closeAbandonedRuns(bb, db).then((closed) => {
    if (closed.length) bb.log.info(`Lane Pilot closed ${closed.length} runs whose PM chat is gone: ${closed.join(", ")}`);
  }, (cause) => bb.log.warn(`Lane Pilot run sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const snapshotWorktree = async (hostId: string, worktreePath: string, name: string) =>
    await ctx.host.call("gitWorktreeSnapshot", { requestedHostId:hostId, worktreePath, name }, { hostId, timeoutMs:300_000 });
  const sweepEnvironments = () => cleanupFinishedAttemptEnvironments(bb, db, snapshotWorktree).then((removed) => {
    if (removed.length) bb.log.info(`Lane Pilot released ${removed.length} worktree(s) of finished attempts`);
  }, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot worktree sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const releasedLaneWorktrees = new Set<string>();
  const removeLaneWorktree = async (hostId:string, basePath:string, worktreePath:string) =>
    (await ctx.host.call("gitRemoveWorktree", { requestedHostId:hostId, basePath, worktreePath }, { hostId, timeoutMs:60_000 })).removed;
  scheduleIsolated(bb, "attempt-worktree-sweep", "*/10 * * * *", () => Promise.all([sweepEnvironments(),
    cleanupStickyLaneWorktrees(db, removeLaneWorktree, releasedLaneWorktrees).then((removed) => {
      if (removed.length) bb.log.info(`Lane Pilot released ${removed.length} area worktree(s) after their sticky window`);
    }, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot area worktree sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`))]).then(() => undefined), { timeoutMs: 20 * 60_000 });
  const sweepParked = () => services.stability.sweep().then(() => undefined,
    (cause) => bb.log.warn(`Lane Pilot parked-task sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  scheduleIsolated(bb, "parked-task-sweep", "*/5 * * * *", sweepParked, { timeoutMs: 10 * 60_000 });
  const sweepSilentWriters = () => sweepWriterSilence({
    bb, getThread:(threadId) => ctx.getThreadBounded(threadId), isDisposed:ctx.isDisposed, log:(line) => bb.log.info(line),
    openAttempts:() => listOpenAttempts(db),
    silenceMinutes:(projectId, runId) => {
      const minutes = Number(loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId))["writer.silence_nudge_min"]);
      return Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_SILENCE_NUDGE_MIN;
    },
  }).then(() => undefined, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot writer silence sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  scheduleIsolated(bb, "writer-silence-sweep", "*/5 * * * *", sweepSilentWriters, { timeoutMs: 10 * 60_000 });
  // Mondays 05:00: away from the nightly docs (03:00) and rules (03:30) passes.
  bb.background.schedule("stability-drill", "0 5 * * 1", () => services.stability.drill().then(() => undefined,
    (cause) => bb.log.warn(`Lane Pilot fire drill skipped: ${cause instanceof Error ? cause.message : String(cause)}`)));
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
        // where `afterDrain` is still false). The recovery below runs once, from this service, in every case; a
        // drained reload only says what the old instance left (stages and checkout writes were let finish).
        const vk = (bb as unknown as { vk?: { startReason?: string; afterDrain?: boolean } }).vk;
        if (vk?.startReason) {
          bb.log.info(`Lane Pilot startup recovery: ${vk.startReason}${vk.afterDrain ? ", after a clean drain" : ""}`);
          await step("drain snapshot", async () => {
            const snapshot = await bb.storage.kv.get<{ action?: string; clean?: boolean; inFlight?: unknown[] }>(DRAIN_SNAPSHOT_KEY);
            if (snapshot) { bb.log.info(`Lane Pilot drain before this start: ${snapshot.action ?? "?"}, ${snapshot.clean ? "nothing in flight" : `${snapshot.inFlight?.length ?? 0} call(s) cut`}`); await bb.storage.kv.delete(DRAIN_SNAPSHOT_KEY); }
          });
        }
        // A reload drops the loops that watch background helpers; the stages are idempotent and find their child thread
        // again. Started in the factory, their first host call failed with «unavailable during factory registration».
        await step("resume of background helpers", () => {
          for (const stage of listUnfinishedStages(db, ["memory-maintenance", "project-life"])) {
            if (stage.stageId === "memory-maintenance") services.maintainMemoryAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
            else services.maintainProjectLifeAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
          }
        });
        await step("resume on start", () => services.resumeOrphans());
        await step("run sweep", sweepRuns);
        await step("worktree sweep", sweepEnvironments);
        await step("parking of blocked tasks", () => services.stability.adoptBlockedByFaults());
        await step("parked-task sweep", sweepParked);
        await step("adoption of waiting rules", () => {
          const adopted = adoptWaitingRules(db);
          if (adopted) bb.log.info(`Lane Pilot put ${adopted} waiting rule(s) on trial`);
        });
        await step("stage cleanup", () => {
          const closed = closeOrphanWriterStages(db, services.activeWriterTasks);
          if (closed) bb.log.info(`Lane Pilot closed ${closed} writer stage(s) left open after their task ended`);
        });
        await step("browser check recovery", () => {
          const adopted = services.resumeBrowserQaThreads();
          if (adopted) bb.log.info(`Lane Pilot adopted ${adopted} browser check(s) left running by a reload`);
        });
      })();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    },
  });
  bb.background.schedule("runs-sweep", "*/15 * * * *", sweepRuns);
  bb.log.info("Lane Pilot PM-to-writer pipeline loaded");
}
