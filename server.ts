import { listUnfinishedStages, openDatabase } from "./src/database";
import { createActivation } from "./src/server/activation";
import { registerCli } from "./src/server/cli";
import { createCore } from "./src/server/core";
import { createDocsNightly } from "./src/server/docs-nightly";
import { mountNativeWiring } from "./src/server/native-wiring";
import { createProbes } from "./src/server/probes";
import { createReconcile } from "./src/server/reconcile";
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
import { createWriterRun } from "./src/server/writer-run";
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
    createWriterRun(ctx, services),
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
  );
  registerRpc(ctx, services);
  registerTools(ctx, services);
  registerCli(ctx, services);
  await services.resumeOrphans().catch((cause) => {
    bb.log.warn(`Lane Pilot resume on start skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
  // A reload drops the loops that watch background helpers; the stages are idempotent and find their child thread again.
  for (const stage of listUnfinishedStages(db, ["memory-maintenance", "project-life"])) {
    if (stage.stageId === "memory-maintenance") services.maintainMemoryAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
    else services.maintainProjectLifeAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
  }
  bb.log.info("Lane Pilot PM-to-writer pipeline loaded");
}
