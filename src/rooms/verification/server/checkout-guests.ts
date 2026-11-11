import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { activeRunForWorkspacePath, checkoutRunProject, getActivation, projectIdForCheckoutPath } from "../../storage";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../../storage";
import { resolve } from "node:path";

/**
 * Threads that are not Lane Pilot's but work in a folder where a Lane Pilot run merges writers' work. Agents on the
 * market keep the shared checkout off-limits (each agent its own worktree) and never move someone's uncommitted
 * work; when a person or another chat does edit there, the writers' merges stop on those edits. Lane Pilot remembers
 * who works in the folder and asks them by name only when their edits block a merge.
 *
 * Each guest entry is the window's lease (SMA k_st_sessions): identity, provider, last heartbeat, and the named
 * claims of file scope the window announced (SMA k_st_claims) — one claim carries its provenance: holder, base, globs, time.
 */

const GUESTS = (path: string) => `checkout-guests:${resolve(path)}`;
/** A guest older than this no longer counts as working in the folder. */
const GUEST_TTL_MS = 6 * 3600_000;
/** A claim of scope a person window announced: advisory, stored with the lease so it dies with it. */
export type Claim = { name: string; globs: string[]; description: string; base: string | null; threadId: string; at: number };
export type Guest = { threadId: string; at: number; providerId?: string; label?: string; claims?: Claim[] };
type Kv = BbPluginApi["storage"]["kv"];

/**
 * One in-process queue per folder for every read-modify-write of its guest list (SMA k_lib_claims): two claims fired
 * together serialize, so exactly one racer wins and a claim is all its patterns or none. The plugin runs as one
 * process, so a promise chain is the whole lock.
 */
const guestLocks = new Map<string, Promise<unknown>>();

/** The locked work gets this long; a kv call that never returns must not block every later note for the folder. */
export const GUEST_LOCK_MS = 10_000;

export function withGuestsLock<T>(path: string, work: () => Promise<T>, limitMs = GUEST_LOCK_MS): Promise<T> {
  const key = GUESTS(path);
  // After the limit the lock is released and the caller gets an error (the note path is best effort and swallows it).
  const limited = () => new Promise<T>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`checkout guest lock for ${resolve(path)} timed out after ${limitMs} ms`)), limitMs);
    work().then(done, fail).finally(() => clearTimeout(timer));
  });
  const next = (guestLocks.get(key) ?? Promise.resolve()).then(limited, limited);
  guestLocks.set(key, next.catch(() => undefined));
  return next;
}

/** The open Lane Pilot run that merges into this folder, if any. */
export function activeRunFor(db: LanePilotDatabase, path: string): { id: string; pmThreadId: string | null } | null {
  const row = activeRunForWorkspacePath(db, resolve(path), Date.now() - 24 * 3600_000);
  return row ?? null;
}

/** The project this folder is a checkout of: a run that wrote there, else the configured checkout of an activated project. */
function checkoutProject(db: LanePilotDatabase, path: string): { projectId: string; pmThreadId: string | null } | null {
  const run = checkoutRunProject(db, path);
  if (run) return run;
  const projectId = projectIdForCheckoutPath(db, path);
  return projectId ? { projectId, pmThreadId: getActivation(db, projectId)?.pm_thread_id ?? null } : null;
}

/** The live guests of a folder (entries written by an older build — threadId and at only — still load). */
export async function listGuests(kv: Kv, path: string, now = Date.now()): Promise<Guest[]> {
  const value = await kv.get(GUESTS(path));
  return (Array.isArray(value) ? value as Guest[] : []).filter((row) => row && typeof row.threadId === "string" && now - row.at < GUEST_TTL_MS);
}

/** Every stored guest of a folder, live or expired (claim release and force-clear see them all). */
export async function allGuests(kv: Kv, path: string): Promise<Guest[]> {
  const value = await kv.get(GUESTS(path));
  return (Array.isArray(value) ? value as Guest[] : []).filter((row) => row && typeof row.threadId === "string");
}

export { GUEST_TTL_MS };

/** Entries kept per folder before trimming starts, and the most claims a folder may hold (a new claim past it is refused). */
export const GUESTS_KEPT = 10;
export const CLAIMS_MAX = 40;

/**
 * Trim to GUESTS_KEPT: expired entries go first (oldest first), then live entries with no claim (oldest first). A live entry
 * that holds a claim is never dropped, so the list may stay longer than the cap; CLAIMS_MAX bounds that.
 */
export function trimGuests(guests: Guest[], now = Date.now()): Guest[] {
  const list = [...guests];
  const oldest = (rows: Guest[]) => rows.reduce<Guest | undefined>((best, row) => (!best || row.at < best.at ? row : best), undefined);
  while (list.length > GUESTS_KEPT) {
    const victim = oldest(list.filter((row) => now - row.at >= GUEST_TTL_MS)) ?? oldest(list.filter((row) => !row.claims?.length));
    if (!victim) break;
    list.splice(list.indexOf(victim), 1);
  }
  return list;
}

/** Write the folder's guest list back; callers run it inside withGuestsLock so the read-modify-write stays one turn. */
export async function saveGuests(kv: Kv, path: string, guests: Guest[]): Promise<void> {
  await kv.set(GUESTS(path), trimGuests(guests) as never);
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
    const entry: Guest = { threadId, at: now, ...(opts.providerId ? { providerId: opts.providerId } : previous?.providerId ? { providerId: previous.providerId } : {}),
      ...(opts.label ? { label: opts.label } : previous?.label ? { label: previous.label } : {}), ...(previous?.claims?.length && now - previous.at < GUEST_TTL_MS ? { claims: previous.claims } : {}) };
    await saveGuests(bb.storage.kv, path, [entry, ...stored.filter((row) => row.threadId !== threadId)]);
  });
  // No up-front notice into the chat: the owner's chats stay clean; a guest is asked only when its edits block a merge.
}
