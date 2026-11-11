/**
 * SMA k_lib_compress: a heavy note is shortened, not dropped. `proposeShorter` is the deterministic
 * text-only proposal (whitespace collapses, decorative markup and repeated sentences go); `applyShorter`
 * stores it through the same write door with the record's layers (kind, concepts, scope, audience,
 * personal bot, trust) untouched and `supersedes` naming the old id, so a note still in use is held as a
 * conflict for a person instead of being replaced silently.
 */
import { createHash } from "node:crypto";
import { estimateTokens } from "./candidates";
import { hideRecord } from "./lifecycle";
import { addToIndexes, dropMemoryIndexes, storeMemoryRecords, type MemoryDatabase, type StoreMemoryResult } from "./store";
import type { MemoryAudience, MemoryTrust } from "./settings";

/** A note above this size is heavy: a candidate for a shorter wording. */
export const HEAVY_NOTE_TOKENS = 256;

/** The stored row a compression applies to; the layers the write keeps. */
export type CompressibleRow = {
  id: string; project_id: string; personal_bot: string; kind: string; audience: string;
  content: string; concepts_json: string; scope_json: string | null; trust: string;
  /** What the shorter record keeps from this one: where it came from and when it holds. */
  origin: string; source_file_id: string | null; valid_from: number | null; valid_until: number | null; origin_task_id: string | null;
};
const ROW_COLUMNS = "id, project_id, personal_bot, kind, audience, content, concepts_json, scope_json, trust, origin, source_file_id, valid_from, valid_until, origin_task_id";

const FENCE = /^\s*(?:```|~~~)/;
// Lists, headings, quotes and tables: a line like these is never edited sentence-wise.
const STRUCTURAL = /^\s*(?:[-*+]\s|\d+[.)]\s|#|>|\|)/;
/** A sentence shorter than this may legitimately repeat («Yes.»); only longer ones are dropped as repeats. */
const MIN_REPEAT_CHARS = 20;

/** Runs of spaces inside a line become one, outside backtick spans; indentation and trailing spaces are handled by the caller. */
function tightenLine(line: string): string {
  const lead = /^\s*/.exec(line)![0];
  const rest = line.slice(lead.length);
  // An odd number of backticks means a span the line does not close: leave the line alone.
  if ((rest.match(/`/g)?.length ?? 0) % 2 === 1) return line.trimEnd();
  return lead + rest.split(/(`+[^`]*`+)/).map((part, i) => i % 2 ? part : part.replace(/ {2,}/g, " ")).join("").trimEnd();
}

/**
 * Deterministic shortening of one text that cannot change its meaning: runs of spaces inside a line collapse (outside
 * backtick spans), trailing spaces go, and a sentence that repeats an earlier one exactly is dropped. Newlines, lists,
 * tables, fenced code, markup and identifiers (`__init__.py`, `**kwargs`, `a ** b`) stay as they are.
 */
export function shortenText(content: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  let fenced = false;
  let dropped = false;
  let skipBlank = false;
  for (const raw of content.split("\n")) {
    if (FENCE.test(raw)) { fenced = !fenced; out.push(raw); skipBlank = false; continue; }
    if (fenced) { out.push(raw); continue; }
    if (skipBlank && !raw.trim()) { skipBlank = false; continue; }
    skipBlank = false;
    let line = tightenLine(raw);
    if (line.trim() && !STRUCTURAL.test(line) && !line.includes("`")) {
      const parts = line.split(/(?<=[.!?…])(\s+)/);
      const kept: string[] = [];
      for (let i = 0; i < parts.length; i += 2) {
        const sentence = parts[i]!.trim();
        if (sentence.length >= MIN_REPEAT_CHARS && seen.has(sentence)) { dropped = true; continue; }
        if (sentence.length >= MIN_REPEAT_CHARS) seen.add(sentence);
        kept.push(kept.length ? `${parts[i - 1] ?? " "}${parts[i]}` : parts[i]!);
      }
      line = kept.join("");
      if (!line.trim()) { skipBlank = true; continue; }
    }
    out.push(line);
  }
  const text = out.join("\n");
  return dropped ? text.replace(/\s+$/, "") : text;
}

/** The shorter wording for a note, or null when nothing it drops brings it under `maxTokens`. */
export function proposeShorter(row: { kind?: string; content: string }, maxTokens: number): string | null {
  if (row.kind && row.kind !== "note") return null;
  const text = shortenText(row.content);
  return text !== row.content && estimateTokens(text) < estimateTokens(row.content) && estimateTokens(text) <= maxTokens ? text : null;
}

/** Active notes of a project over the token threshold, heaviest first. */
export function heavyNoteRows(db: MemoryDatabase, projectId: string, minTokens = HEAVY_NOTE_TOKENS): CompressibleRow[] {
  return (db.prepare(`SELECT ${ROW_COLUMNS} FROM lane_pilot_memory WHERE project_id=? AND status='active' AND kind='note'`).all(projectId) as CompressibleRow[])
    .filter((row) => estimateTokens(row.content) > minTokens)
    .sort((a, b) => estimateTokens(b.content) - estimateTokens(a.content) || a.id.localeCompare(b.id));
}

