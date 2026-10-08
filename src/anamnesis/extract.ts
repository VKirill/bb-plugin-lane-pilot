import { createHash } from "node:crypto";
import { SENSITIVE_FROM, type FragmentDecision, type MatchDecision, type MatchInput } from "./judgment";
import type { Hub } from "./hub";
import { scrubQuote, sensitiveReason, type AnamnesisRecord, type Kind } from "./model";
import type { UpsertSummary } from "./ops";
import { maskPii } from "./pii";
import { messageEvidence, type OwnerMessage, type OwnerMessageConsumer, type OwnerMessageMeta } from "./owner-messages";

/**
 * Learning from the owner's messages as they come (A4): the at-message path and the daily pass use this one function.
 *
 * A message passes four gates, each cheaper than the next: long enough, not about health/money/family by the local word rules
 * (those are held back and never leave), not seen before, and inside the day's ceiling. What is left is masked (keys by `scrubQuote`,
 * personal data by `maskPii`) and goes to Jev: «is this about the owner, and what kind of fact». A kept fragment is compared with the
 * nearest record of the same kind (in code first, then Jev): a restatement adds evidence to that record, a contradiction becomes a
 * candidate marked `contradicts` that the owner sees (the old record is never changed), anything else is a new record.
 * Sensitive fragments are stored as sensitive candidates and are never compared, so no sensitive record text goes to Jev either.
 */
export const MIN_FRAGMENT_CHARS = 30;
export const MAX_FRAGMENT_CHARS = 1_500;
/** The most fragments one Madrid day may send to Jev, both paths together, unless the setting (`maxClassify`) says otherwise. */
export const DEFAULT_DAILY_FRAGMENTS = 200;
export const HARD_DAILY_FRAGMENTS = 2_000;
const BATCH = 20;
const SEEN_KEEP = 5_000;
export const SEEN_KEY = "anamnesis:seen";
export const BUDGET_KEY = "anamnesis:budget";
/** A fragment this close in words to a record is shown to Jev as that record's possible restatement. */
const MIN_OVERLAP = 0.25;
const DUPLICATE_OVERLAP = 0.8;
/** A record Jev is this sure about starts as a draft; anything less waits as a candidate until a second message agrees. */
const DRAFT_FROM = 0.8;

export type ExtractDeps = {
  hub: Pick<Hub, "ask" | "config" | "kv">;
  /** Jev's fragment judgment over masked texts; null for one it could not judge. Absent: nothing can be classified. */
  judge?: ((texts: string[], signal?: AbortSignal) => Promise<Array<FragmentDecision | null>>) | undefined;
  /** Jev's restatement/contradiction judgment; absent or null means «new». */
  match?: ((pairs: MatchInput[], signal?: AbortSignal) => Promise<Array<MatchDecision | null>>) | undefined;
  now(): number;
};

export type ExtractReport = {
  live: boolean; considered: number; tooShort: number; heldBackSensitive: number; alreadySeen: number; overCeiling: number;
  asked: number; masked: number; nothing: number; unavailable: number; kept: number;
  created: number; merged: number; contradictions: number; duplicates: number; stored: UpsertSummary | null;
  /** False while a fragment is left (cut by the ceiling or not judged): the daily pass then keeps its window open. */
  complete: boolean; note?: string;
};

