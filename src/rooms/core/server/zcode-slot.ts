import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { stringAt } from "./values";

/**
 * The ZCode slots. The ZCode app runs several tasks at once (bb-plugin-zcode 0.3.0: six overlapped without an error, each about twice as slow);
 * the bridge allows ZCODE_MAX_PARALLEL (3 by default) and queues the rest, so Lane Pilot sends no more than ZCODE_PARALLEL of its own at once. Every thread Lane Pilot starts on the `zcode` provider is noted
 * at its spawn (`fullAccessSpawn`); whether it still works is read from BB (`active` or `starting`), so nothing has to release the slot and a
 * reload or a crash leaves no stale lock. A thread another chat of the owner runs there is not seen; the bridge's own lock queues it.
 */
const BUSY = new Set(["active", "starting"]);
const FRESH_MS = 3_000;
const FORGET_MS = 60 * 60_000;
/** A thread BB cannot be asked about is not held against ZCode for longer than a writer session may last (SESSION_MAX_MS is two hours). */
const GIVE_UP_MS = 3 * 60 * 60_000;
const READ_MS = 3_000;

type Seen = { busy: boolean; at: number; since: number };
const threadsOf = new WeakMap<object, Map<string, Seen>>();
const mapOf = (bb: object): Map<string, Seen> => {
  let map = threadsOf.get(bb);
  if (!map) { map = new Map(); threadsOf.set(bb, map); }
  return map;
};

/** A thread just started on the zcode provider: busy until BB says otherwise. */
export function noteZcodeThread(bb: object, threadId: string | null | undefined, now = Date.now()): void {
  if (threadId) mapOf(bb).set(threadId, { busy: true, at: now, since: now });
}

async function read(bb: BbPluginApi, threadId: string, now: number): Promise<void> {
  const map = mapOf(bb);
  const thread = await Promise.race([
    Promise.resolve(bb.sdk.threads.get({ threadId })).catch(() => null),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), READ_MS).unref?.(); }),
  ]);
  const status = stringAt(thread, "status");
  const known = map.get(threadId);
  // A read that failed or timed out keeps the last state (until GIVE_UP_MS); one that answered replaces it.
  if (thread && known) map.set(threadId, { busy: status !== null && BUSY.has(status), at: now, since: known.since });
}

function stale(bb: object, now: number): string[] {
  const map = mapOf(bb);
  const ids: string[] = [];
  for (const [id, seen] of map) {
    if ((!seen.busy && now - seen.at > FORGET_MS) || now - seen.since > GIVE_UP_MS) map.delete(id);
    else if (now - seen.at >= FRESH_MS) ids.push(id);
  }
  return ids;
}

/** How many tasks Lane Pilot keeps on ZCode at once: the bridge's default limit. */
export const ZCODE_PARALLEL = 3;
/** Spawns on their way: counted with the busy threads, so two writers checked in the same second do not both get the last slot. */
const pendingOf = new WeakMap<object, number>();
const taken = (bb: object): number => [...mapOf(bb).values()].filter((seen) => seen.busy).length + (pendingOf.get(bb) ?? 0);
const anyBusy = (bb: object): boolean => taken(bb) >= ZCODE_PARALLEL;

/**
 * Takes a slot for a spawn about to start on ZCode, at once (no await between the check and the count), or answers false when all are
 * taken. The live test of 2026-10-27 started two writers in the same second: both had passed the check, the thread was noted only after
 * its spawn, and both went to ZCode. The caller calls the returned release after the spawn, whatever its outcome.
 */
export function reserveZcodeSlot(bb: object): (() => void) | null {
  if (anyBusy(bb)) return null;
  pendingOf.set(bb, (pendingOf.get(bb) ?? 0) + 1);
  let released = false;
  return () => { if (!released) { released = true; pendingOf.set(bb, Math.max(0, (pendingOf.get(bb) ?? 1) - 1)); } };
}

/** Whether ZCode's slots are all taken by Lane Pilot threads, as last known; stale entries are read again in the background. Never waits, never throws. */
export function zcodeBusyPeek(bb: BbPluginApi, now = Date.now()): boolean {
  try {
    for (const id of stale(bb, now)) void read(bb, id, now).catch(() => undefined);
  } catch { /* the slot is a hint: the bridge's lock is the guard */ }
  return anyBusy(bb);
}

/** The same, after the stale entries are read again (bounded). */
export async function zcodeBusy(bb: BbPluginApi, now = Date.now()): Promise<boolean> {
  try {
    await Promise.all(stale(bb, now).map((id) => read(bb, id, now)));
  } catch { /* as above */ }
  return anyBusy(bb);
}
