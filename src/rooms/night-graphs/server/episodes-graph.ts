import type { NodeExecutor } from "@lane-pilot/workflow-engine";
import { jev, type JevSettings } from "@lane-pilot/jev";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  modelCatalogOf, readProviderFolderBlock, resolveSpawnModel, scheduleIsolated, spawnUsageOf, warmSpawnUsage,
  type ServerCore, type Services,
} from "../../core/server";
import { builtinWorkflow } from "../../workflow";
import type { ChainRuntime } from "../../workflow/server";
import {
  chooseProcessKey, errandFailureJudgment, sweepErrandEpisodes,
  ERRAND_EPISODE_TRACE_EVENTS, type EpisodeEnrichDeps,
} from "../../errands";

export const EPISODES_WORKFLOW = "lp.episodes";
export const EPISODES_SCHEDULE = "episodes-hourly";

/**
 * The hourly episode sweep (stream R5, workflows/lp.episodes.json): one action node picks the oldest pending errand
 * episodes — at most EPISODE_SWEEP_LIMIT per pass, none retried within the hour — and enrichEpisode reads each helper
 * thread, masks secrets and PII before the `episode-analyst` role's hidden analyzer thread sees the text, parses the
 * strict JSON answer and writes the enrichment columns. `episodes.collect` off makes the whole pass a no-op.
 */
/** The sweep's live deps (helper thread, analyzer model, Jev); the hourly node and `errands episodes-sweep` share them. */
const analystRooms = new Map<string, string>();

export function episodeSweepDeps(ctx: ServerCore, services: Services, stopped: () => boolean): EpisodeEnrichDeps {
  return {
    db: ctx.db,
    stopped,
    log: (message) => ctx.log(message),
    warn: (message) => ctx.log(message),
    readOutline: async (threadId) => {
      const outline = await ctx.bb.sdk.threads.conversationOutline({ threadId }).catch(() => null);
      const text = (outline?.items ?? []).map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.preview}`).join("\n");
      return text || null;
    },
    readEvents: (threadId) => services.harness.threadEvents(threadId, ERRAND_EPISODE_TRACE_EVENTS),
    runModel: async (prompt, projectId, runId) => {
      // A project with no writer host (proj_personal: 18 of 132 errands on 2026-11-06) reads on the global one: the analyzer
      // needs a machine, not the project's checkout.
      const resolved = (id: string | undefined) => services.resolveProjectWriterHost({ projectId: id } as never).catch(() => null);
      let place = await resolved(projectId ?? undefined);
      if (projectId && (place as { status?: string } | null)?.status !== "resolved") place = await resolved(undefined);
      if (!place || (place as { status?: string }).status !== "resolved") throw new Error("episode_enrich_no_host");
      const project = place as { hostId: string; path: string };
      // The analyzer is a full-access agent: in the project folder it read other threads' unmasked histories
      // (.bb/chats/*/history, 2026-11-06), past the mask. It works in an empty folder of its own on that machine.
      let room = analystRooms.get(project.hostId);
      if (!room) {
        const made = await ctx.host.call("runCommand", { requestedHostId: project.hostId, cwd: project.path, timeoutSec: 30,
          command: 'mkdir -p "$HOME/.lane-pilot/episode-analyst" && cd "$HOME/.lane-pilot/episode-analyst" && pwd' },
          { hostId: project.hostId, timeoutMs: 40_000 }) as { exitCode: number; stdout: string };
        room = made.exitCode === 0 ? made.stdout.trim().split("\n").at(-1) : undefined;
        if (!room) throw new Error("episode_enrich_no_empty_room");
        analystRooms.set(project.hostId, room);
      }
      const host = { hostId: project.hostId, path: room };
      const settings = (await ctx.effectiveProjectSettings(projectId ?? GLOBAL_SETTINGS_PROJECT_ID).catch(() => null))?.values ?? {};
      const spawnUsage = spawnUsageOf(ctx);
      await warmSpawnUsage(spawnUsage, host.hostId);
      const folderBlock = await readProviderFolderBlock(ctx.bb.storage.kv, host.hostId, "opencode2");
      const role = resolveSpawnModel({
        role: "episode-analyst", settings, catalog: modelCatalogOf(ctx).peek(), usage: spawnUsage,
        hostId: host.hostId, envPath: host.path, folderBlock,
      });
      const analyzer = { providerId: role.providerId, model: role.model, reasoningLevel: role.reasoningEffort, serviceTier: role.serviceTier };
      const text = await services.ruleScan.runAnalyzer(projectId ?? "*", `episode ${runId}`, prompt, host, analyzer, { episode: runId });
      return { text, model: `${analyzer.providerId}/${analyzer.model}` };
    },
    chooseKey: async (input, { runId, projectId }) => {
      const settings = ((await ctx.effectiveProjectSettings(projectId ?? GLOBAL_SETTINGS_PROJECT_ID).catch(() => null))?.values ?? {}) as JevSettings;
      return (await chooseProcessKey({ ...input, ctx: { projectId: projectId ?? "*", runId, subject: runId, settings } })).key;
    },
    judge: async (input, { runId, projectId }) => {
      const instance = jev();
      if (!instance) return;
      const settings = ((await ctx.effectiveProjectSettings(projectId ?? GLOBAL_SETTINGS_PROJECT_ID).catch(() => null))?.values ?? {}) as JevSettings;
      if (!instance.enabled(settings)) return;
      await instance.judge(errandFailureJudgment, input, { projectId: projectId ?? "*", runId, subject: runId, settings });
    },
  };
}

export function mountEpisodesGraph(ctx: ServerCore, services: Services): void {
  const engine = services.workflowEngine;
  const deps = (stopped: () => boolean): EpisodeEnrichDeps => episodeSweepDeps(ctx, services, stopped);

  engine.register<ChainRuntime>("lp.episodes_sweep", {
    reentrant: true,
    run: async (c) => {
      const result = await sweepErrandEpisodes(deps(() => ctx.isDisposed() || c.signal.aborted));
      const summary = `episodes: ${result.enriched} enriched, ${result.skipped} skipped, ${result.failed} failed, ${result.held} held of ${result.picked} picked`;
      ctx.log(summary);
      return { output: { status: "done", ...result, summary } };
    },
  } as NodeExecutor<ChainRuntime>);

  // Hourly, a few minutes past the hour so the hour's errand completions have landed; the per-hour key makes a
  // repeated tick in the same hour a no-op.
  scheduleIsolated(ctx.bb, EPISODES_SCHEDULE, "23 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const workflow = builtinWorkflow(EPISODES_WORKFLOW);
    if (!workflow) return;
    const key = `episodes:${new Date().toISOString().slice(0, 13)}`;
    const prior = ctx.db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(key) as { status: string } | undefined;
    if (prior) return;
    await engine.start({
      workflow, key, link: { projectId: "*" },
      runtime: { ctx, services, pmThreadId: null, projectId: "*", runId: null, origin: "schedule" } satisfies ChainRuntime,
      inputs: {},
    }).done.catch((cause: unknown) => ctx.log(`episodes sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 60 * 60_000 });
}
