import { scheduleIsolated } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { createConfig } from "./config";
import { createEvidence } from "./evidence-collect";
import { createAttemptTrees } from "./attempt";
import { createSessions } from "./sessions";
import { createEdit } from "./edit";
import { createReflect } from "./reflect";
import { createNightly } from "./nightly";
import type { Services } from "./contract";

export { HARNESS_EDIT_WORKFLOW, HARNESS_REFLECT_WORKFLOW, HARNESS_TUNING } from "./contract";
export type { GraphHelperFn, HarnessStep, Services } from "./contract";
export { HARNESS_DEFAULTS, HARNESS_ROLES, roleSelection } from "./config";
export type { HarnessConfig, HarnessRole, ModelSelection } from "./config";
export { HARNESS_DIR, briefParts, checkCommands, hooksSettings, inferForm } from "./parts";
export type { BriefParts } from "./parts";
export { SESSION_RETRY_DELAY_MS, runStage, sessionEndedEarly } from "./stage";

export function createHarness(ctx: ServerCore, services: Services) {
  const { bb } = ctx;
  const running = new Set<string>();

  const { config, setConfig } = createConfig(ctx);
  const { listThreadEvents, trajectory, collectEvidence, libraryEntries } = createEvidence(ctx);
  const { forAttempt, materialize, checksForAttempt, checksForWriterThread } = createAttemptTrees(ctx, { config });
  const { place, writeFiles, session, stage } = createSessions(ctx, services);
  const { prepareEdit, editRound, validateEdit, runEditor } = createEdit(ctx, services, { config, place, writeFiles, stage, collectEvidence, libraryEntries, running });
  const { benchInput, evaluateTrials, prepareReflect, reflectSession, recordReflect, reflect } = createReflect(ctx, services, { config, place, writeFiles, session, collectEvidence, libraryEntries });
  const { teachingProjects, tick, status } = createNightly(ctx, { config, evaluateTrials, benchInput, runEditor, running });

  scheduleIsolated(bb, "harness-nightly", "10 4 * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    for (const projectId of await teachingProjects(Date.now() - 30 * 86_400_000)) {
      if (ctx.isDisposed() || signal?.aborted) return;
      const result = await tick(projectId, { night: new Date().toISOString().slice(0, 10) }).catch((cause) => { ctx.log(`harness nightly for ${projectId} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (result) bb.log.info(`Lane Pilot harness nightly ${projectId}: ${result.trials.length} trials judged, editors: ${result.editors.map((row) => `${row.area || "project"}/${row.writerKey}=${row.result}`).join("; ") || "none"}`);
    }
  }, { timeoutMs: 5 * 3_600_000 });

  /** The code and session steps the graphs `lp.harness-edit` and `lp.harness-reflect` wrap (night-graphs/server/harness-graph.ts). */
  const graph = { prepareEdit, editRound, validateEdit, prepareReflect, reflectSession, recordReflect };
  return { config, setConfig, forAttempt, materialize, checksForAttempt, checksForWriterThread, runEditor, evaluateTrials, reflect, tick, status, trajectory, graph, threadEvents: listThreadEvents };
}

export type HarnessApi = ReturnType<typeof createHarness>;
