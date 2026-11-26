import { resolve } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../../../storage";
import { GUEST_LOCK_MS, GUEST_TTL_MS, type Guest } from "../../models/checkout-guests";
import { activeRunFor, allGuests, checkoutProject, saveGuests } from "../repositories/checkout-guests-repository";

/**
 * One in-process queue per folder for every read-modify-write of its guest list (SMA k_lib_claims): two claims fired
 * together serialize, so exactly one racer wins and a claim is all its patterns or none. The plugin runs as one
 * process, so a promise chain is the whole lock.
 */
const guestLocks = new Map<string, Promise<unknown>>();

export function withGuestsLock<T>(path: string, work: () => Promise<T>, limitMs = GUEST_LOCK_MS): Promise<T> {
  const key = `checkout-guests:${resolve(path)}`;
  // After the limit the lock is released and the caller gets an error (the note path is best effort and swallows it).
  const limited = () => new Promise<T>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`checkout guest lock for ${resolve(path)} timed out after ${limitMs} ms`)), limitMs);
    work().then(done, fail).finally(() => clearTimeout(timer));
  });
  const next = (guestLocks.get(key) ?? Promise.resolve()).then(limited, limited);
  guestLocks.set(key, next.catch(() => undefined));
  return next;
}

/** A thread seen in the folder this recently is not written again: the common message costs one kv read. */
const NOTE_FRESH_MS = 5 * 60_000;

/**
 * Called for every send of a thread that is not a Lane Pilot chat. When it works in a checkout of a project Lane Pilot
 * runs on, it is remembered (the lease is the window's, whether a run is open right now or not); nothing is sent to it.
 */
export async function noteCheckoutGuest(bb: BbPluginApi, db: LanePilotDatabase, threadId: string, path: string | null | undefined, opts: { providerId?: string; label?: string } = {}): Promise<void> {
  if (!path) return;
  const seen = await allGuests(bb.storage.kv, path);
  if (seen.some((row) => row.threadId === threadId && Date.now() - row.at < NOTE_FRESH_MS)) return;
  const run = activeRunFor(db, path);
  const project = run ? { projectId: "", pmThreadId: run.pmThreadId } : checkoutProject(db, path);
  if (!project || project.pmThreadId === threadId) return;
  const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound) as Record<string, unknown> | null;
  if (metadata && typeof metadata.role === "string") return;
  const now = Date.now();
  await withGuestsLock(path, async () => {
    const stored = await allGuests(bb.storage.kv, path);
    const previous = stored.find((row) => row.threadId === threadId);
    const entry: Guest = {
      threadId,
      at: now,
      ...(opts.providerId ? { providerId: opts.providerId } : previous?.providerId ? { providerId: previous.providerId } : {}),
      ...(opts.label ? { label: opts.label } : previous?.label ? { label: previous.label } : {}),
      ...(previous?.claims?.length && now - previous.at < GUEST_TTL_MS ? { claims: previous.claims } : {}),
    };
    await saveGuests(bb.storage.kv, path, [entry, ...stored.filter((row) => row.threadId !== threadId)]);
  });
  // No up-front notice into the chat: the owner's chats stay clean; a guest is asked only when its edits block a merge.
}
