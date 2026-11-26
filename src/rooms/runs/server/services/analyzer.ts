import { HELPER_ROLES, type HelperRole } from "../../../contracts/helper-context";
import type { AnalyzerSelection, RuleScanSurface, ServerCore } from "../../../contracts/server";
import { fullAccessSpawn, modelCatalogOf, readProviderFolderBlock, resolveSpawnModel, spawnUsageOf, warmSpawnUsage } from "../../../platform/server";
import { bbServiceTier, writerExecutionSelection } from "@lane-pilot/models";
import { bestEffort, outputText, stringAt } from "@lane-pilot/kit";
import { observeStageChild } from "@lane-pilot/thread-observe";
import { projectRoleField } from "./run-routing";

const DEFAULT_ANALYZER: AnalyzerSelection = { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high", serviceTier: "fast" };
const ANALYZER_KEY = (projectId: string) => `rules-analyzer:${projectId}`;
const ANALYZER_LIMIT_MS = 20 * 60_000;
const WAIT_STEP_MS = 5_000;

/** Minimal analyzer runner kept for night-graphs, pm-replay, and memory-eval after removing self-repair/rules. */
export function createAnalyzerRunner(ctx: ServerCore): RuleScanSurface {
  const { bb, db } = ctx;

  async function analyzerFor(projectId: string, place?: { hostId: string; path: string } | null, options: { avoidProvider?: string } = {}): Promise<AnalyzerSelection | null> {
    const stored = await bb.storage.kv.get(ANALYZER_KEY(projectId)) as AnalyzerSelection | undefined;
    if (stored?.providerId && stored.model && stored.providerId !== options.avoidProvider) return stored;
    const settings = (await bestEffort(ctx.log, "analyzer settings", ctx.effectiveProjectSettings(projectId), { values: {}, inherited: [], explicitKeys: [] })).values;
    const spawnUsage = spawnUsageOf(ctx);
    await warmSpawnUsage(spawnUsage, null);
    const folderBlock = place ? await readProviderFolderBlock(bb.storage.kv, place.hostId) : null;
    const role = resolveSpawnModel({
      role: "rules-analyzer", settings, catalog: modelCatalogOf(ctx).peek(), usage: spawnUsage,
      hostId: place?.hostId ?? null, envPath: place?.path ?? null, folderBlock, avoidProvider: options.avoidProvider ?? null,
    });
    return { providerId: role.providerId, model: role.model, reasoningLevel: role.reasoningEffort, serviceTier: DEFAULT_ANALYZER.serviceTier };
  }

  async function runAnalyzer(projectId: string, title: string, prompt: string, place: { hostId: string; path: string }, analyzer: AnalyzerSelection, metadata: Record<string, unknown>, role?: string): Promise<string> {
    const metaRole = typeof metadata?.role === "string" && (HELPER_ROLES as readonly string[]).includes(metadata.role) ? metadata.role as HelperRole : undefined;
    const pickedRole = role && (HELPER_ROLES as readonly string[]).includes(role) ? role as HelperRole : metaRole ?? "rules-analyzer";
    const spawned = await fullAccessSpawn(bb, {
      projectId, visibility: "hidden", title,
      ...projectRoleField(bb, db, projectId, analyzer.providerId, pickedRole),
      ...writerExecutionSelection(analyzer.providerId, analyzer.model, analyzer.reasoningLevel, analyzer.serviceTier ? bbServiceTier(analyzer.serviceTier === "fast" ? "fast" : "standard") : "default"),
      prompt,
      environment: { type: "host", hostId: place.hostId, workspace: { type: "unmanaged", path: place.path } },
      pluginMetadata: { role: pickedRole, stageId: pickedRole, ...metadata },
    } as Parameters<typeof fullAccessSpawn>[1]);
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("analyzer_thread_id_missing");
    const deadline = Date.now() + ANALYZER_LIMIT_MS;
    while (Date.now() < deadline && !ctx.isDisposed()) {
      const observed = await observeStageChild(bb, threadId, Math.min(WAIT_STEP_MS, Math.max(1, deadline - Date.now())));
      if (observed.kind === "completed") {
        const raw = (await bb.sdk.threads.output({ threadId })).output;
        return typeof raw === "string" ? raw : outputText(raw);
      }
      if (observed.kind === "product_failure") throw new Error(`${observed.via}: ${observed.detail}`);
    }
    throw new Error("analyzer run timed out");
  }

  return { analyzerFor, runAnalyzer };
}
