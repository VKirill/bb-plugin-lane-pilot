import { memoryTokens } from "./terms";

/**
 * Two notes that disagree (SMA block 4, P2-7). Deterministic heuristics only: a pair is a conflict when the two notes are about the
 * same thing (they name the same file path, or share most of their tags) and say different things about it in one of three ways:
 *
 *  - `value`: the same quantity with two numbers («cache TTL is 24 h» and «cache TTL is 48 h»), the number and its unit sit next to the same label words;
 *  - `polarity`: the same sentence, once affirmed and once negated («the worker retries failed jobs» and «the worker does not retry failed jobs»);
 *  - `literal`: the same `identifier = value` pair with two different values (`MAX_UPLOAD_MB=10` and `MAX_UPLOAD_MB=25`).
 *
 * The heuristics are conservative on purpose: a missed conflict leaves two notes in circulation as today, a false one holds two good notes
 * back until a person looks. Near-identical restatements are not conflicts (`sameSubject` already replaces the older wording at write).
 */
export type ConflictKind = "value" | "polarity" | "literal";
export type ConflictNote = { id: string; content: string; concepts: string[]; createdAt?: number };
export type Conflict = { a: string; b: string; kind: ConflictKind; subject: string; evidenceA: string; evidenceB: string };

const PATH = /(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,6}\b/g;
const NEGATION = /\b(?:not|never|no longer|cannot|can't|doesn't|does not|do not|don't|isn't|is not|aren't|are not|won't|without|disabled|нет|не|без|никогда|больше не)\b/i;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "when", "are", "was", "has", "have", "into", "only", "its", "can", "all", "any", "also", "but", "then", "than", "there", "их", "для", "что", "это", "как", "при", "или", "если", "все", "так", "они"]);
const UNITS = "(?:ms|s|sec|seconds?|min|minutes?|h|hours?|d|days?|kb|mb|gb|kib|mib|px|rem|em|%|tokens?|times|retries|attempts?|items?|rows?|chars?|characters?|bytes?|мс|сек|мин|ч|дн|дней|часов|минут|штук|раз)";

const sentences = (text: string): string[] => text.split(/(?<=[.!?;])\s+|\n+/).map((part) => part.trim()).filter((part) => part.length > 12);
const contentWords = (text: string): string[] => memoryTokens(text).filter((word) => word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word));
/** How many negations a sentence carries; two sentences deny each other only when the parity differs. */
const negations = (text: string): number => (text.match(new RegExp(NEGATION.source, "gi")) ?? []).length;
const withoutNegation = (text: string): string => text.replace(new RegExp(NEGATION.source, "gi"), " ");
const pathsOf = (text: string): Set<string> => new Set((text.match(PATH) ?? []).filter((path) => path.includes("/")));

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Number + unit facts with the two words in front of the number as their label. */
export function quantities(text: string): Array<{ label: string; value: number; unit: string; text: string }> {
  const out: Array<{ label: string; value: number; unit: string; text: string }> = [];
  const pattern = new RegExp(`((?:[\\p{L}_-]{3,}\\s+){1,3}?)(?:(?:is|are|of|to|at|=|:|≤|<=|>=|<|>|up to|within|every|after|for|за|до|в|на)\\s*)?\`?(\\d+(?:[.,]\\d+)?)\`?\\s*(${UNITS})\\b`, "giu");
  for (const hit of text.matchAll(pattern)) {
    const label = contentWords(hit[1]!).slice(-2).join(" ");
    if (!label) continue;
    out.push({ label, value: Number(hit[2]!.replace(",", ".")), unit: hit[3]!.toLowerCase().replace(/s$/, ""), text: hit[0].trim() });
  }
  return out;
}

/** `IDENTIFIER = value` or `identifier: value` where the identifier looks like a constant, an env name or a key. */
export function literals(text: string): Array<{ name: string; value: string; text: string }> {
  const out: Array<{ name: string; value: string; text: string }> = [];
  for (const hit of text.matchAll(/`?\b([A-Z][A-Z0-9_]{3,}|[a-z]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:[_.-][a-z0-9]+){1,})`?\s*(?:=|:|is|equals|to)\s*`([^`\n]{1,40})`/g)) {
    out.push({ name: hit[1]!.toLowerCase(), value: hit[2]!.trim().toLowerCase(), text: hit[0].trim() });
  }
  return out;
}

/** Same subject: a shared file path, or at least three shared tags that are most of both notes' tags. */
export function sameThing(a: ConflictNote, b: ConflictNote): string | null {
  const pa = pathsOf(a.content), pb = pathsOf(b.content);
  for (const path of pa) if (pb.has(path)) return path;
  const ca = new Set(a.concepts), cb = new Set(b.concepts);
  const shared = [...ca].filter((tag) => cb.has(tag) && !["invariant", "review", "pitfall", "security", "regression", "test", "gotcha"].includes(tag));
  if (shared.length >= 3 && shared.length / (ca.size + cb.size - shared.length) >= 0.5) return shared.slice(0, 3).join(", ");
  return null;
}

/** The first way in which the two notes disagree, or null. */
export function disagreement(a: ConflictNote, b: ConflictNote): Omit<Conflict, "a" | "b"> | null {
  const subject = sameThing(a, b);
  if (!subject) return null;
  const qa = quantities(a.content), qb = quantities(b.content);
  for (const x of qa) for (const y of qb) {
    if (x.label === y.label && x.unit === y.unit && x.value !== y.value) return { kind: "value", subject, evidenceA: x.text, evidenceB: y.text };
  }
  const la = literals(a.content), lb = literals(b.content);
  for (const x of la) for (const y of lb) {
    if (x.name === y.name && x.value !== y.value) return { kind: "literal", subject, evidenceA: x.text, evidenceB: y.text };
  }
  const sa = sentences(a.content), sb = sentences(b.content);
  for (const x of sa) {
    const wx = new Set(contentWords(withoutNegation(x)));
    if (wx.size < 5) continue;
    for (const y of sb) {
      const wy = new Set(contentWords(withoutNegation(y)));
      // One sentence says what the other denies: the same words once the negation is taken out, and the negation in one of them only.
      if (wy.size < 5 || negations(x) % 2 === negations(y) % 2) continue;
      if (jaccard(wx, wy) >= 0.8) return { kind: "polarity", subject, evidenceA: x.slice(0, 200), evidenceB: y.slice(0, 200) };
    }
  }
  return null;
}

/** Every disagreeing pair among the notes (oldest note first in a pair); with `only`, just the pairs that include one of those notes (the ones a write added). Quadratic in the notes of one project, which is hundreds. */
export function findConflicts(notes: readonly ConflictNote[], only?: ReadonlySet<string>): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) {
    const first = notes[i]!, second = notes[j]!;
    if (only && !only.has(first.id) && !only.has(second.id)) continue;
    const [a, b] = (first.createdAt ?? 0) <= (second.createdAt ?? 0) ? [first, second] : [second, first];
    const found = disagreement(a, b);
    if (found) out.push({ a: a.id, b: b.id, ...found });
  }
  return out;
}

/** The id the register keeps for a pair, whatever the order it was found in. */
export const conflictId = (a: string, b: string): string => `mc_${[a, b].sort().map((id) => id.slice(0, 10)).join("_")}`;
