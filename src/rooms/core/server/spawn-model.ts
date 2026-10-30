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

/** Helper starts per provider over the last half hour, for a row with a pool of models to spread its runs (resolveAgentModel's `load`). */
const RECENT_MS = 30 * 60_000;
const recentStarts = new Map<string, number[]>();
function recentOf(providerId: string, now: number): number {
  const kept = (recentStarts.get(providerId) ?? []).filter((at) => now - at < RECENT_MS);
  recentStarts.set(providerId, kept);
  return kept.length;
}
/** Test hook: forget the recent starts. */
export function resetRecentStarts(): void { recentStarts.clear(); }

/** A folder under a macOS user's Documents — the one place an observed opencode2 EPERM can be about. */
const DOCUMENTS_FOLDER = /^\/Users\/[^/]+\/Documents(\/|$)/;

/** The observed start failure of a provider in a ~/Documents folder on one machine, with when it was seen. */
export type ProviderFolderBlock = { reason: string; at: number };

/** How long an observed refusal holds (`provider.folder_block_ttl_ms` setting; 6 h default) — then the provider is offered again. */
export const PROVIDER_FOLDER_BLOCK_TTL_MS = 6 * 60 * 60_000;

const providerFolderBlockKey = (hostId: string | null, providerId: string) => `provider-folder-block:${hostId ?? "?"}:${providerId}`;

/** The live block for this machine+provider, or null when none was recorded or it expired. */
export async function readProviderFolderBlock(kv: { get(key: string): Promise<unknown> }, hostId: string | null, providerId: string, ttlMs = PROVIDER_FOLDER_BLOCK_TTL_MS): Promise<ProviderFolderBlock | null> {
  const block = await kv.get(providerFolderBlockKey(hostId, providerId)).catch(() => null) as ProviderFolderBlock | null;
  return block && Date.now() - block.at < ttlMs ? block : null;
}

/**
 * A start that failed with a signature the folder could cause (EPERM on the provider's API, the session's required MCP
 * policy refused) in a ~/Documents folder: remembered on this machine, so the resolver stops offering it there until a
 * success or the TTL (Mac mini 2026-10-30: opencode2 serve without Documents access; lifted after the owner re-granted it).
 */
export async function noteProviderStartFailure(kv: { set(key: string, value: never): Promise<unknown> }, hostId: string | null, providerId: string, envPath: string | null | undefined, reason: string): Promise<void> {
  if (providerId !== "opencode2" || !envPath || !DOCUMENTS_FOLDER.test(envPath)) return;
  if (!/EPERM|unenforceable|\b500\b.*mcp|mcp.*\b500\b/i.test(reason)) return;
  await kv.set(providerFolderBlockKey(hostId, providerId), { reason, at: Date.now() } as never).catch(() => undefined);
}

/** A start that went through in the folder: clears the observed block for this machine+provider. */
export async function noteProviderStartSuccess(kv: { set(key: string, value: never): Promise<unknown> }, hostId: string | null, providerId: string, envPath: string | null | undefined): Promise<void> {
  if (providerId !== "opencode2" || !envPath || !DOCUMENTS_FOLDER.test(envPath)) return;
  await kv.set(providerFolderBlockKey(hostId, providerId), null as never).catch(() => undefined);
}

/** A provider that cannot work in this folder on this machine, by an observed cause (not a guessed one): the reason for the record, or null. */
export function providerBlockedForFolder(providerId: string, envPath: string | null | undefined, block?: ProviderFolderBlock | null): string | null {
  // Only an observed refusal holds opencode2 out of ~/Documents: its start EPERM'd there before (vk_required_session_policy_unenforceable_mcp_servers).
  if (providerId === "opencode2" && envPath && DOCUMENTS_FOLDER.test(envPath) && block) return block.reason;
  return null;
}

export type SpawnModelInput = Omit<AgentModelInput, "offered" | "providerOf" | "pm" | "load"> & {
  /** The folder the thread starts in: a provider that cannot work there (`providerBlockedForFolder`) is not offered. */
  envPath?: string | null;
  pm?: AgentModelInput["pm"];
  /** The catalog as last read (`modelCatalogOf(ctx).peek()`); null when it is cold: then every model counts as offered. */
  catalog?: ModelCatalog | null;
  /** The machine the thread starts on. */
  hostId?: string | null;
  /** A provider that just failed (a limit): nothing of it counts as offered, so the answer is the next candidate. */
  avoidProvider?: string | null;
  /** Provider limits (spawnUsageOf): a nearly spent provider's pick moves to the other family. The Models view and the executor pass the same. */
  usage?: SpawnUsageUse | undefined;
  /** An observed start failure of the pick's provider in this folder on this machine (`readProviderFolderBlock`), else none. */
  folderBlock?: ProviderFolderBlock | null;
};

export function resolveSpawnModel(input: SpawnModelInput): AgentModel {
  const { catalog, hostId, avoidProvider, pm, usage, envPath, folderBlock, ...rest } = input;
  const offeredAt = (avoided: boolean) => (providerId: string, model: string): boolean | null => {
    if (avoided && avoidProvider && providerId === avoidProvider) return false;
    if (providerBlockedForFolder(providerId, envPath, folderBlock)) return false;
    // ZCode works only where packages/models/src/zcode.ts says: the Mac mini, its free hours (or zcode.window=always), no other ZCode task running.
    // An unknown catalog is a no for it: the role's next candidate (its built-in default) runs instead.
    if (isZcodeProvider(providerId)) return !zcodeBlock({ settings: rest.settings, catalog: catalog ?? null, hostId: hostId ?? null, now: Date.now(), busy: usage?.zcodeBusy?.() ?? false });
    return catalog && hostId ? offeredForRole(catalog, providerId, model, hostId) : null;
  };
  const usageSpent: SpentProbe | undefined = usage ? (providerId, model) => usage.peek({ providerId, model, hostId: hostId ?? null, settings: rest.settings }) : undefined;
  const now = Date.now();
  // The spent share of a window from the cache (a threshold of 1% returns the reading itself; ZCode has no window) and the recent starts.
  const load = (providerId: string, model: string) => ({
    percent: usage && !isZcodeProvider(providerId) ? usage.peek({ providerId, model, hostId: hostId ?? null, settings: { ...rest.settings, "usage.skip_percent": 1 } })?.percent ?? null : null,
    recent: recentOf(providerId, now),
  });
  const resolve = (avoided: boolean, spent: SpentProbe | undefined): AgentModel => resolveAgentModel({
    ...rest, pm: pm ?? null, offered: offeredAt(avoided), load,
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
  recentStarts.set(answer.providerId, [...(recentStarts.get(answer.providerId) ?? []), now]);
  return answer;
}
