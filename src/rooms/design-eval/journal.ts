import { createHash } from "node:crypto";
import { isDesignJournalEvent, type DesignCritiqueCase, type DesignJournalEntry, type DesignJournalEvent, type DesignJournalLine } from "@lane-pilot/contracts";

/** The design journal's KV key: the drawing lines only, in the shape main always wrote (a list capped at 2000), so older code reads it unchanged. */
export const DESIGN_JOURNAL_KEY = "lp.design.journal";
/** Set cases a critique asked to store for later checks of the judge (SMA k_lib_dfeedback). */
export const DESIGN_CRITIQUE_CASES_KEY = "lp.design.critique-cases";
/** The owner's words and the pair judgements: a second key, so older code never reads an event as a drawing and events never push drawings out. */
export const DESIGN_EVENTS_KEY = "lp.design.events";
const LINE_CAP = 2000, EVENT_CAP = 1000;

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };

/** The dedupe key of a drawing line: the same packet appended twice in a row is one fact. */
export const designJournalKey = (line: Pick<DesignJournalLine, "phaseId" | "drawingSha" | "designer">): string =>
  createHash("sha256").update(`${line.phaseId}|${line.drawingSha}|${line.designer}`).digest("hex").slice(0, 16);
const keyOf = (line: DesignJournalLine): string => line.key ?? designJournalKey(line);

const lineEntries = async (kv: { get(key: string): Promise<unknown> }): Promise<DesignJournalLine[]> =>
  (((await kv.get(DESIGN_JOURNAL_KEY)) as DesignJournalEntry[] | null) ?? []).filter((entry): entry is DesignJournalLine => !isDesignJournalEvent(entry));
const eventEntries = async (kv: { get(key: string): Promise<unknown> }): Promise<DesignJournalEvent[]> =>
  (((await kv.get(DESIGN_EVENTS_KEY)) as DesignJournalEntry[] | null) ?? []).filter(isDesignJournalEvent);

/** Every drawing line of the journal, with the word and pair events folded in: readers see the same shape as before. */
export async function designJournalLines(kv: { get(key: string): Promise<unknown> }): Promise<DesignJournalLine[]> {
  // Copies: folding must not edit what the store handed out.
  const lines = (await lineEntries(kv)).map((line) => ({ ...line }));
  for (const entry of await eventEntries(kv)) {
    if (entry.event === "owner-word") {
      // The word belongs to the drawing it was said about, not to whatever line the phase has by now. An event without a target (older) takes the latest.
      const own = lines.filter((line) => line.phaseId === entry.phaseId);
      const last = entry.line ? own.filter((line) => keyOf(line) === entry.line).filter((line) => entry.lineAt === undefined || line.at === entry.lineAt).at(-1) ?? own.filter((line) => keyOf(line) === entry.line).at(-1) : own.at(-1);
      if (last) { last.ownerWord = entry.word; if (entry.word === "no") last.firstPass = false; }
    } else {
      // A paired judgement folds into one line per phaseId (model and person verdicts may land as separate events), so the
      // training ratios count model-person agreement like any critique+word.
      const existing = lines.find((line) => line.pair && line.phaseId === entry.phaseId);
      // An event with no person starts a pair (a repeat with --again forgets the old verdicts); one with a person is the answer and keeps the model's.
      const start = entry.person === null;
      const model = entry.model ?? (start ? null : existing?.pair?.model ?? null);
      const modelFrom = entry.model ? entry.modelFrom : start ? undefined : existing?.pair?.modelFrom;
      const pair = { order: entry.order, model, person: entry.person ?? (start ? null : existing?.pair?.person ?? null), ...(modelFrom ? { modelFrom } : {}) };
      const line: DesignJournalLine = existing ?? {
        at: entry.at, projectId: "", phaseId: entry.phaseId, designer: "design-pair", reviewer: null, drawingSha: "",
        firstPass: false, critique: null, codeScore: null, ownerWord: null, pair,
      };
      line.pair = pair;
      line.critique = pair.model ? { scores: {}, verdict: "pass", notes: `design pair ${pair.order}` } : null;
      line.ownerWord = pair.person ? (pair.person === pair.model ? "yes" : "no") : null;
      line.firstPass = pair.model !== null && pair.model === pair.person;
      if (!existing) lines.push(line);
    }
  }
  return lines;
}

/** The pair judgement stored for a phase (its presentation order and both verdicts), or null when none was ever started. */
export async function designPairOf(kv: { get(key: string): Promise<unknown> }, phaseId: string): Promise<NonNullable<DesignJournalLine["pair"]> | null> {
  return (await designJournalLines(kv)).find((line) => line.pair && line.phaseId === phaseId)?.pair ?? null;
}

/**
 * Append a line. A line is dropped only when it repeats the phase's previous entry (the same packet sent twice); the same drawing
 * made again after the owner's word, or after another drawing, is a new fact.
 */
export async function appendDesignJournalLine(kv: Kv, line: DesignJournalLine): Promise<void> {
  const lines = await lineEntries(kv);
  const key = line.key ?? designJournalKey(line);
  const previous = lines.filter((entry) => entry.phaseId === line.phaseId).at(-1);
  if (previous && keyOf(previous) === key && !(await eventEntries(kv)).some((event) => event.phaseId === line.phaseId && event.at >= previous.at)) return;
  await kv.set(DESIGN_JOURNAL_KEY, [...lines, { ...line, key }].slice(-LINE_CAP) as never);
}

/** Store one set case: the drawing's sha, the form and the verdict the judge should learn to give. */
export async function appendDesignCritiqueCase(kv: Kv, entry: DesignCritiqueCase): Promise<void> {
  const cases = ((await kv.get(DESIGN_CRITIQUE_CASES_KEY)) as DesignCritiqueCase[] | null) ?? [];
  await kv.set(DESIGN_CRITIQUE_CASES_KEY, [...cases, entry].slice(-500) as never);
}

/** The owner's word on a phase is an event naming the drawing it was said about (the phase's latest line now); a phase with no line takes none. */
export async function noteDesignJournalWord(kv: Kv, phaseId: string, decision: "yes" | "no"): Promise<void> {
  const last = (await lineEntries(kv)).filter((line) => line.phaseId === phaseId).at(-1);
  if (!last) return;
  await pushEvent(kv, { event: "owner-word", at: Date.now(), phaseId, word: decision, line: keyOf(last), lineAt: last.at });
}

/** A paired design judgement recorded as an append-only event; `person` lands later when the owner answers. */
export async function appendDesignPair(kv: Kv, pair: { phaseId: string; order: "ab" | "ba"; model: string | null; person: string | null; modelFrom?: "jev" | "shadow"; at?: number }): Promise<void> {
  await pushEvent(kv, { event: "design-pair", at: pair.at ?? Date.now(), phaseId: pair.phaseId, order: pair.order, model: pair.model, person: pair.person, ...(pair.modelFrom ? { modelFrom: pair.modelFrom } : {}) });
}

const pushEvent = async (kv: Kv, event: DesignJournalEvent): Promise<void> => {
  await kv.set(DESIGN_EVENTS_KEY, [...(await eventEntries(kv)), event].slice(-EVENT_CAP) as never);
};
