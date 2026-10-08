import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { getReasoningTrace, listAttemptsForTask, type LanePilotDatabase } from "../storage";
import { bbServiceTier, findModelIn } from "@lane-pilot/models";

/**
 * G9: the code critic is another model than the writer. Reviewing the writer's own work with the writer's own model
 * shares its blind spots, so when the critic's pair equals the writer's, the next usable pair is taken from the project's
 * stage selections and then the PM's pair. A pair counts only when the host catalog has it (provider available, model
 * listed, the critic's reasoning effort and service tier supported). With none left the writer's pair stays: this never
 * blocks an acceptance.
 */
export type Pair = { providerId: string; model: string };

/** What the host catalog says, narrowed to what the check needs. */
export type CriticCatalog = {
  provider(providerId: string): Promise<{ id: string; available: boolean; supportsServiceTier: boolean; serviceTiers: string[] } | null>;
  models(providerId: string): Promise<Array<{ id: string; model: string; efforts: string[] }>>;
};

const STAGE_SELECTION_KEYS = ["plan_critique", "specialist", "pm_read", "night_review", "docs", "project_life", "memory", "onboarding"] as const;

const same = (a: Pair, b: Pair) => a.providerId === b.providerId && a.model === b.model;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** The pairs to try, in order: each stage's selection (both provider and model set), then the PM's; no repeats. */
export function criticPairCandidates(settings: Record<string, unknown>, config: { pmProviderId: string; pmModel: string }): Pair[] {
  const all: Pair[] = [];
  for (const stage of STAGE_SELECTION_KEYS) {
    const providerId = text(settings[`${stage}.provider`]);
    const model = text(settings[`${stage}.model`]);
    if (providerId && model) all.push({ providerId, model });
  }
  if (config.pmProviderId && config.pmModel) all.push({ providerId: config.pmProviderId, model: config.pmModel });
  return all.filter((pair, index) => all.findIndex((other) => same(other, pair)) === index);
}

async function usable(catalog: CriticCatalog, pair: Pair, effort: string, tier: "fast" | "standard"): Promise<boolean> {
  const provider = await catalog.provider(pair.providerId);
  if (!provider?.available) return false;
  const model = findModelIn(await catalog.models(pair.providerId), pair.model);
  if (!model || !model.efforts.includes(effort)) return false;
  const serviceTier = provider.supportsServiceTier ? bbServiceTier(tier) : null;
  return !serviceTier || provider.serviceTiers.includes(serviceTier);
}

export async function pairApartFromWriter(input: {
  current: Pair; writer: Pair | null; candidates: readonly Pair[]; effort: string; tier: "fast" | "standard"; catalog: CriticCatalog;
}): Promise<{ pair: Pair; changed: boolean }> {
  const keep = { pair: input.current, changed: false };
  if (!input.writer || !same(input.current, input.writer)) return keep;
  for (const candidate of input.candidates) {
    if (same(candidate, input.writer)) continue;
    try {
      if (await usable(input.catalog, candidate, input.effort, input.tier)) return { pair: candidate, changed: true };
    } catch { return keep; }
  }
  return keep;
}

/** The pair of the task's latest attempt that has a reasoning trace (the writer that produced the work), or null. */
export function latestWriterPair(db: LanePilotDatabase, runId: string, taskId: string): Pair | null {
  for (const attempt of [...listAttemptsForTask(db, runId, taskId)].reverse()) {
    const trace = getReasoningTrace(db, attempt.id);
    if (trace?.providerId && trace.model) return { providerId: trace.providerId, model: trace.model };
  }
  return null;
}

/** The host catalog through the BB SDK; the provider list is read once. */
export function sdkCriticCatalog(bb: Pick<BbPluginApi, "sdk">, hostId: string): CriticCatalog {
  let providers: Promise<Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["list"]>>> | null = null;
  return {
    async provider(providerId) {
      providers ??= Promise.resolve(bb.sdk.providers.list({ hostId }));
      const row = (await providers).find((item) => item.id === providerId);
      return row ? { id: row.id, available: Boolean(row.available), supportsServiceTier: Boolean(row.capabilities?.supportsServiceTier),
        serviceTiers: (row.serviceTiers ?? []).map((item) => item.id) } : null;
    },
    async models(providerId) {
      const listed = await bb.sdk.providers.models({ providerId, hostId });
      return listed.models.map((row) => ({ id: row.id, model: row.model, efforts: row.supportedReasoningEfforts.map((item) => item.reasoningEffort) }));
    },
  };
}
