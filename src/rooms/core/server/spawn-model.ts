import { catalogProviderOf, isZcodeProvider, offeredForRole, resolveAgentModel, zcodeBlock, type AgentModel, type AgentModelInput, type ModelCatalog, type SpentProbe } from "@lane-pilot/models";

/**
 * THE resolver right before a real spawn (Astra's review of 2026-10-27, F4): every wrapper that starts a model thread for a ROLE of the
 * table (memory, project life, docs, browser QA, errand, self-repair, rules analyzer, the council chair, the architect and every
 * generic graph helper) asks this, with the settings it already has and the catalog as last read, and spawns exactly the pair it answers.
 * It is `resolveAgentModel` (packages/models/src/agent-model.ts) with the catalog turned into the two questions that function asks:
 * is a model offered on the machine the thread starts on, and which provider lists a model. Deliberate exceptions that do not come
 * through here are listed in tests/spawn-models.test.ts.
 *
 * Provider limits: a table pick whose provider's usage window is nearly spent (`usage.skip_percent`, the writers' setting) moves to the
 * peer in the other family (resolveAgentModel's `spent`). The usage reader is the writers' one (src/rooms/usage/server/provider-usage.ts),
 * registered per plugin instance by the writer state (`registerSpawnUsage`); the resolver stays synchronous and reads only what is cached
 * (a stale or missing entry is refreshed in the background), so a slow or absent source never holds a spawn.
 */

/** The limit view the resolver reads: the cached hold of a provider on a machine under the settings' threshold, and a bounded warm-up for async callers. */
export type SpawnUsage = {
  peek(query: { providerId: string; model: string; hostId: string | null; settings: Record<string, unknown> }): { percent: number; window: string } | null;
  warm(query: { providerIds: readonly string[]; hostId: string | null }): Promise<void>;
  /** Whether a Lane Pilot thread is working on the ZCode app now (it takes one task at a time); absent: not known, taken as free. */
  zcodeBusy?(): boolean;
};
const registered = new WeakMap<object, SpawnUsage>();
export function registerSpawnUsage(bb: object, usage: SpawnUsage): void { registered.set(bb, usage); }
/** The providers a helper table pick can come from (Claude, GPT, and Gemini through 9router on OpenCode v2); a spent window of one moves the pick to its peer in another family. */
export const TABLE_PROVIDERS = ["claude-code", "codex", "opencode2"] as const;

/** What a caller passes as `usage`: the registered reader of the plugin instance, with the log the moves are written to. Undefined without one (no move). */
export type SpawnUsageUse = SpawnUsage & { log?: ((line: string) => void) | undefined };
export function spawnUsageOf(owner: { bb: object; log?: ((line: string) => void) | undefined }): SpawnUsageUse | undefined {
  const usage = registered.get(owner.bb);
  return usage ? { ...usage, log: owner.log } : undefined;
}
/** Reads the usage of both table providers before a decision (bounded; never throws), for callers that are asynchronous anyway. */
/**
 * Refreshes the provider-limit cache in the background and returns at once: a spawn never waits for a usage source (awaiting it held
 * every helper spawn up to 12 s and broke a reload's resume of pm-read). The decision reads the cache (`peek`): a cold cache moves
 * nothing this once, the next spawn sees the refreshed numbers.
 */
export async function warmSpawnUsage(usage: SpawnUsageUse | undefined, hostId: string | null): Promise<void> {
  void usage?.warm({ providerIds: TABLE_PROVIDERS, hostId }).catch(() => undefined);
}

export type SpawnModelInput = Omit<AgentModelInput, "offered" | "providerOf" | "pm"> & {
  pm?: AgentModelInput["pm"];
  /** The catalog as last read (`modelCatalogOf(ctx).peek()`); null when it is cold: then every model counts as offered. */
  catalog?: ModelCatalog | null;
  /** The machine the thread starts on. */
  hostId?: string | null;
  /** A provider that just failed (a limit): nothing of it counts as offered, so the answer is the next candidate. */
  avoidProvider?: string | null;
  /** Provider limits (spawnUsageOf): a nearly spent provider's pick moves to the other family. The Models view and the executor pass the same. */
  usage?: SpawnUsageUse | undefined;
};

export function resolveSpawnModel(input: SpawnModelInput): AgentModel {
  const { catalog, hostId, avoidProvider, pm, usage, ...rest } = input;
  const offeredAt = (avoided: boolean) => (providerId: string, model: string): boolean | null => {
    if (avoided && avoidProvider && providerId === avoidProvider) return false;
    // ZCode works only where packages/models/src/zcode.ts says: the Mac mini, its free hours (or zcode.window=always), no other ZCode task running.
    // An unknown catalog is a no for it: the role's next candidate (its built-in default) runs instead.
    if (isZcodeProvider(providerId)) return !zcodeBlock({ settings: rest.settings, catalog: catalog ?? null, hostId: hostId ?? null, now: Date.now(), busy: usage?.zcodeBusy?.() ?? false });
    return catalog && hostId ? offeredForRole(catalog, providerId, model, hostId) : null;
  };
  const usageSpent: SpentProbe | undefined = usage ? (providerId, model) => usage.peek({ providerId, model, hostId: hostId ?? null, settings: rest.settings }) : undefined;
  const resolve = (avoided: boolean, spent: SpentProbe | undefined): AgentModel => resolveAgentModel({
    ...rest, pm: pm ?? null, offered: offeredAt(avoided),
    ...(catalog ? { providerOf: (model: string) => catalogProviderOf(catalog, model) } : {}), ...(spent ? { spent } : {}),
  });
  let answer = resolve(true, usageSpent);
  // A provider that just hit its limit is out of the offer (the role's next candidate). When nothing is left, or the only one left is the PM's own
  // model on that provider, the answer is the peer in the other family (Claude <-> GPT, either way) if the machine offers it; else the avoided
  // pair stays, flagged `model_unavailable_here`, and the caller fails with the limit notice instead of running the same pair again.
  if (avoidProvider && (answer.providerId === avoidProvider || answer.issues.includes("model_unavailable_here"))) {
    const limitHit: SpentProbe = (providerId, model) => (providerId === avoidProvider ? { percent: 100, window: "provider limit" } : usageSpent?.(providerId, model));
    const other = resolve(false, limitHit);
    answer = other.providerId !== avoidProvider ? other : { ...answer, issues: answer.issues.includes("model_unavailable_here") ? answer.issues : [...answer.issues, "model_unavailable_here"] };
  }
  const moved = answer.issues.find((issue) => issue.startsWith("usage_moved:"));
  if (moved && usage?.log) usage.log(`Lane Pilot: the ${rest.role} helper moves to the other model family, ${moved.slice("usage_moved: ".length)}`);
  return answer;
}
