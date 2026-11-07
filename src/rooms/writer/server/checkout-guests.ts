import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { resolve } from "node:path";
import { sendServiceMessage } from "../../relay/server";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import { listGuests } from "../../platform/server";

const ASKED = (threadId: string, path: string) => `checkout-guest-asked:${threadId}:${resolve(path)}`;
/** One question to a guest per folder in this time; the merge keeps waiting in between. */
const ASK_EVERY_MS = 60 * 60_000;

/**
 * Asks the threads working in the folder to commit the edits that block a merge. Returns the threads asked; empty
 * when nobody is known, so the caller tells the PM instead.
 */
export async function askGuestsToCommit(bb: BbPluginApi, path: string, files: string[], taskId: string, pmThreadId?: string): Promise<string[]> {
  const asked: string[] = [];
  const now = Date.now();
  for (const guest of await listGuests(bb.storage.kv, path, now)) {
    const thread = await orMiss(bb.sdk.threads.get({ threadId:guest.threadId }), null, isNotFound) as { archivedAt?: unknown } | null;
    if (!thread || thread.archivedAt) continue;
    const last = await bb.storage.kv.get(ASKED(guest.threadId, path));
    if (typeof last === "number" && now - last < ASK_EVERY_MS) { asked.push(guest.threadId); continue; }
    await bb.storage.kv.set(ASKED(guest.threadId, path), now as never);
    const sent = await sendServiceMessage(bb, { threadId:guest.threadId, senderThreadId:pmThreadId,
      text:`Lane Pilot: there are uncommitted changes in ${resolve(path)} in files: ${files.join(", ")}. Because of them, accepted task ${taskId} from the development orchestrator cannot be merged. If these are your changes and they are ready, commit them now. If not ready, commit as soon as they are ready. Never drop or revert changes for this (no git checkout/restore/reset/stash drop): if you cannot or should not commit, leave them as is and tell the owner. If the changes are not yours, do not touch them and answer that they are not yours. Lane Pilot will merge the task automatically once the files are committed, and will wait up to 2 hours.` }).then(() => true, () => false);
    if (sent) asked.push(guest.threadId);
  }
  return asked;
}
