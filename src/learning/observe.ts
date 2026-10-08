import { maskPii } from "../anamnesis/pii";
import { sensitiveReason } from "../anamnesis/model";
import type { OwnerMessage, OwnerMessageConsumer, OwnerMessageMeta } from "../anamnesis/owner-messages";
import type { Jev } from "../jev/run";
import type { LearningConfig } from "./config";
import { ANGRY_P, ownerMessageJudgment, type MessageDecision, type MessageSignals, type Route } from "./judgment";
import type { DecisionsClient, SecondOpinion } from "./opinion";
import { insertObservation, insertSignal, hasObservation, usageToday, type Db, type Observation } from "./store";
import { sha256Hex } from "@lane-pilot/kit";

/**
 * The hook on the owner's messages (T1, T2). It subscribes to the owner-message hub of the anamnesis room, so both learning layers read
 * one collector. For each message it decides whether to look at all (too short, over the daily cap, outside the sample), asks Jev what
 * the message is, asks the second opinion (OpenAI Decisions) when Jev is unsure, cannot answer, or the message falls in the agreement
 * sample, and writes one observation row. In `observe` mode that is all. In `active` mode a message that should be learned from keeps
 * its masked text for the extractor (extract.ts), and clear annoyance is passed on (frustration.ts).
 *
 * What is sent outside: the masked message (personal data replaced by tags) and the masked tail of the agent's reply before it, never
 * more. A message that touches health, family, money, documents or clients (`sensitiveReason`) goes to Jev only, is never kept as text
 * and never extracted from.
 */
export const MIN_CHARS = 12;
export const MAX_CHARS = 12_000;
const KEEP_HEAD = 1_800, KEEP_TAIL = 700, PREV_CHARS = 600, EXCERPT_CHARS = 280;
const ACK = /^(?:ок(?:ей)?|окей|ok(?:ay)?|да|нет|ага|угу|спасибо|благодарю|thanks?|thx|yes|no|yep|go|давай|го|делай|мерж(?:и|ите)?|погнали|принято|понял(?:а)?|хорошо|ладно|[+👍✅])[\s.!)]*$/iu;

export type ObserveDeps = {
  db: Db;
  config(): Promise<LearningConfig>;
  jev(): Jev | null;
  decisions: Pick<DecisionsClient, "ask"> | null;
  /** The agent's last reply before the message; absent for a message read from history. */
  prevReply?(message: OwnerMessage): Promise<string>;
  /** Clear annoyance (active mode): the room hands it to the self-repair watcher. */
  onFrustration?(input: { observation: Observation; message: OwnerMessage; quote: string | null; agentSaid: string | null }): Promise<void> | void;
  now?(): number;
  log?(line: string): void;
};

/** A stable fraction of 0..1 from a message id and a purpose, so a retry of the same message decides the same way. */
export function fractionOf(id: string, purpose: string): number {
  return parseInt(sha256Hex(`${purpose}:${id}`).slice(0, 8), 16) / 0x1_0000_0000;
}

const clip = (text: string): string => (text.length <= KEEP_HEAD + KEEP_TAIL ? text : `${text.slice(0, KEEP_HEAD)}\n…\n${text.slice(-KEEP_TAIL)}`);

const empty = (message: OwnerMessage, at: number, source: "live" | "catchup", patch: Partial<Observation>): Observation => ({
  id: message.id, threadId: message.threadId, projectId: message.projectId, at: message.at, judgedAt: at, source, chars: message.text.length, excerpt: null,
  state: "observed", skipReason: null, sensitive: false, jevStatus: null, receiptId: null, kind: null, kindP: null, learnP: null, durable: null, scope: null, frustration: null,
  deadline: null, route: null, secondStatus: null, secondKind: null, secondLearnP: null, secondDurable: null, secondRoute: null, secondMs: null, secondTokens: null,
  finalRoute: null, body: null, prev: null, review: null, reviewedAt: null, ...patch,
});

/** The route the two judges give together; `null` when neither answered. */
export function finalRouteOf(jev: Route | undefined, second: Route | undefined, secondAskable: boolean): "learn" | "none" | null {
  if (jev && second) {
    if (jev === second) return jev === "learn" ? "learn" : "none";
    if (jev === "contested") return second === "learn" ? "learn" : "none";
    if (second === "contested") return jev === "learn" ? "learn" : "none";
    return "learn"; // one says learn, the other none: the extractor reads it
  }
  if (jev) return jev === "learn" ? "learn" : jev === "contested" ? (secondAskable ? "learn" : "none") : "none";
  if (second) return second === "learn" ? "learn" : "none";
  return null;
}

type JevResult = { status: string; decision: MessageDecision | null; receiptId: number | null };

