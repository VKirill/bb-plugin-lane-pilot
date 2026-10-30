import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** How recently a PM chat must have moved for an informational notice to be worth sending into it. */
export const PM_NOTICE_FRESH_MS = 30 * 60_000;

/**
 * An informational notice to a PM chat, sent only while that chat is warm: a message into a chat idle for hours
 * starts a turn that rereads its whole context with the prompt cache gone (2026-10-30: the stale-run sweep of 0.1.390
 * woke 44 PM chats idle for days). A cold chat gets nothing; the fact stays in the run records and logs.
 */
export async function sendPmNotice(bb: Pick<BbPluginApi, "sdk">, threadId: string, text: string, now = Date.now(), freshMs = PM_NOTICE_FRESH_MS): Promise<boolean> {
  const thread = await Promise.resolve().then(() => bb.sdk.threads.get({ threadId })).catch(() => null) as { updatedAt?: unknown } | null;
  const updatedAt = Number(thread?.updatedAt ?? 0);
  if (!thread || !Number.isFinite(updatedAt) || now - updatedAt > freshMs) return false;
  await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never).catch(() => undefined);
  return true;
}
