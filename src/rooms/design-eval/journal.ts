import { createHash } from "node:crypto";
import { isDesignJournalEvent, type DesignJournalEntry, type DesignJournalLine } from "@lane-pilot/contracts";

/** The design journal's KV key: one append-only list of entries, capped at 2000, every reader shares. */
export const DESIGN_JOURNAL_KEY = "lp.design.journal";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };

/** The dedupe key of a drawing line: the same packet appended twice is one fact. */
export const designJournalKey = (line: Pick<DesignJournalLine, "phaseId" | "drawingSha" | "designer">): string =>
  createHash("sha256").update(`${line.phaseId}|${line.drawingSha}|${line.designer}`).digest("hex").slice(0, 16);

const entries = async (kv: { get(key: string): Promise<unknown> }): Promise<DesignJournalEntry[]> =>
  ((await kv.get(DESIGN_JOURNAL_KEY)) as DesignJournalEntry[] | null) ?? [];

/** Every drawing line of the journal, with the word and pair events folded in: readers see the same shape as before. */
export async function designJournalLines(kv: { get(key: string): Promise<unknown> }): Promise<DesignJournalLine[]> {
  const all = await entries(kv);
  const lines = all.filter((entry): entry is DesignJournalLine => !isDesignJournalEvent(entry));
  for (const entry of all) {
    if (!isDesignJournalEvent(entry)) continue;
    if (entry.event === "owner-word") {
      const last = [...lines].reverse().find((line) => line.phaseId === entry.phaseId);
      if (last) { last.ownerWord = entry.word; if (entry.word === "no") last.firstPass = false; }
    } else {
      // A paired judgement folds into one line per phaseId (model and person verdicts may land as separate events), so the
      // training ratios count model-person agreement like any critique+word.
      const existing = lines.find((line) => line.pair && line.phaseId === entry.phaseId);
      const pair = { order: entry.order, model: entry.model ?? existing?.pair?.model ?? null, person: entry.person ?? existing?.pair?.person ?? null };
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

/** Append a line; a key already present is skipped, so a repeated packet never doubles a fact. */
export async function appendDesignJournalLine(kv: Kv, line: DesignJournalLine): Promise<void> {
  const all = await entries(kv);
  const key = line.key ?? designJournalKey(line);
  if (all.some((entry) => !isDesignJournalEvent(entry) && (entry.key ?? designJournalKey(entry)) === key)) return;
  await kv.set(DESIGN_JOURNAL_KEY, [...all, { ...line, key }].slice(-2000) as never);
}

/** The owner's word on a phase is its own event; folding applies it to the latest line («no» also fails its first pass). */
export async function noteDesignJournalWord(kv: Kv, phaseId: string, decision: "yes" | "no"): Promise<void> {
  const all = await entries(kv);
  await kv.set(DESIGN_JOURNAL_KEY, [...all, { event: "owner-word", at: Date.now(), phaseId, word: decision }].slice(-2000) as never);
}

/** A paired design judgement recorded as an append-only event; `person` lands later when the owner answers. */
export async function appendDesignPair(kv: Kv, pair: { phaseId: string; order: "ab" | "ba"; model: string | null; person: string | null; at?: number }): Promise<void> {
  const all = await entries(kv);
  await kv.set(DESIGN_JOURNAL_KEY, [...all, { event: "design-pair", at: pair.at ?? Date.now(), phaseId: pair.phaseId, order: pair.order, model: pair.model, person: pair.person }].slice(-2000) as never);
}
