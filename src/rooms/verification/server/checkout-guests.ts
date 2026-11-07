import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { activeRunForWorkspacePath } from "../../storage";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../../storage";
import { resolve } from "node:path";

/**
 * Threads that are not Lane Pilot's but work in a folder where a Lane Pilot run merges writers' work. Agents on the
 * market keep the shared checkout off-limits (each agent its own worktree) and never move someone's uncommitted
 * work; when a person or another chat does edit there, the writers' merges stop on those edits. Lane Pilot remembers
 * who works in the folder and asks them by name only when their edits block a merge.
 */

const GUESTS = (path: string) => `checkout-guests:${resolve(path)}`;
/** A guest older than this no longer counts as working in the folder. */
const GUEST_TTL_MS = 6 * 3600_000;
type Guest = { threadId: string; at: number };
type Kv = BbPluginApi["storage"]["kv"];

/** The open Lane Pilot run that merges into this folder, if any. */
export function activeRunFor(db: LanePilotDatabase, path: string): { id: string; pmThreadId: string | null } | null {
  const row = activeRunForWorkspacePath(db, resolve(path), Date.now() - 24 * 3600_000);
  return row ?? null;
}

export async function listGuests(kv: Kv, path: string, now = Date.now()): Promise<Guest[]> {
  const value = await kv.get(GUESTS(path));
  return (Array.isArray(value) ? value as Guest[] : []).filter((row) => row && typeof row.threadId === "string" && now - row.at < GUEST_TTL_MS);
}

/**
 * Called for every send of a thread that is not a Lane Pilot chat. When it works in a folder of an active run and is
 * not one of Lane Pilot's own helpers, it is remembered; nothing is sent to it.
 */
export async function noteCheckoutGuest(bb: BbPluginApi, db: LanePilotDatabase, threadId: string, path: string | null | undefined): Promise<void> {
  if (!path) return;
  const run = activeRunFor(db, path);
  if (!run || run.pmThreadId === threadId) return;
  const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound) as Record<string, unknown> | null;
  if (metadata && typeof metadata.role === "string") return;
  const now = Date.now();
  const guests = (await listGuests(bb.storage.kv, path, now)).filter((row) => row.threadId !== threadId);
  await bb.storage.kv.set(GUESTS(path), [{ threadId, at:now }, ...guests].slice(0, 10) as never);
  // No up-front notice into the chat: the owner's chats stay clean; a guest is asked only when its edits block a merge.
}

