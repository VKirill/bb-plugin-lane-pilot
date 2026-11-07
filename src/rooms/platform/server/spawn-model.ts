import { PROVIDER_CAPABILITIES, catalogProviderOf, isZcodeProvider, offeredForRole, resolveAgentModel, zcodeBlock, type AgentModel, type AgentModelInput, type ModelCatalog, type SpentProbe } from "@lane-pilot/models";

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

/**
 * Limits seen in a real answer, for every role's pick: a helper that hit «Usage limit reached for 5 hour» (opencode2 GLM, docs-night 157
 * failed units and six PM-replay harvests on 2026-11-02..04) takes that provider off the offer of every later pick, writers' chain aside,
 * instead of each next call failing the same way. Keyed by provider and the model's own sub-provider (`zai-coding-plan/…` vs `router9/…`
 * on opencode2), so a spent GLM plan does not take the free Gemini with it.
 * ponytail: a fixed hold, not the notice's reset time — the notices name it in the provider's local time; parse it if an hour proves wrong.
 */
export const SEEN_LIMIT_HOLD_MS = 60 * 60_000;
const seenLimits = new Map<string, { until: number; notice: string }>();
const limitKey = (providerId: string, model: string | null | undefined) => `${providerId}|${model?.includes("/") ? model.split("/")[0] : ""}`;
export function noteProviderLimit(providerId: string, model: string | null | undefined, notice: string, now = Date.now()): void {
  if (providerId) seenLimits.set(limitKey(providerId, model), { until: now + SEEN_LIMIT_HOLD_MS, notice: notice.slice(0, 160) });
}
export function seenProviderLimit(providerId: string, model: string | null | undefined, now = Date.now()): { percent: number; window: string } | null {
  const seen = seenLimits.get(limitKey(providerId, model));
  return seen && seen.until > now ? { percent: 100, window: `limit seen: ${seen.notice}` } : null;
}
/** The provider and model each helper thread was spawned on, so a failure seen later is charged to the right pair. */
const threadModels = new Map<string, { providerId: string; model: string }>();
export function rememberThreadModel(threadId: string, providerId: string, model: string): void {
  threadModels.set(threadId, { providerId, model });
  if (threadModels.size > 1_000) threadModels.delete(threadModels.keys().next().value as string);
}
export function threadModelOf(threadId: string): { providerId: string; model: string } | null { return threadModels.get(threadId) ?? null; }
/** Test hook. */
export function resetSeenLimits(): void { seenLimits.clear(); threadModels.clear(); }
export function registerSpawnUsage(bb: object, usage: SpawnUsage): void { registered.set(bb, usage); }
/** The providers a helper table pick can come from (Claude, GPT, and Gemini through 9router on OpenCode v2); a spent window of one moves the pick to its peer in another family. */
export const TABLE_PROVIDERS = ["claude-code", "codex", "opencode2"] as const;

/** What a caller passes as `usage`: the registered reader of the plugin instance, with the log the moves are written to. Undefined without one (no move). */
export type SpawnUsageUse = SpawnUsage & { log?: ((line: string) => void) | undefined };
export function spawnUsageOf(owner: { bb: object; log?: ((line: string) => void) | undefined }): SpawnUsageUse | undefined {
  const usage = registered.get(owner.bb);
  return usage ? { ...usage, peek: (query) => seenProviderLimit(query.providerId, query.model) ?? usage.peek(query), log: owner.log } : undefined;
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

/** A folder under a macOS user's Documents — the one place an observed provider EPERM can be about. */
const DOCUMENTS_FOLDER = /^\/Users\/[^/]+\/Documents(\/|$)/;

/** The provider whose start observedly failed in a ~/Documents folder on one machine, the reason and when it was seen. */
export type ProviderFolderBlock = { providerId: string; reason: string; at: number };
/** The row written before the key became host-only: the same reason and time, without the provider (the key named it). */
type StoredFolderBlock = { reason: string; at: number };

/** How long an observed refusal holds (`provider.folder_block_ttl_ms` setting; 6 h default) — then the provider is offered again. */
export const PROVIDER_FOLDER_BLOCK_TTL_MS = 6 * 60 * 60_000;

// ponytail: one block per machine, not per machine+provider; a second documents-sensitive provider would need the key widened again.
const providerFolderBlockKey = (hostId: string | null) => `provider-folder-block:${hostId ?? "?"}`;
const legacyProviderFolderBlockKey = (hostId: string | null, providerId: string) => `provider-folder-block:${hostId ?? "?"}:${providerId}`;

/** The providers a machine's folder protection can refuse, from the capability table (they are the only legacy keys worth reading). */
function documentsSensitiveProviders(): string[] {
  return Object.keys(PROVIDER_CAPABILITIES).filter((providerId) => PROVIDER_CAPABILITIES[providerId]?.documentsFolderSensitive);
}

const liveBlock = (value: unknown, ttlMs: number): StoredFolderBlock | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as { reason?: unknown; at?: unknown };
  if (typeof row.at !== "number" || Date.now() - row.at >= ttlMs) return null;
  return { reason: typeof row.reason === "string" ? row.reason : "", at: row.at };
};

