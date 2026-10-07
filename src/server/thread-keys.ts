import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * VK core thread keys (`experimental_vkSpawnKeyed`, `experimental_vkFindByKey`, `experimental_vkFindByPluginMetadata`).
 * A spawn whose answer was lost (reload, cut connection) is repeated with the same key and returns the same thread, and
 * Lane Pilot's own threads are found by their metadata without paging through every thread of the project. Without the
 * functions every call here falls back to plain `threads.spawn` and the list scan.
 */
type Thread = { id?: unknown } & Record<string, unknown>;
type KeyedThreads = {
  experimental_vkSpawnKeyed?: (args: Record<string, unknown>) => Promise<{ thread: Thread; reused: boolean }>;
  experimental_vkFindByKey?: (key: string) => Promise<Thread | null>;
  experimental_vkFindByPluginMetadata?: (args: { match: Record<string, string | number | boolean>; projectId?: string; includeArchived?: boolean; limit?: number }) => Promise<Thread[]>;
};
/**
 * `bb.vk` exists on a VK build only. The plugin test host answers every `bb.sdk` path with a function, so the method
 * alone proves nothing there; a build that has the thread keys has `bb.vk` too (the namespace came first).
 */
const vkBuild = (bb: BbPluginApi) => typeof (bb as { vk?: unknown }).vk === "object" && (bb as { vk?: unknown }).vk !== null;
const threadsOf = (bb: BbPluginApi) => (vkBuild(bb) ? bb.sdk.threads : {}) as unknown as KeyedThreads;

export const FIND_BY_METADATA_LIMIT = 100;
const MAX_GENERATIONS = 20;
const MAX_KEY_LENGTH = 200;

export const keyedSpawnSupported = (bb: BbPluginApi) => typeof threadsOf(bb).experimental_vkSpawnKeyed === "function";
export const metadataLookupSupported = (bb: BbPluginApi) => typeof threadsOf(bb).experimental_vkFindByPluginMetadata === "function";

/** What makes one logical spawn: the same identity repeated after a lost answer means the same thread. */
export type SpawnIdentity = { stable: string; role: string };

/**
 * The identity a spawn has when its metadata names it, or null: a helper that has no stable owner (a specialist, an
 * errand, a browser check, a nightly docs pass, a repair thread) gets a key of its own per call, which keeps an
 * answer-lost recovery and never merges two helpers that merely look alike.
 */
export function spawnIdentity(metadata: Record<string, unknown> | undefined): SpawnIdentity | null {
  const text = (name: string) => typeof metadata?.[name] === "string" && metadata[name] ? metadata[name] as string : null;
  const role = text("role");
  if (!role) return null;
  if (role === "workspace-provisioner") {
    const attempt = text("workspaceAttemptId");
    return attempt ? { stable: attempt, role } : null;
  }
  const attempt = text("attemptId");
  if (attempt) {
    const round = typeof metadata?.repairRound === "number" ? `:repair${metadata.repairRound}` : "";
    return { stable: `${attempt}${round}`, role };
  }
  const run = text("lanePilotRunId"), task = text("lanePilotTaskId"), stage = text("stageId");
  if (run && task && stage) return { stable: `${run}:${task}:${stage}`, role };
  if (role === "pm" && run) return { stable: run, role };
  return null;
}

export function spawnKey(stable: string, role: string, n: number): string {
  const key = `lp:${stable}:${role}:${n}`;
  if (key.length <= MAX_KEY_LENGTH) return key;
  return `lp:${createHash("sha256").update(stable).digest("hex").slice(0, 40)}:${role.slice(0, 60)}:${n}`;
}

const markerKey = (identity: SpawnIdentity) => `spawn-key:${identity.stable}:${identity.role}`;

/**
 * Spawns through `experimental_vkSpawnKeyed` when the core has it; the caller's `plain` spawn otherwise (the old path,
 * byte for byte). The key is `lp:<stable id>:<role>:<n>`; `n` counts the times the same identity was spawned for real,
 * so a second critic round never gets the first round's thread. A marker in the plugin kv names the key of a spawn that
 * has not been seen to finish: after a lost answer the same call repeats that key and gets the same thread.
 */
export async function spawnKeyed(bb: BbPluginApi, args: Record<string, unknown>, plain: () => Promise<unknown>): Promise<unknown> {
  const threads = threadsOf(bb);
  if (typeof threads.experimental_vkSpawnKeyed !== "function") return plain();
  const identity = spawnIdentity(args.pluginMetadata as Record<string, unknown> | undefined);
  if (!identity) {
    const key = spawnKey(randomUUID().replaceAll("-", ""), typeof (args.pluginMetadata as Record<string, unknown> | undefined)?.role === "string" ? String((args.pluginMetadata as Record<string, unknown>).role) : "thread", 1);
    return (await keyedOrRecover(bb, args, key)).thread;
  }
  const kv = bb.storage.kv;
  let pending: { n?: unknown } | null = null;
  try { pending = (await kv.get<{ n?: unknown }>(markerKey(identity))) ?? null; } catch { return plain(); }
  const resumed = typeof pending?.n === "number" && pending.n >= 1 ? pending.n : null;
  for (let n = resumed ?? 1; n <= MAX_GENERATIONS; n += 1) {
    const key = spawnKey(identity.stable, identity.role, n);
    // Held by an earlier spawn of the same identity that finished: the next number is a new spawn. Held after a spawn
    // whose answer was lost (the marker names this number): that thread is this spawn.
    const isResumed = resumed !== null && n === resumed;
    if (!isResumed && typeof threads.experimental_vkFindByKey === "function" && await threads.experimental_vkFindByKey(key).catch(() => null)) continue;
    try { await kv.set(markerKey(identity), { n, at: Date.now() }); } catch { return plain(); }
    const result = await keyedOrRecover(bb, args, key);
    if (result.reused && !result.recovered && !isResumed) continue;
    await kv.delete(markerKey(identity)).catch(() => undefined);
    return result.thread;
  }
  return plain();
}

async function keyedOrRecover(bb: BbPluginApi, args: Record<string, unknown>, key: string): Promise<{ thread: Thread; reused: boolean; recovered?: boolean }> {
  const threads = threadsOf(bb);
  try {
    return await threads.experimental_vkSpawnKeyed!({ ...args, key });
  } catch (cause) {
    // The answer may be lost although the thread exists: the key tells.
    const held = typeof threads.experimental_vkFindByKey === "function" ? await threads.experimental_vkFindByKey(key).catch(() => null) : null;
    if (held) return { thread: held, reused: true, recovered: true };
    throw cause;
  }
}

/** Threads of this plugin whose metadata holds every pair, or null when the core cannot answer (use the list scan). */
export async function findThreadsByMetadata(bb: BbPluginApi, match: Record<string, string | number | boolean>, projectId?: string): Promise<Array<{ id: string }> | null> {
  const find = threadsOf(bb).experimental_vkFindByPluginMetadata;
  if (typeof find !== "function") return null;
  try {
    const found = await find.call(threadsOf(bb), { match, ...(projectId ? { projectId } : {}), includeArchived: false, limit: FIND_BY_METADATA_LIMIT });
    // A full page may hide more matches: only the list scan can tell.
    if (!Array.isArray(found) || found.length >= FIND_BY_METADATA_LIMIT) return null;
    return found.flatMap((thread) => typeof thread?.id === "string" ? [{ id: thread.id }] : []);
  } catch { return null; }
}
