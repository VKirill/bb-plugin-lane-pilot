/**
 * SMA k_lib_compress: a heavy note is shortened, not dropped. `proposeShorter` is the deterministic
 * text-only proposal (whitespace collapses, decorative markup and repeated sentences go); `applyShorter`
 * stores it through the same write door with the record's layers (kind, concepts, scope, audience,
 * personal bot, trust) untouched and `supersedes` naming the old id, so a note still in use is held as a
 * conflict for a person instead of being replaced silently.
 */
import { createHash } from "node:crypto";
import { estimateTokens } from "./candidates";
import { storeMemoryRecords, type MemoryDatabase, type StoreMemoryResult } from "./store";
import type { MemoryAudience, MemoryTrust } from "./settings";

/** A note above this size is heavy: a candidate for a shorter wording. */
export const HEAVY_NOTE_TOKENS = 256;

/** The stored row a compression applies to; the layers the write keeps. */
export type CompressibleRow = {
  id: string; project_id: string; personal_bot: string; kind: string; audience: string;
  content: string; concepts_json: string; scope_json: string | null; trust: string;
};

const DECORATIVE = [
  /\*\*([^*]+)\*\*/g,
  /__([^_]+)__/g,
  /`{1,3}([^`]*)`{1,3}/g,
];

/** Deterministic shortening of one text: markup off, whitespace collapsed, repeated sentences dropped. */
export function shortenText(content: string): string {
  let text = content;
  for (const pattern of DECORATIVE) text = text.replace(pattern, "$1");
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of text.split(/(?<=[.!?…])\s+|\n+/)) {
    const sentence = part.trim();
    if (!sentence) continue;
    const key = sentence.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(sentence);
  }
  return kept.join(" ");
}

/** The shorter wording for a note, or null when nothing it drops brings it under `maxTokens`. */
export function proposeShorter(row: { kind?: string; content: string }, maxTokens: number): string | null {
  if (row.kind && row.kind !== "note") return null;
  const text = shortenText(row.content);
  return text !== row.content && estimateTokens(text) <= maxTokens ? text : null;
}

/** Active notes of a project over the token threshold, heaviest first. */
export function heavyNoteRows(db: MemoryDatabase, projectId: string, minTokens = HEAVY_NOTE_TOKENS): CompressibleRow[] {
  return (db.prepare(`SELECT id, project_id, personal_bot, kind, audience, content, concepts_json, scope_json, trust
      FROM lane_pilot_memory WHERE project_id=? AND status='active' AND kind='note'`).all(projectId) as CompressibleRow[])
    .filter((row) => estimateTokens(row.content) > minTokens)
    .sort((a, b) => estimateTokens(b.content) - estimateTokens(a.content) || a.id.localeCompare(b.id));
}

/** One stored note row by id (or prefix), for `--apply`. */
export function compressibleRow(db: MemoryDatabase, projectId: string, id: string): CompressibleRow | null {
  return (db.prepare(`SELECT id, project_id, personal_bot, kind, audience, content, concepts_json, scope_json, trust
      FROM lane_pilot_memory WHERE project_id=? AND (id=? OR id LIKE ?)`).get(projectId, id, `${id}%`) as CompressibleRow | undefined) ?? null;
}

/**
 * Stores the shorter wording in place of a note: same layers, `supersedes: [old id]`. The budgets are
 * unbounded — the new text is shorter, so the corpus only shrinks. Refuses when the proposal is not
 * actually shorter.
 */
export function applyShorter(db: MemoryDatabase, row: CompressibleRow, text: string, now?: number): StoreMemoryResult {
  if (row.kind !== "note") throw new Error("only a note can be shortened");
  const trimmed = text.trim();
  if (!trimmed || trimmed === row.content) throw new Error("the shorter text is empty or unchanged");
  if (estimateTokens(trimmed) >= estimateTokens(row.content)) throw new Error("the proposal is not shorter");
  let scope: string[] = [];
  try { scope = row.scope_json ? JSON.parse(row.scope_json) as string[] : []; } catch { /* unscoped */ }
  let concepts: string[] = [];
  try { concepts = JSON.parse(row.concepts_json) as string[]; } catch { /* tagless */ }
  return storeMemoryRecords(db, {
    projectId: row.project_id, personalBot: row.personal_bot,
    audience: row.audience as MemoryAudience, trust: row.trust as MemoryTrust,
    origin: "maintainer", sourceSha256: createHash("sha256").update(`compress:${row.id}:${trimmed}`).digest("hex"),
    scope, entries: [{ kind: "note", content: trimmed, concepts, supersedes: [row.id] }],
    coreBudget: Number.MAX_SAFE_INTEGER, noteBudget: Number.MAX_SAFE_INTEGER, indexBudget: Number.MAX_SAFE_INTEGER,
    ...(now !== undefined ? { now } : {}),
  });
}
