import { appendLiveItems, liveItemId, recordOwnerDecision } from "./live-exam";
import type { LiveItem } from "./exam";
import type { ChangeDescriptor, Tier } from "./policy";

/**
 * sma decisions mine (SMA k_v_decisions): the founder's real decisions are mined from his own messages into drafts.
 * A draft is not an exam item: a person reads it and says `accept` (it joins the exam through the same
 * recordOwnerDecision + appendLiveItems path as every decision) or `dismiss` (it is dropped). Mining twice over the
 * same window never doubles a draft: the id is the item's own liveItemId.
 */
export const EXAM_DRAFTS_KEY = "policy:exam-v2-drafts";

export type DecisionDraft = {
  id: string;
  /** The owner message this was mined from. */
  ref: string;
  at: number;
  quote: string;
  decision: "approve" | "refuse";
  descriptor: ChangeDescriptor;
  expected: Tier;
  why: string;
};

type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };
export type MinedMessage = { id: string; at: number; text: string };
/** Whether one owner message approves or refuses a change, with the descriptor and tier to grade against. null = chatter. */
export type DecisionJudge = (message: MinedMessage) => Promise<Omit<DecisionDraft, "id" | "ref" | "at" | "quote"> | null>;

const clip = (text: string) => (text.length > 600 ? `${text.slice(0, 599)}…` : text);

async function loadDrafts(kv: Kv): Promise<DecisionDraft[]> {
  return (await kv.get<DecisionDraft[]>(EXAM_DRAFTS_KEY)) ?? [];
}

export async function mineDecisions(kv: Kv, messages: readonly MinedMessage[], judge: DecisionJudge): Promise<{ mined: number; skipped: number; total: number }> {
  const drafts = await loadDrafts(kv);
  const have = new Set(drafts.map((draft) => draft.id));
  let mined = 0;
  for (const message of messages) {
    const judged = await judge(message);
    if (!judged) continue;
    const id = liveItemId("owner_message", message.id, clip(message.text));
    if (have.has(id)) continue;
    drafts.push({ id, ref: message.id, at: message.at, quote: clip(message.text), ...judged });
    have.add(id);
    mined += 1;
  }
  if (mined) await kv.set(EXAM_DRAFTS_KEY, drafts as never);
  return { mined, skipped: messages.length - mined, total: drafts.length };
}

export type DraftAnswer = { ok: true; appended?: LiveItem } | { ok: false; reason: string };

/** `accept` puts the draft into the exam as an owner decision; `dismiss` drops it. Either way the draft leaves the store once. */
export async function settleDraft(kv: Kv, id: string, word: "accept" | "dismiss"): Promise<DraftAnswer> {
  const drafts = await loadDrafts(kv);
  const draft = drafts.find((row) => row.id === id);
  if (!draft) return { ok: false, reason: `no draft «${id}»` };
  await kv.set(EXAM_DRAFTS_KEY, drafts.filter((row) => row.id !== id) as never);
  if (word === "dismiss") return { ok: true };
  const item = recordOwnerDecision({ ref: draft.ref, at: draft.at, quote: draft.quote, descriptor: draft.descriptor, expected: draft.expected, why: draft.why });
  await appendLiveItems(kv, [item]);
  return { ok: true, appended: item };
}