async function askJev(jev: Jev | null, message: OwnerMessage, text: string, prev: string): Promise<JevResult> {
  if (!jev || !jev.enabled()) return { status: "off", decision: null, receiptId: null };
  const verdict = await jev.judge(ownerMessageJudgment, { text, prev }, { projectId: message.projectId, subject: message.id });
  if (verdict.by === "jev") return { status: verdict.decision ? "ok" : "invalid", decision: verdict.decision, receiptId: verdict.receiptId };
  if (verdict.by === "fallback" && verdict.status === "shadow" && verdict.shadow && verdict.shadow.decision !== undefined) return { status: "ok", decision: verdict.shadow.decision, receiptId: verdict.receiptId };
  return { status: verdict.by === "fallback" ? verdict.status : "invalid", decision: null, receiptId: verdict.receiptId };
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
    if (trimmed.length < MIN_CHARS || ACK.test(trimmed)) return skip("short");
    if (trimmed.length > MAX_CHARS) return skip("pasted");
    if (fractionOf(message.id, "sample") >= config.sample) return skip("sample");
    const usage = usageToday(deps.db, at);
    if (usage.judged >= config.dailyJudgeCap) return skip("cap");

    const sensitive = sensitiveReason(trimmed) !== null;
    const text = clip(maskPii(trimmed).text);
    const prev = maskPii(((await deps.prevReply?.(message).catch(() => "")) ?? "").trim()).text.slice(-PREV_CHARS);

    const jev = await askJev(deps.jev(), message, text, prev);

    // The second opinion: never for a sensitive message; for a contested one, when Jev cannot answer, and for the agreement sample.
    const jevRoute = jev.decision?.route;
    const wantSecond = !sensitive && config.secondOpinion && deps.decisions !== null
      && (jev.decision === null || jevRoute === "contested" || fractionOf(message.id, "agree") < config.agreeSample);
    const secondBudget = usage.second < config.secondOpinionDailyCap;
    let second: SecondOpinion | null = null;
    if (wantSecond && secondBudget) second = await deps.decisions!.ask({ text, prev });
    const secondSignals: MessageSignals | null = second?.ok ? second.signals : null;
    const secondAskable = !sensitive && config.secondOpinion && deps.decisions !== null && secondBudget && second?.ok !== false;

    const finalRoute = finalRouteOf(jevRoute, second?.ok ? second.route : undefined, secondAskable);
    const learns = finalRoute === "learn" && !sensitive;
    const row = empty(message, at, source, {
      excerpt: sensitive ? null : text.slice(0, EXCERPT_CHARS),
      state: finalRoute === null ? "skipped" : learns && config.mode === "active" ? "candidate" : "observed",
      skipReason: finalRoute === null ? "no_judge" : null, sensitive,
      jevStatus: jev.status, receiptId: jev.receiptId,
      kind: jev.decision?.kind ?? null, kindP: jev.decision?.kindP ?? null, learnP: jev.decision?.learnP ?? null, durable: jev.decision?.durable ?? null,
      scope: jev.decision?.scope ?? null, frustration: jev.decision?.frustration ?? secondSignals?.frustration ?? null, deadline: jev.decision?.deadline ?? null, route: jevRoute ?? null,
      secondStatus: second ? (second.ok ? "ok" : second.status) : null, secondKind: secondSignals?.kind ?? null, secondLearnP: secondSignals?.learnP ?? null,
      secondDurable: secondSignals?.durable ?? null, secondRoute: second?.ok ? second.route : null, secondMs: second?.latencyMs ?? null, secondTokens: second?.ok ? second.tokensIn : null,
      finalRoute, ...(learns && config.mode === "active" ? { body: text, prev } : {}),
    });
    insertObservation(deps.db, row);

    // Annoyance (T6): Jev's own reading, or the second opinion's when Jev could not answer.
    const annoyed = jev.decision ? jev.decision.frustration : secondSignals?.frustration ?? 0;
    if (annoyed >= ANGRY_P) {
      insertSignal(deps.db, { kind: "frustration", projectId: message.projectId, ref: message.id, p: annoyed, detail: `thread ${message.threadId}`, at });
      if (config.mode === "active") await deps.onFrustration?.({ observation: row, message, quote: sensitive ? null : text.slice(0, 240), agentSaid: sensitive || !prev ? null : prev.slice(-300) });
    }
    return row;
  }

  const consumer: OwnerMessageConsumer = {
    name: "learning",
    async handle(batch, meta) {
      for (const message of batch) {
        try { await observe(message, meta); }
        catch (cause) { deps.log?.(`learning: message ${message.id} not judged: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
    },
  };
  return { observe, consumer };
}
export type Observer = ReturnType<typeof createObserver>;
