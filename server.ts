import { listUnfinishedStages, openDatabase } from "./src/database";
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
import { createRuleScan } from "./src/server/rule-scan";
import { cleanupFinishedAttemptEnvironments, closeAbandonedRuns } from "./src/server/run-finish";
import { registerRpc } from "./src/server/rpc";
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
  }, (cause) => bb.log.warn(`Lane Pilot worktree sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  bb.background.schedule("attempt-worktree-sweep", "*/10 * * * *", sweepEnvironments);
  const sweepParked = () => services.stability.sweep().then(() => undefined,
    (cause) => bb.log.warn(`Lane Pilot parked-task sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  bb.background.schedule("parked-task-sweep", "*/5 * * * *", sweepParked);
  // Recovery reads writer workspaces through the host, which is not callable while the factory registers; a service
  // starts once loading is done. (Run in the factory, a finished writer was failed with «host plugin calls are
  // unavailable during factory registration».)
  bb.background.service("startup-recovery", {
    async start(signal) {
      await services.resumeOrphans().catch((cause) => {
        bb.log.warn(`Lane Pilot resume on start skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
      await sweepRuns();
      await sweepEnvironments();
      await services.stability.adoptBlockedByFaults().catch((cause) => bb.log.warn(`Lane Pilot parking of blocked tasks skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
      await sweepParked();
      try {
        const closed = closeOrphanWriterStages(db, services.activeWriterTasks);
        if (closed) bb.log.info(`Lane Pilot closed ${closed} writer stage(s) left open after their task ended`);
      } catch (cause) { bb.log.warn(`Lane Pilot stage cleanup skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
      try {
        const adopted = services.resumeBrowserQaThreads();
        if (adopted) bb.log.info(`Lane Pilot adopted ${adopted} browser check(s) left running by a reload`);
      } catch (cause) { bb.log.warn(`Lane Pilot browser check recovery skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    },
  });
  bb.background.schedule("runs-sweep", "*/15 * * * *", sweepRuns);
  // A reload drops the loops that watch background helpers; the stages are idempotent and find their child thread again.
  for (const stage of listUnfinishedStages(db, ["memory-maintenance", "project-life"])) {
    if (stage.stageId === "memory-maintenance") services.maintainMemoryAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
    else services.maintainProjectLifeAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
  }
  bb.log.info("Lane Pilot PM-to-writer pipeline loaded");
}
