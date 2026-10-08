import type { Kv } from "./ops";

/**
 * Annoyance becomes an incident for the self-repair watcher (T6). When Jev reads a clearly frustrated owner message (`frustration` at
 * least 0.5 on the «clearly frustrated» level), the room writes one record here, in the plugin's key-value store, and the watcher
 * (`collect` in server/self-repair.ts, the same way it reads the output guard's blocked list) turns it into an incident of kind `owner`
 * with the thread and what the agent had just said. The record holds a masked quote of at most 240 characters and the tail of the
 * agent's reply; never the whole message. Nothing here is a verdict that the owner is right: the repair thread decides whether it is
 * Lane Pilot's fault (`fixed`) or the agents' or the project's (`not-lane-pilot`, with a note to the PM).
 */
export const FRUSTRATION_KEY = "learning:frustration";
const KEEP = 50;
/** A thread the owner was annoyed in is raised once a day, however many messages show it. */
export const ONE_PER_THREAD_MS = 24 * 3_600_000;

export type FrustrationRecord = {
  at: number; projectId: string; threadId: string; messageId: string; p: number;
  quote: string | null; agentSaid: string | null; pmThreadId: string | null; runId: string | null;
};

export async function recordFrustration(kv: Kv, record: FrustrationRecord): Promise<boolean> {
  const known = await kv.get<FrustrationRecord[]>(FRUSTRATION_KEY).catch(() => null);
  const list = Array.isArray(known) ? known : [];
  if (list.some((row) => row.messageId === record.messageId || (row.threadId === record.threadId && record.at - row.at < ONE_PER_THREAD_MS))) return false;
  await kv.set(FRUSTRATION_KEY, [...list, record].slice(-KEEP) as never);
  return true;
}

/** The words of the incident the repair engineer reads. */
export function frustrationReason(record: Pick<FrustrationRecord, "quote" | "agentSaid" | "p">): string {
  return [
    `the owner was clearly frustrated in a chat (probability ${record.p}).`,
    record.quote ? `He wrote (personal data masked): «${record.quote}»` : "The message is withheld because it touches private matters.",
    ...(record.agentSaid ? [`The agent had just said: «${record.agentSaid}»`] : []),
    "Find out what Lane Pilot did or failed to do that led to this (a prompt, a tool, a flow, a gate that stopped work, a question it should not have asked) and fix that if it is Lane Pilot's. If it is the agent's choice or the project's, change no code and tell the PM what to do differently.",
  ].join(" ");
}