/**
 * The one ACTIVE note an id names: the exact id, else a prefix (LIKE wildcards in it are literal). A prefix that
 * matches more than one note is refused, never guessed.
 */
export function resolveCompressible(db: MemoryDatabase, projectId: string, id: string): { row: CompressibleRow } | { error: string } {
  if (!id) return { error: "no record id" };
  const where = "project_id=? AND status='active' AND kind='note'";
  const exact = db.prepare(`SELECT ${ROW_COLUMNS} FROM lane_pilot_memory WHERE ${where} AND id=?`).get(projectId, id) as CompressibleRow | undefined;
  if (exact) return { row: exact };
  const rows = db.prepare(`SELECT ${ROW_COLUMNS} FROM lane_pilot_memory WHERE ${where} AND id LIKE ? ESCAPE '\\' LIMIT 2`).all(projectId, `${id.replace(/[\\%_]/g, "\\$&")}%`) as CompressibleRow[];
  if (rows.length > 1) return { error: `${id} matches more than one active note; give a longer prefix` };
  return rows[0] ? { row: rows[0] } : { error: `no active note ${id} in project ${projectId}` };
}

/** One active note by id (or unique prefix), or null. */
export function compressibleRow(db: MemoryDatabase, projectId: string, id: string): CompressibleRow | null {
  const found = resolveCompressible(db, projectId, id);
  return "row" in found ? found.row : null;
}

/**
 * Stores the shorter wording in place of a note: same layers, `supersedes: [old id]`. The new record keeps the old
 * one's origin, task id, source file link and dates (a dated note stays dated), and carries a `compress` mark in its
 * verification trail so a re-import of the file does not bring the old long wording back. The budgets are
 * unbounded — the new text is shorter, so the corpus only shrinks. Refuses when the proposal is not actually shorter.
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
  const sourceSha256 = createHash("sha256").update(`compress:${row.id}:${trimmed}`).digest("hex");
  const at = now ?? Date.now();
  const done = storeMemoryRecords(db, {
    projectId: row.project_id, personalBot: row.personal_bot,
    audience: row.audience as MemoryAudience, trust: row.trust as MemoryTrust,
    origin: row.origin || "maintainer", sourceSha256,
    scope, entries: [{ kind: "note", content: trimmed, concepts, supersedes: [row.id] }],
    ...(row.origin_task_id ? { originTaskId: row.origin_task_id } : {}),
    coreBudget: Number.MAX_SAFE_INTEGER, noteBudget: Number.MAX_SAFE_INTEGER, indexBudget: Number.MAX_SAFE_INTEGER,
    now: at,
  });
  const newId = done.insertedIds[0];
  if (newId) {
    // Set here, not through the entry: a source file id on the entry would make the store replace every sibling record of that file.
    db.prepare(`UPDATE lane_pilot_memory SET source_file_id=?, valid_from=COALESCE(?,valid_from), valid_until=?,
        verification_json=json_insert(COALESCE(verification_json,'[]'),'$[#]',json_object('by','compress','sha',?,'at',?)) WHERE project_id=? AND id=?`)
      .run(row.source_file_id, row.valid_from, row.valid_until, sourceSha256, at, row.project_id, newId);
    // A note only observed (not confirmed) is never replaced by the store itself; the compression names its own predecessor.
    if (!done.supersededIds.includes(row.id) && !done.heldIds.includes(row.id)) {
      hideRecord(db, row.project_id, row.id, "superseded", newId, (project, id) => dropMemoryIndexes(db, project, id));
    }
  }
  return done;
}

/** Reverses an apply: the old long note is active again and the short one is superseded by it. Returns the old id. */
export function undoShorter(db: MemoryDatabase, projectId: string, newId: string): string {
  const found = resolveCompressible(db, projectId, newId);
  if ("error" in found) throw new Error(found.error);
  const fresh = found.row;
  const marked = db.prepare(`SELECT 1 AS ok FROM lane_pilot_memory WHERE project_id=? AND id=? AND verification_json LIKE '%"by":"compress"%'`).get(projectId, fresh.id);
  if (!marked) throw new Error(`${fresh.id} is not a compressed note`);
  const old = db.prepare("SELECT id, content, concepts_json FROM lane_pilot_memory WHERE project_id=? AND superseded_by=? AND status='superseded' AND kind='note' ORDER BY created_at DESC LIMIT 1")
    .get(projectId, fresh.id) as { id: string; content: string; concepts_json: string } | undefined;
  if (!old) throw new Error(`no note was superseded by ${fresh.id}`);
  db.transaction(() => {
    hideRecord(db, projectId, fresh.id, "superseded", old.id, (project, id) => dropMemoryIndexes(db, project, id));
    db.prepare("UPDATE lane_pilot_memory SET status='active', superseded_by=NULL, expired_reason=NULL WHERE project_id=? AND id=?").run(projectId, old.id);
    addToIndexes(db, projectId, old.id, old.content, JSON.parse(old.concepts_json) as string[]);
  }).immediate();
  return old.id;
}