const emptyReport = (live: boolean): ExtractReport => ({ live, considered: 0, tooShort: 0, heldBackSensitive: 0, alreadySeen: 0, overCeiling: 0,
  asked: 0, masked: 0, nothing: 0, unavailable: 0, kept: 0, created: 0, merged: 0, contradictions: 0, duplicates: 0, stored: null, complete: true });

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** The day the ceiling counts in: Madrid, where the owner's day and the 04:00 pass are. */
export const madridDay = (at: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(at);
export const madridHour = (at: number): number => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" }).format(at));

/** The candidate a classified fragment becomes (also used by the first load). */
export function candidateRecord(message: OwnerMessage, decision: FragmentDecision & { kind: Kind }, status: "candidate" | "draft" = "candidate", extraAttributes: Record<string, unknown> = {}): Record<string, unknown> {
  const text = scrubQuote(message.text, 240);
  return {
    kind: decision.kind, key: `msg-${sha(message.id)}`, title: text.slice(0, 80), statement: text, status,
    ...(decision.sensitive >= SENSITIVE_FROM ? { sensitivity: "sensitive" } : {}),
    attributes: { origin: "jev-fragment", kindP: Math.round(decision.kindP * 100) / 100, aboutOwner: Math.round(decision.aboutOwner * 100) / 100, sensitiveP: Math.round(decision.sensitive * 100) / 100, ...extraAttributes },
    confidence: Math.min(decision.kindP, decision.aboutOwner), evidence: [messageEvidence(message, text)],
  };
}

const stem = (word: string): string => word.slice(0, 5);
const wordsOf = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2).map(stem));
/** Shared word stems over the shorter text's: 0 to 1. */
export function overlap(a: string, b: string): number {
  const left = wordsOf(a), right = wordsOf(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

const keyOf = (record: Pick<AnamnesisRecord, "id" | "kind">): string => record.id.slice(record.kind.length + 1);

/** Work on one hub's ceiling and seen-list runs one at a time: the at-message path and the daily pass can meet. */
const queues = new WeakMap<object, Promise<unknown>>();
function serial<T>(owner: object, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(owner) ?? Promise.resolve()).then(work, work);
  queues.set(owner, run.catch(() => undefined));
  return run;
}

async function takeCeiling(hub: ExtractDeps["hub"], want: number, now: number): Promise<number> {
  const config = await hub.config();
  const ceiling = Math.min(config.maxClassify ?? DEFAULT_DAILY_FRAGMENTS, HARD_DAILY_FRAGMENTS);
  const day = madridDay(now);
  const stored = await hub.kv.get<{ day?: string; used?: number }>(BUDGET_KEY);
  const used = stored?.day === day ? Math.max(0, Number(stored.used) || 0) : 0;
  const allowed = Math.max(0, Math.min(want, ceiling - used));
  if (allowed) await hub.kv.set(BUDGET_KEY, { day, used: used + allowed } as never);
  return allowed;
}

export async function extractMessages(deps: ExtractDeps, messages: readonly OwnerMessage[], options: { live?: boolean; signal?: AbortSignal | undefined } = {}): Promise<ExtractReport> {
  return await serial(deps.hub, () => extractNow(deps, messages, options));
}

type Kept = { message: OwnerMessage; masked: string; decision: FragmentDecision & { kind: Kind } };
type Target = { kind: Kind; key: string; title: string };

async function extractNow(deps: ExtractDeps, messages: readonly OwnerMessage[], options: { live?: boolean; signal?: AbortSignal | undefined }): Promise<ExtractReport> {
  const { hub } = deps;
  const report = emptyReport(options.live === true);
  report.considered = messages.length;
  const status = await hub.ask({ op: "status" });
  if (status.sources.find((source) => source.source === "bb-message")?.enabled === false) { report.note = "the BB messages source is switched off"; return report; }

  const seen = new Set((await hub.kv.get<string[]>(SEEN_KEY)) ?? []);
  const eligible: OwnerMessage[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (text.length < MIN_FRAGMENT_CHARS) { report.tooShort += 1; continue; }
    if (sensitiveReason(text)) { report.heldBackSensitive += 1; continue; }
    if (seen.has(sha(message.id))) { report.alreadySeen += 1; continue; }
    eligible.push(message);
  }
  if (!eligible.length) return report;
  if (!deps.judge) { report.note = "Jev is not available (no key or switched off)"; report.complete = false; return report; }

  // The newest go first when the day's ceiling cuts the rest; the rest is read again by the next pass.
  eligible.sort((a, b) => b.at - a.at);
  const allowed = await takeCeiling(hub, eligible.length, deps.now());
  report.overCeiling = eligible.length - allowed;
  if (report.overCeiling > 0) report.complete = false;
  const chosen = eligible.slice(0, allowed).sort((a, b) => a.at - b.at);

  const kept: Kept[] = [];
  const settled: string[] = [];
  for (let i = 0; i < chosen.length; i += BATCH) {
    options.signal?.throwIfAborted();
    const batch = chosen.slice(i, i + BATCH);
    const outgoing = batch.map((message) => maskPii(scrubQuote(message.text, MAX_FRAGMENT_CHARS)));
    report.masked += outgoing.filter((item) => item.count > 0).length;
    const decisions = await deps.judge(outgoing.map((item) => item.text), options.signal);
    batch.forEach((message, j) => {
      report.asked += 1;
      const decision = decisions[j];
      if (!decision) { report.unavailable += 1; report.complete = false; return; }
      settled.push(sha(message.id));
      if (decision.kind === "nothing") { report.nothing += 1; return; }
      report.kept += 1;
      kept.push({ message, masked: outgoing[j]!.text, decision: decision as Kept["decision"] });
    });
  }

  // Within one batch, a fragment that says what an earlier one already said only adds its evidence to it.
  const firsts: Kept[] = [];
  const twins: Array<[Kept, Kept]> = [];
  for (const item of kept) {
    const twin = firsts.find((other) => other.decision.kind === item.decision.kind && overlap(other.masked, item.masked) >= DUPLICATE_OVERLAP);
    if (twin) { twins.push([item, twin]); report.duplicates += 1; } else firsts.push(item);
  }

  // The known records a fragment may restate: non-sensitive, of the same kind. A sensitive fragment is never compared.
  const comparable = firsts.filter((item) => item.decision.sensitive < SENSITIVE_FROM);
  const known = new Map<Kind, AnamnesisRecord[]>();
  for (const kind of new Set(comparable.map((item) => item.decision.kind))) known.set(kind, (await hub.ask({ op: "list", kinds: [kind], limit: 300 })).records);
  const nearest = new Map<Kept, AnamnesisRecord>();
  for (const item of comparable) {
    let best: AnamnesisRecord | null = null, bestScore = MIN_OVERLAP;
    for (const record of known.get(item.decision.kind) ?? []) {
      const score = overlap(item.masked, `${record.title} ${record.statement}`);
      if (score >= bestScore) { best = record; bestScore = score; }
    }
    if (best) nearest.set(item, best);
  }
  const pairs = [...nearest].map(([item, record]) => ({ item, input: { fragment: item.masked, known: maskPii(scrubQuote(`${record.title}. ${record.statement}`, 600)).text } }));
  const answers = pairs.length && deps.match ? await deps.match(pairs.map((pair) => pair.input), options.signal) : [];
  const relationOf = new Map<Kept, MatchDecision | null>(pairs.map((pair, index) => [pair.item, answers[index] ?? null]));

  const upserts: Array<Record<string, unknown>> = [];
  const targetOf = new Map<Kept, Target>();
  for (const item of firsts) {
    const record = nearest.get(item), relation = relationOf.get(item);
    if (record && relation?.relation === "same") {
      // A restatement: one more piece of evidence on the record that already says it. A candidate that two messages agree on becomes a draft.
      targetOf.set(item, { kind: record.kind, key: keyOf(record), title: record.title });
      upserts.push({ ...targetOf.get(item), ...(record.status === "candidate" ? { status: "draft" } : {}), evidence: [messageEvidence(item.message, scrubQuote(item.message.text, 240))] });
      report.merged += 1;
      continue;
    }
    // A sensitive fragment always waits as a candidate: the owner looks at it before it becomes a draft.
    const confident = Math.min(item.decision.kindP, item.decision.aboutOwner) >= DRAFT_FROM && item.decision.sensitive < SENSITIVE_FROM;
    const created = record && relation?.relation === "contradicts"
      ? candidateRecord(item.message, item.decision, "candidate", { contradicts: [record.id] })
      : candidateRecord(item.message, item.decision, confident ? "draft" : "candidate");
    targetOf.set(item, { kind: item.decision.kind, key: String(created.key), title: String(created.title) });
    upserts.push(created);
    if (record && relation?.relation === "contradicts") report.contradictions += 1; else report.created += 1;
  }
  for (const [item, twin] of twins) upserts.push({ ...targetOf.get(twin)!, evidence: [messageEvidence(item.message, scrubQuote(item.message.text, 240))] });

  if (upserts.length) report.stored = await hub.ask({ op: "upsert", actor: "auto:jev-fragment", reason: options.live ? "at-message extraction" : "daily extraction", records: upserts });
  // Judged messages are not read again, whatever came of them; the ones Jev could not judge stay open.
  if (settled.length) await hub.kv.set(SEEN_KEY, [...seen, ...settled].slice(-SEEN_KEEP) as never);
  return report;
}

/** The anamnesis subscriber of the shared owner-message hub; `last()` is what its latest batch did. Does nothing while the extraction switch is off. */
export function createExtractConsumer(deps: ExtractDeps): OwnerMessageConsumer & { last(): ExtractReport | null } {
  let last: ExtractReport | null = null;
  return {
    name: "anamnesis",
    async handle(batch: OwnerMessage[], meta: OwnerMessageMeta) {
      if ((await deps.hub.config()).extract !== true) { last = { ...emptyReport(meta.live), considered: batch.length, complete: false, note: "extraction is switched off" }; return; }
      last = await extractMessages(deps, batch, { live: meta.live });
    },
    last: () => last,
  };
}
