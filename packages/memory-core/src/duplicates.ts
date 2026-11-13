import { EMBED_MODEL, vectorsReady } from "./vectors";
import { memoryStem, memoryTokens } from "./terms";
import { hideRecord } from "./lifecycle";
import type { MemoryDatabase } from "./store";
import type { MemoryCandidate, MemoryRecord } from "./settings";

/**
 * Near-duplicate notes. A copy of a fact (the same note imported from another store, restated with a source mark in front) used to become a
 * second row and a second search hit. Two tests, either one makes a pair:
 *   - cosine of the stored vectors >= `DUP_COSINE` (only where both notes have a vector of the current model);
 *   - containment of the normalised text >= `DUP_CONTAINMENT`: the share of the shorter note's words that the other one holds, after a leading
 *     `[source mark]`, case and punctuation are dropped and words are cut to stems.
 * A text test needs at least `MIN_WORDS` words in the shorter note and a longer note of at most `MAX_RATIO` times its size: a short sentence is
 * found inside a hundred long notes and an excerpt of a runbook is not a copy of the runbook.
 */
export const DUP_COSINE = 0.92;
export const DUP_CONTAINMENT = 0.9;
const MIN_WORDS = 5;
const MAX_RATIO = 3;

/** Leading `[...]` marks: «[из авто-памяти Claude Code ...]», «[imported]». They name where a note came from, not what it says. */
const SOURCE_MARKS = /^\s*(?:\[[^\]\n]{0,240}\]\s*)+/u;

/** The word set a text is compared by. */
export function duplicateWords(text: string): Set<string> {
  return new Set(memoryTokens(text.replace(SOURCE_MARKS, "")).map(memoryStem).filter(Boolean));
}

const NUMBERS = /\d+(?:[.,]\d+)?/gu;
const NEGATIONS = /(?<![\p{L}\p{N}])(?:not|no|never|without|cannot|don't|doesn't|isn't|не|нет|никогда|без|нельзя)(?![\p{L}\p{N}])/giu;
const setOf = (text: string, pattern: RegExp): Set<string> => new Set((text.toLowerCase().match(pattern) ?? []).map((item) => item.replace(",", ".")));
const within = (a: Set<string>, b: Set<string>) => [...a].every((item) => b.has(item));

/**
 * A changed number or a flipped «not» is an update, not a copy: «kept 14 days» and «kept 30 days» share nine words of ten. Two texts agree when one
 * holds all the numbers of the other and both carry the same negations. Applies to the cosine test too (a model sees the two as near-identical).
 */
export function factsAgree(a: string, b: string): boolean {
  const na = setOf(a, NUMBERS), nb = setOf(b, NUMBERS);
  const ga = setOf(a, NEGATIONS), gb = setOf(b, NEGATIONS);
  return (within(na, nb) || within(nb, na)) && ga.size === gb.size && within(ga, gb);
}

export type TextRelation = "copy" | "extends" | null;

/**
 * How a new text stands to an old one: `copy` (one holds the other, nothing worth a version), `extends` (the new one holds the old one and adds
 * more: a strict superset, kept as a new version), or null. `containment` is the shared share of the shorter text.
 */
export function textRelation(newer: ReadonlySet<string>, older: ReadonlySet<string>): { relation: TextRelation; containment: number } {
  if (!newer.size || !older.size) return { relation: null, containment: 0 };
  let shared = 0;
  for (const word of older) if (newer.has(word)) shared++;
  const small = Math.min(newer.size, older.size), large = Math.max(newer.size, older.size);
  const containment = shared / small;
  if (small < MIN_WORDS || large / small > MAX_RATIO || containment < DUP_CONTAINMENT) return { relation: null, containment };
  const oldInNew = shared / older.size, newInOld = shared / newer.size;
  return { relation: oldInNew >= DUP_CONTAINMENT && newInOld < DUP_CONTAINMENT ? "extends" : "copy", containment };
}

export const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export type DuplicateNote = { id: string; content: string; words?: ReadonlySet<string>; vector?: Float32Array | null };
export type DuplicateHit = { id: string; relation: "copy" | "extends"; containment: number; cosine: number | null };

/** The stored note a new text duplicates (a text `extends` wins over a `copy`), or null. */
export function nearDuplicate(content: string, vector: Float32Array | null | undefined, notes: readonly DuplicateNote[]): DuplicateHit | null {
  const words = duplicateWords(content);
  let copy: DuplicateHit | null = null;
  for (const note of notes) {
    if (!factsAgree(content, note.content)) continue;
    const test = textRelation(words, note.words ?? duplicateWords(note.content));
    const similar = vector && note.vector ? cosine(vector, note.vector) : null;
    if (test.relation === "extends") return { id: note.id, relation: "extends", containment: test.containment, cosine: similar };
    if (!copy && (test.relation === "copy" || (similar !== null && similar >= DUP_COSINE))) copy = { id: note.id, relation: "copy", containment: test.containment, cosine: similar };
  }
  return copy;
}

/** The stored vectors of a project for the current model, by record id. Empty where there are none. */
export function storedVectors(db: MemoryDatabase, projectId: string): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!vectorsReady(db)) return out;
  const stored = db.prepare("SELECT id, vec FROM lane_pilot_memory_vec WHERE project_id=? AND model=?").all(projectId, EMBED_MODEL) as Array<{ id: string; vec: Buffer }>;
  for (const row of stored) out.set(row.id, new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength)));
  return out;
}

