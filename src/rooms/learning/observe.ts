import { maskPii } from "../anamnesis";
import { sensitiveReason } from "../anamnesis";
import type { OwnerMessage, OwnerMessageConsumer, OwnerMessageMeta } from "../anamnesis";
import { isMachineMessage } from "../phase";
import type { LearningConfig } from "./config";
import { insertObservation, hasObservation, usageToday, type Db, type Observation } from "./store";

/**
 * The hook on the owner's messages (T1). It subscribes to the owner-message hub of the anamnesis room, so both learning layers read
 * one collector. No model reads a message here. A deterministic pre-filter decides whether a message is kept as a raw candidate:
 * machine text (the PM's own prompts, reports and system notes: `isMachineMessage`) is dropped, so is a trivially short
 * acknowledgement, a pasted wall of text and anything over the day's cap. What is left keeps its masked text until the night run of
 * the extractor (extract.ts) reads the day's candidates in batches and decides which of them teach something.
 *
 * What is sent outside, by that night run only: the masked message and the masked tail of the agent's reply before it, never more.
 * A message that touches health, family, money, documents or clients (`sensitiveReason`) is recorded but never kept as text and
 * never sent anywhere.
 */
export const MIN_CHARS = 12;
export const MAX_CHARS = 12_000;
const KEEP_HEAD = 1_800, KEEP_TAIL = 700, PREV_CHARS = 600, EXCERPT_CHARS = 280;
const ACK = /^(?:ок(?:ей)?|окей|ok(?:ay)?|да|нет|ага|угу|спасибо|благодарю|thanks?|thx|yes|no|yep|go|давай|го|делай|мерж(?:и|ите)?|погнали|принято|понял(?:а)?|хорошо|ладно|[+👍✅])[\s.!)]*$/iu;

export type ObserveDeps = {
  db: Db;
  config(): Promise<LearningConfig>;
  /** The agent's last reply before the message; absent for a message read from history. */
  prevReply?(message: OwnerMessage): Promise<string>;
  now?(): number;
  log?(line: string): void;
};

const clip = (text: string): string => (text.length <= KEEP_HEAD + KEEP_TAIL ? text : `${text.slice(0, KEEP_HEAD)}\n…\n${text.slice(-KEEP_TAIL)}`);

const empty = (message: OwnerMessage, at: number, source: "live" | "catchup", patch: Partial<Observation>): Observation => ({
  id: message.id, threadId: message.threadId, projectId: message.projectId, at: message.at, judgedAt: at, source, chars: message.text.length, excerpt: null,
  state: "observed", skipReason: null, sensitive: false, body: null, prev: null, ...patch,
});

/** Why a message is not a candidate, or null when it is one. Pure; the order is cheapest first. */
export function prefilterReason(text: string): "machine" | "short" | "pasted" | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS || ACK.test(trimmed)) return "short";
  if (isMachineMessage(trimmed)) return "machine";
  if (trimmed.length > MAX_CHARS) return "pasted";
  return null;
}

export function createObserver(deps: ObserveDeps) {
  const now = deps.now ?? Date.now;

  async function observe(message: OwnerMessage, meta: OwnerMessageMeta): Promise<Observation | null> {
    const config = await deps.config();
    if (!config.enabled || hasObservation(deps.db, message.id)) return null;
    const source = meta.live ? "live" as const : "catchup" as const;
    const at = now();
    const trimmed = message.text.trim();
    const skip = (reason: string): Observation => {
      const row = empty(message, at, source, { state: "skipped", skipReason: reason });
      insertObservation(deps.db, row);
      return row;
    };
    const reason = prefilterReason(trimmed);
    if (reason) return skip(reason);
    if (usageToday(deps.db, at).candidates >= config.dailyCandidateCap) return skip("cap");

    const sensitive = sensitiveReason(trimmed) !== null;
    if (sensitive) {
      const row = empty(message, at, source, { sensitive: true });
      insertObservation(deps.db, row);
      return row;
    }
    const text = clip(maskPii(trimmed).text);
    const prev = maskPii(((await deps.prevReply?.(message).catch((cause: unknown) => { deps.log?.(`learning: previous reply of ${message.id} unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return ""; })) ?? "").trim()).text.slice(-PREV_CHARS);
    const row = empty(message, at, source, { excerpt: text.slice(0, EXCERPT_CHARS), state: "candidate", body: text, prev });
    insertObservation(deps.db, row);
    return row;
  }

  const consumer: OwnerMessageConsumer = {
    name: "learning",
    async handle(batch, meta) {
      for (const message of batch) {
        try { await observe(message, meta); }
        catch (cause) { deps.log?.(`learning: message ${message.id} not recorded: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
    },
  };
  return { observe, consumer };
}
export type Observer = ReturnType<typeof createObserver>;
