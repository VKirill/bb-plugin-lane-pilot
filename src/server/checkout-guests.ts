import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LanePilotDatabase } from "../database";
import { resolve } from "node:path";

/**
 * Threads that are not Lane Pilot's but work in a folder where a Lane Pilot run merges writers' work. Agents on the
 * market keep the shared checkout off-limits (each agent its own worktree) and never move someone's uncommitted
 * work; when a person or another chat does edit there, the writers' merges stop on those edits. Lane Pilot remembers
 * who works in the folder, tells them once to commit as they go, and asks them by name when their edits block a merge.
 */

const GUESTS = (path: string) => `checkout-guests:${resolve(path)}`;
const NOTICED = (threadId: string, runId: string) => `checkout-guest-noticed:${threadId}:${runId}`;
const ASKED = (threadId: string, path: string) => `checkout-guest-asked:${threadId}:${resolve(path)}`;
/** A guest older than this no longer counts as working in the folder. */
const GUEST_TTL_MS = 6 * 3600_000;
/** One question to a guest per folder in this time; the merge keeps waiting in between. */
const ASK_EVERY_MS = 60 * 60_000;

type Guest = { threadId: string; at: number };
type Kv = BbPluginApi["storage"]["kv"];

/** The open Lane Pilot run that merges into this folder, if any. */
export function activeRunFor(db: LanePilotDatabase, path: string): { id: string; pmThreadId: string | null } | null {
  const row = db.prepare(`SELECT r.id, r.pm_thread_id AS pmThreadId FROM lane_pilot_run r
    WHERE r.closed_at IS NULL AND r.writer_workspace_path=? AND EXISTS(
      SELECT 1 FROM lane_pilot_attempt a WHERE a.run_id=r.id AND a.updated_at > ?)
    ORDER BY r.updated_at DESC LIMIT 1`).get(resolve(path), Date.now() - 24 * 3600_000) as { id: string; pmThreadId: string | null } | undefined;
  return row ?? null;
}

export async function listGuests(kv: Kv, path: string, now = Date.now()): Promise<Guest[]> {
  const value = await kv.get(GUESTS(path)).catch(() => null);
  return (Array.isArray(value) ? value as Guest[] : []).filter((row) => row && typeof row.threadId === "string" && now - row.at < GUEST_TTL_MS);
}

/**
 * Called for every send of a thread that is not a Lane Pilot chat. When it works in a folder of an active run and is
 * not one of Lane Pilot's own helpers, it is remembered, and told once per run to commit its work as it goes.
 */
export async function noteCheckoutGuest(bb: BbPluginApi, db: LanePilotDatabase, threadId: string, path: string | null | undefined): Promise<void> {
  if (!path) return;
  const run = activeRunFor(db, path);
  if (!run || run.pmThreadId === threadId) return;
  const metadata = await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null) as Record<string, unknown> | null;
  if (metadata && typeof metadata.role === "string") return;
  const now = Date.now();
  const guests = (await listGuests(bb.storage.kv, path, now)).filter((row) => row.threadId !== threadId);
  await bb.storage.kv.set(GUESTS(path), [{ threadId, at:now }, ...guests].slice(0, 10) as never);
  if (await bb.storage.kv.get(NOTICED(threadId, run.id)).catch(() => null)) return;
  await bb.storage.kv.set(NOTICED(threadId, run.id), now as never);
  await bb.sdk.threads.send({ threadId, mode:"queue-if-active", input:[{ type:"text", mentions:[],
    text:`Lane Pilot: a development orchestrator is working in this directory (${resolve(path)}) — its writers merge their work into main here. Commit your changes immediately after finishing each change: uncommitted changes in the same files prevent merging their work. If your work takes long and it is too early to commit, do it in a separate git worktree instead of this directory.` }] } as never).catch(() => undefined);
}

/**
 * Asks the threads working in the folder to commit the edits that block a merge. Returns the threads asked; empty
 * when nobody is known, so the caller tells the PM instead.
 */
export async function askGuestsToCommit(bb: BbPluginApi, path: string, files: string[], taskId: string): Promise<string[]> {
  const asked: string[] = [];
  const now = Date.now();
  for (const guest of await listGuests(bb.storage.kv, path, now)) {
    const thread = await bb.sdk.threads.get({ threadId:guest.threadId }).catch(() => null) as { archivedAt?: unknown } | null;
    if (!thread || thread.archivedAt) continue;
    const last = await bb.storage.kv.get(ASKED(guest.threadId, path)).catch(() => null);
    if (typeof last === "number" && now - last < ASK_EVERY_MS) { asked.push(guest.threadId); continue; }
    await bb.storage.kv.set(ASKED(guest.threadId, path), now as never);
    const sent = await bb.sdk.threads.send({ threadId:guest.threadId, mode:"queue-if-active", input:[{ type:"text", mentions:[],
      text:`Lane Pilot: there are uncommitted changes in ${resolve(path)} in files: ${files.join(", ")}. Because of them, accepted task ${taskId} from the development orchestrator cannot be merged. If these are your changes and they are ready, commit them now. If not ready, commit as soon as they are ready. Never drop or revert changes for this (no git checkout/restore/reset/stash drop): if you cannot or should not commit, leave them as is and tell the owner. If the changes are not yours, do not touch them and answer that they are not yours. Lane Pilot will merge the task automatically once the files are committed, and will wait up to 2 hours.` }] } as never).then(() => true, () => false);
    if (sent) asked.push(guest.threadId);
  }
  return asked;
}