export type DuplicatePair = {
  /** The note kept: the older one, or the newer one when it holds the older one and adds to it. */
  keep: string; copy: string;
  relation: "copy" | "extends";
  cosine: number | null; containment: number;
  keepText: string; copyText: string;
};

type NoteRow = { id: string; content: string; created_at: number; audience: string; personal_bot: string; scope_json: string | null };

/**
 * Every near-duplicate pair among the project's active notes, inside one namespace (audience, bot, section): a fact in two sections is two facts.
 * Read-only. Oldest note first, so the older note is the one kept unless the newer one holds it and adds to it.
 */
export function duplicatePairs(db: MemoryDatabase, projectId: string): DuplicatePair[] {
  const rows = db.prepare(`SELECT id, content, created_at, audience, personal_bot, scope_json FROM lane_pilot_memory
    WHERE project_id=? AND kind='note' AND status='active' AND concepts_json NOT LIKE '%"rule"%' ORDER BY created_at, id`).all(projectId) as NoteRow[];
  const vectors = storedVectors(db, projectId);
  const notes = rows.map((row) => ({ ...row, words: duplicateWords(row.content), vector: vectors.get(row.id) ?? null }));
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const older = notes[i]!, newer = notes[j]!;
      if (older.audience !== newer.audience || older.personal_bot !== newer.personal_bot || (older.scope_json ?? "[]") !== (newer.scope_json ?? "[]")) continue;
      if (!factsAgree(newer.content, older.content)) continue;
      const test = textRelation(newer.words, older.words);
      const similar = older.vector && newer.vector ? cosine(older.vector, newer.vector) : null;
      if (!test.relation && !(similar !== null && similar >= DUP_COSINE)) continue;
      pairs.push(test.relation === "extends"
        ? { keep: newer.id, copy: older.id, relation: "extends", cosine: similar, containment: test.containment, keepText: newer.content, copyText: older.content }
        : { keep: older.id, copy: newer.id, relation: "copy", cosine: similar, containment: test.containment, keepText: older.content, copyText: newer.content });
    }
  }
  return pairs;
}

/** One more origin on a note that was stated again: a verification entry that names the source and what it duplicated. */
export function addOrigin(db: MemoryDatabase, projectId: string, id: string, entry: { by: string; sha: string; at: number; duplicate?: string }): void {
  db.prepare("UPDATE lane_pilot_memory SET verification_json=json_insert(COALESCE(verification_json,'[]'),'$[#]',json(?)) WHERE project_id=? AND id=?")
    .run(JSON.stringify(entry), projectId, id);
}

export type DedupeResult = { pairs: DuplicatePair[]; merged: Array<{ keep: string; copy: string; relation: "copy" | "extends" }>; applied: boolean };

/**
 * Merges the project's existing duplicate pairs the way the write door does. A copy leaves the shelf with `expired_reason='duplicate'` (it keeps its
 * indexes and vector, so the archive search still finds it; `superseded_by` names the note kept) and the kept note records the copy as one more origin;
 * a note the newer one extends is superseded by it. Nothing is deleted. Dry run unless `apply`.
 */
export function dedupeProject(db: MemoryDatabase, projectId: string, options: { apply?: boolean; now?: number; unindex: (projectId: string, id: string) => void }): DedupeResult {
  const pairs = duplicatePairs(db, projectId);
  const merged: DedupeResult["merged"] = [];
  const apply = options.apply === true;
  const now = options.now ?? Date.now();
  const gone = new Set<string>();
  const run = () => {
    for (const pair of pairs) {
      if (gone.has(pair.copy) || gone.has(pair.keep)) continue;
      if (apply) {
        const hidden = pair.relation === "copy"
          ? hideRecord(db, projectId, pair.copy, "expired", pair.keep, () => {}, "duplicate")
          : hideRecord(db, projectId, pair.copy, "superseded", pair.keep, options.unindex);
        if (!hidden) continue;
        if (pair.relation === "copy") addOrigin(db, projectId, pair.keep, { by: "dedupe", sha: pair.copy, at: now, duplicate: pair.copy });
      }
      gone.add(pair.copy);
      merged.push({ keep: pair.keep, copy: pair.copy, relation: pair.relation });
    }
  };
  if (apply) db.transaction(run)(); else run();
  return { pairs, merged, applied: apply };
}