type FolderBlockKv = { get(key: string): Promise<unknown>; set?(key: string, value: never): Promise<unknown> };

/**
 * The live block this machine recorded, or null when none was or it expired. A block standing at deploy time was written
 * under the old per-provider key (`provider-folder-block:<host>:<provider>`, no provider in the row) and is migrated on
 * first read, so it is not ignored for its remaining TTL.
 */
export async function readProviderFolderBlock(kv: FolderBlockKv, hostId: string | null, ttlMs = PROVIDER_FOLDER_BLOCK_TTL_MS): Promise<ProviderFolderBlock | null> {
  const current = await kv.get(providerFolderBlockKey(hostId));
  const live = liveBlock(current, ttlMs);
  if (live && typeof (current as { providerId?: unknown }).providerId === "string") {
    return { providerId: (current as { providerId: string }).providerId, ...live };
  }
  for (const providerId of documentsSensitiveProviders()) {
    const legacy = liveBlock(await kv.get(legacyProviderFolderBlockKey(hostId, providerId)), ttlMs);
    if (!legacy) continue;
    const migrated: ProviderFolderBlock = { providerId, ...legacy };
    await kv.set?.(providerFolderBlockKey(hostId), migrated as never).catch(() => undefined);
    return migrated;
  }
  return null;
}

/**
 * A start that failed with a signature the folder could cause (EPERM on the provider's API, the session's required MCP
 * policy refused) in a ~/Documents folder: remembered on this machine, so the resolver stops offering it there until a
 * success or the TTL (Mac mini 2026-10-30: opencode2 serve without Documents access; lifted after the owner re-granted it).
 */
export async function noteProviderStartFailure(kv: { set(key: string, value: never): Promise<unknown> }, hostId: string | null, providerId: string, envPath: string | null | undefined, reason: string): Promise<void> {
  if (!PROVIDER_CAPABILITIES[providerId]?.documentsFolderSensitive || !envPath || !DOCUMENTS_FOLDER.test(envPath)) return;
  if (!/EPERM|unenforceable|\b500\b.*mcp|mcp.*\b500\b/i.test(reason)) return;
  await kv.set(providerFolderBlockKey(hostId), { providerId, reason, at: Date.now() } as never).catch(() => undefined);
}

/** A start that went through in the folder: clears this machine's observed block, the current key and any legacy row. */
export async function noteProviderStartSuccess(kv: { set(key: string, value: never): Promise<unknown> }, hostId: string | null, providerId: string, envPath: string | null | undefined): Promise<void> {
  if (!PROVIDER_CAPABILITIES[providerId]?.documentsFolderSensitive || !envPath || !DOCUMENTS_FOLDER.test(envPath)) return;
  await kv.set(providerFolderBlockKey(hostId), null as never).catch(() => undefined);
  await kv.set(legacyProviderFolderBlockKey(hostId, providerId), null as never).catch(() => undefined);
}

/** A provider that cannot work in this folder on this machine, by an observed cause (not a guessed one): the reason for the record, or null. */
export function providerBlockedForFolder(providerId: string, envPath: string | null | undefined, block?: ProviderFolderBlock | null): string | null {
  if (PROVIDER_CAPABILITIES[providerId]?.documentsFolderSensitive && envPath && DOCUMENTS_FOLDER.test(envPath) && block?.providerId === providerId) return block.reason;
  return null;
}

export type SpawnModelInput = Omit<AgentModelInput, "offered" | "providerOf" | "pm"> & {
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
  const usageSpent: SpentProbe = (providerId, model) => seenProviderLimit(providerId, model) ?? usage?.peek({ providerId, model, hostId: hostId ?? null, settings: rest.settings }) ?? null;
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
