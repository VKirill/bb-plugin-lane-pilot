import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { TURN_REQUESTED, ownerMessagesOf } from "../anamnesis";
import type { EventLike, ThreadLike } from "../anamnesis";

/**
 * Checks that a term really comes from the owner (SMA rule 5, without a login or a form). The reference `<threadId>#<seq>` points at
 * one `client/turn/requested` event of a thread; it counts only when the shared owner-message filter of the anamnesis room accepts it:
 * BB stamped the request `initiator: "user"`, it has no `senderThreadId` (an agent's message to a thread), no system label, no retry
 * mark, and the thread is visible, top level, not made by a plugin and not deleted. Text an agent writes anywhere else, or quotes from
 * memory, has no such event, so it cannot carry a term.
 */
export type OwnerMessagePort = {
  getThread(threadId: string): Promise<ThreadLike | null>;
  /** Events of the thread with sequence numbers above `afterSeq`, oldest first. */
  listEvents(query: { threadId: string; afterSeq: number; limit: number }): Promise<EventLike[]>;
};

export type VerifiedOwnerMessage = { threadId: string; seq: number; index: number; messageId: string; at: number; text: string; sha256: string };

export const sha256Text = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `thr_x#12`, `thr_x#12:1` (the second input group of that event) or the id the owner-message collector gives, `thr_x:12:1`. */
export function parseOwnerRef(ref: string): { threadId: string; seq: number; index: number } | null {
  const hit = /^([^#:\s]+)(?:#|:)(\d+)(?::(\d+))?$/.exec(ref.trim());
  if (!hit) return null;
  const seq = Number(hit[2]);
  return Number.isSafeInteger(seq) && seq >= 0 ? { threadId: hit[1]!, seq, index: hit[3] ? Number(hit[3]) : 0 } : null;
}

export async function verifyOwnerMessage(port: OwnerMessagePort, ref: string): Promise<{ ok: true; message: VerifiedOwnerMessage } | { ok: false; error: string }> {
  const parsed = parseOwnerRef(ref);
  if (!parsed) return { ok: false, error: `--owner-msg «${ref}» is not a message reference; write <threadId>#<event seq>, for example thr_abc#42` };
  const thread = await port.getThread(parsed.threadId).catch(() => null);
  if (!thread) return { ok: false, error: `thread ${parsed.threadId} was not found` };
  const events = await port.listEvents({ threadId: parsed.threadId, afterSeq: parsed.seq - 1, limit: 1 });
  const event = events.find((item) => item.seq === parsed.seq);
  if (!event) return { ok: false, error: `thread ${parsed.threadId} has no user message at event ${parsed.seq}` };
  if (event.type !== TURN_REQUESTED) return { ok: false, error: `event ${parsed.seq} of ${parsed.threadId} is a ${event.type}, not a message to the agent` };
  const found = ownerMessagesOf(event, thread);
  const message = found[parsed.index];
  if (!message) {
    const why = event.data.initiator !== "user" ? `its initiator is «${String(event.data.initiator)}», not the user`
      : event.data.senderThreadId ? "it was sent by another thread (an agent)"
      : event.data.systemMessageKind != null && event.data.systemMessageKind !== "unlabeled" ? "it is a system message"
      : event.data.retryOfRequestId ? "it is a retry"
      : thread.originPluginId ? `the thread was made by the plugin ${thread.originPluginId}`
      : thread.parentThreadId ? "the thread is a child thread"
      : (thread.visibility ?? "visible") !== "visible" ? "the thread is hidden"
      : thread.deletedAt != null ? "the thread is deleted"
      : found.length ? `the event has only ${found.length} text input(s)` : "it holds no text from the user";
    return { ok: false, error: `${parsed.threadId}#${parsed.seq} is not a message the owner wrote: ${why}` };
  }
  return { ok: true, message: { threadId: message.threadId, seq: parsed.seq, index: parsed.index, messageId: message.id, at: message.at, text: message.text, sha256: sha256Text(message.text) } };
}

/** The SDK of a plugin as the port. */
export function sdkOwnerMessagePort(bb: BbPluginApi): OwnerMessagePort {
  return {
    getThread: async (threadId) => (await bb.sdk.threads.get({ threadId })) as unknown as ThreadLike | null,
    listEvents: async ({ threadId, afterSeq, limit }) => (await bb.sdk.threads.events.list({
      threadId, types: [TURN_REQUESTED], order: "asc", limit: String(limit), afterSeq: String(afterSeq),
    })) as unknown as EventLike[],
  };
}