type DoorRow = { id: string; kind: string; content: string; concepts_json: string; audience: string; scope_json: string | null; status: string; expired_reason: string | null;
  trust: string; source_sha256: string; source_file_id: string | null; verification_json: string | null };
export type DoorInput = {
  projectId: string; sourceSha256: string; origin: string; trust: string; now: number; rows: readonly DoorRow[];
  /** false: the old behaviour, every new text becomes a row. */
  nearDuplicates?: boolean;
  vectorOf?: (content: string) => Float32Array | null | undefined;
  /** Same audience and section as the write: a fact in another section is another fact. */
  namespace: (row: DoorRow) => boolean;
  /** Ids of observed notes that a copy from another source confirms (the store's corroboration list). */
  corroborate: string[];
};

/**
 * The write door's near-duplicate check, for the store (`storeMemoryRecords`). `absorbs(entry, id)` is true when a new note is a copy of a stored one (or of
 * an earlier note of the same batch) and must not become a row: the copy's source is recorded on the stored note as one more origin (`duplicateIds`), or,
 * for an observed note and another source, counts as its second source. A new note that strictly extends a confirmed stored one is kept and `extendsOf`
 * names the note it replaces. Not compared: rules, core, notes with an explicit `supersedes` (an owner-chosen replacement such as memory-compress), and
 * the earlier wording of the same file record (that is the file's own replacement).
 */
export function duplicateDoor(db: MemoryDatabase, input: DoorInput) {
  const duplicateIds: string[] = [];
  const extendsOf = new Map<string, string>();
  const rows = new Map(input.rows.map((row) => [row.id, row]));
  const enabled = input.nearDuplicates !== false;
  const candidates = enabled ? input.rows.filter((row) => row.kind === "note" && !row.concepts_json.includes('"rule"') && input.namespace(row)
    && (row.status === "active" || (row.status === "expired" && row.expired_reason === "budget"))) : [];
  const vectors = input.vectorOf && candidates.length ? storedVectors(db, input.projectId) : new Map<string, Float32Array>();
  const pool: DuplicateNote[] = candidates.map((row) => ({ id: row.id, content: row.content, vector: vectors.get(row.id) ?? null }));
  const absorbs = (entry: MemoryCandidate, id: string): boolean => {
    if (!enabled || entry.kind !== "note" || entry.concepts.includes("rule") || entry.supersedes?.length) return false;
    const mine = entry.sourceFileId ? pool.filter((note) => rows.get(note.id)?.source_file_id !== entry.sourceFileId) : pool;
    const vector = input.vectorOf?.(entry.content);
    const dup = nearDuplicate(entry.content, vector, mine);
    if (dup?.relation === "extends" && input.trust === "confirmed" && rows.get(dup.id)?.status === "active") { extendsOf.set(id, dup.id); pool.push({ id, content: entry.content, vector }); return false; }
    if (!dup) { pool.push({ id, content: entry.content, vector }); return false; }
    const stored = rows.get(dup.id);
    if (!stored) { duplicateIds.push(dup.id); return true; }
    if (stored.status === "active" && stored.trust === "observed" && stored.source_sha256 !== input.sourceSha256) input.corroborate.push(stored.id);
    else if (!stored.verification_json?.includes(input.sourceSha256)) addOrigin(db, input.projectId, stored.id, { by: input.origin, sha: input.sourceSha256, at: input.now, duplicate: id });
    duplicateIds.push(stored.id);
    return true;
  };
  return { absorbs, duplicateIds, extendsOf, rows };
}

/** An archived copy (`expired_reason='duplicate'`) is shown only when the note it duplicates is not in the result: a search returns the fact once. */
export function withoutShadowedDuplicates<T extends MemoryRecord>(db: MemoryDatabase, projectId: string, records: T[]): T[] {
  const archived = records.filter((record) => record.status === "expired" && record.supersededBy);
  if (!archived.length) return records;
  const marks = archived.map(() => "?").join(",");
  const copies = new Set((db.prepare(`SELECT id FROM lane_pilot_memory WHERE project_id=? AND expired_reason='duplicate' AND id IN (${marks})`).all(projectId, ...archived.map((record) => record.id)) as Array<{ id: string }>).map((row) => row.id));
  if (!copies.size) return records;
  const present = new Set(records.map((record) => record.id));
  return records.filter((record) => !(copies.has(record.id) && present.has(record.supersededBy!)));
}
