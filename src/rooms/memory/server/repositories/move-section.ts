import type { MemoryDatabase } from "@lane-pilot/memory-core";
import { addOrigin, dropMemoryIndexes, duplicateWords, hideRecord, nearDuplicate, storedVectors } from "@lane-pilot/memory-core";

type Db = Pick<MemoryDatabase, "prepare" | "transaction">;
type Row = Record<string, unknown>;

export type MoveSectionOptions = {
  fromProject: string; toProject: string;
  /** Folder ids (or `section:<id>`) of the moved section and, listed with it, its child folders. The first one is the section that `toSection` renames. */
  sections: readonly string[];
  toSection?: string; root?: boolean;
  /** Names of the section, to count the root notes that mention it (a hint). */
  names?: readonly string[];
  /** BB thread ids of the section's chats: their learning rows move too. */
  threadIds?: readonly string[];
};

type Change = { table: string; keys: readonly string[]; row: Row; set: Row };
export type MoveSectionPlan = {
  from: string; to: string; sections: string[];
  /** Rows that move, per table. */
  moves: Record<string, number>;
  /** Notes that moved as a copy of a note the target already had / that extend one. */
  mergedAsDuplicate: number; supersedesTarget: number;
  /** What stays behind, per kind, with the reason. */
  stays: Record<string, number>;
  /** Hint only: notes of the source project's root that mention the section's name. */
  rootNotesMentioning: number | null;
  /** Full previous values of every changed row, for the backup file. */
  changes: Change[];
  after: Array<() => void>;
};

const sectionId = (value: string) => value.startsWith("section:") ? value : `section:${value}`;
const parseList = (json: unknown): string[] => { try { const value = JSON.parse(String(json ?? "[]")) as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; } catch { return []; } };
const has = (db: Db, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table));
const all = (db: Db, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Row[];
const marks = (items: readonly unknown[]) => items.map(() => "?").join(",");
/** SQLite caps the bound variables of one statement; ids go in chunks. */
function inChunks<T>(items: readonly T[], size = 400): T[][] { const out: T[][] = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }
const rowsWhereIn = (db: Db, table: string, column: string, ids: readonly string[], extra = "", ...params: unknown[]): Row[] =>
  inChunks(ids).flatMap((chunk) => all(db, `SELECT * FROM ${table} WHERE ${column} IN (${marks(chunk)})${extra}`, ...chunk, ...params));

/** The new scope of a note: the chain from the first moved section on, renamed or lifted to the root as asked; null for a note that is not in a moved section. */
export function rewriteSectionScope(chain: readonly string[], moved: ReadonlySet<string>, primary: string, options: Pick<MoveSectionOptions, "toSection" | "root">): string[] | null {
  const at = chain.findIndex((entry) => moved.has(entry));
  if (at < 0) return null;
  const rename = (entry: string) => options.toSection && entry === primary ? sectionId(options.toSection) : entry;
  const tail = chain.slice(at).map(rename);
  if (!options.root) return tail;
  const below = chain.slice(at + 1).map(rename);
  return below.length ? below : ["project:root"];
}

/** Reads what would move; changes nothing. `applyMoveSection` writes it. */
export function planMoveSection(db: Db, options: MoveSectionOptions): MoveSectionPlan {
  const { fromProject: from, toProject: to } = options;
  const sections = options.sections.map(sectionId);
  const moved = new Set(sections);
  const primary = sections[0]!;
  const changes: Change[] = [];
  const stays: Record<string, number> = {};
  const after: Array<() => void> = [];
  const push = (table: string, keys: readonly string[], row: Row, set: Row) => changes.push({ table, keys, row, set });
  const stay = (kind: string, n: number) => { if (n > 0) stays[kind] = (stays[kind] ?? 0) + n; };

  // --- memory notes -----------------------------------------------------------------------------------------------------------------------------
  const memory = all(db, "SELECT * FROM lane_pilot_memory WHERE project_id=? ORDER BY created_at, id", from);
  let planned = memory.map((row) => ({ row, scope: rewriteSectionScope(parseList(row.scope_json), moved, primary, options) })).filter((item): item is { row: Row; scope: string[] } => item.scope !== null);
  stay("notes of ancestor sections, the root or other sections (not moved)", memory.length - planned.length);

  // Rules first: a rule that collides with one of the target's stays, and so does its note.
  const ruleTable = has(db, "lane_pilot_rule_proposal");
  const ruleRows = ruleTable ? all(db, "SELECT * FROM lane_pilot_rule_proposal WHERE project_id=?", from) : [];
  const ruleMoves = ruleRows.map((row) => ({ row, scope: rewriteSectionScope(parseList(row.scope_json), moved, primary, options) })).filter((item): item is { row: Row; scope: string[] } => item.scope !== null);
  const targetRuleIds = new Set(ruleTable ? all(db, "SELECT id FROM lane_pilot_rule_proposal WHERE project_id=?", to).map((row) => String(row.id)) : []);
  const ruleBlocked = ruleMoves.filter((item) => targetRuleIds.has(String(item.row.id)));
  const blockedMemory = new Set(ruleBlocked.map((item) => String(item.row.memory_id ?? "")).filter(Boolean));
  const ruleIds = new Set(ruleMoves.filter((item) => !targetRuleIds.has(String(item.row.id))).map((item) => String(item.row.id)));
  stay("rules whose id the target already has (left with their note)", ruleBlocked.length);
  planned = planned.filter((item) => !blockedMemory.has(String(item.row.id)));
  const movedIds = new Set(planned.map((item) => String(item.row.id)));

  // Duplicate guard: the target's active notes of the same audience, bot and new scope, the moved ones joining as they are placed (oldest first).
  const toActive = all(db, "SELECT id, content, audience, personal_bot, scope_json FROM lane_pilot_memory WHERE project_id=? AND kind='note' AND status='active' AND concepts_json NOT LIKE '%\"rule\"%'", to);
  const vectors = new Map<string, Float32Array>([...storedVectors(db, to), ...storedVectors(db, from)]);
  const pool = toActive.map((row) => ({ ...row, words: duplicateWords(String(row.content)) })) as Array<Row & { words: ReadonlySet<string> }>;
  const decided = new Map<string, { status: "active" | "duplicate"; keep?: string; supersedes?: string }>();
  let mergedAsDuplicate = 0, supersedesTarget = 0;
  for (const item of planned) {
    const id = String(item.row.id);
    const note = item.row.kind === "note" && item.row.status === "active" && !String(item.row.concepts_json).includes('"rule"');
    const scopeKey = JSON.stringify(item.scope);
    if (note) {
      const mine = pool.filter((other) => other.audience === item.row.audience && other.personal_bot === item.row.personal_bot && JSON.stringify(parseList(other.scope_json)) === scopeKey);
      const hit = nearDuplicate(String(item.row.content), vectors.get(id) ?? null, mine.map((other) => ({ id: String(other.id), content: String(other.content), words: other.words, vector: vectors.get(String(other.id)) ?? null })));
      if (hit?.relation === "copy") { decided.set(id, { status: "duplicate", keep: hit.id }); mergedAsDuplicate++; }
      else {
        if (hit?.relation === "extends") { decided.set(id, { status: "active", supersedes: hit.id }); supersedesTarget++; }
        pool.push({ id, content: item.row.content, audience: item.row.audience, personal_bot: item.row.personal_bot, scope_json: scopeKey, words: duplicateWords(String(item.row.content)) });
      }
    }
    push("lane_pilot_memory", ["id"], item.row, { project_id: to, scope_json: scopeKey });
  }
  const noteIds = [...movedIds];
  const now = Date.now();
  for (const item of planned) {
    const id = String(item.row.id), verdict = decided.get(id);
    if (verdict?.status === "duplicate") after.push(() => { hideRecord(db, to, id, "expired", verdict.keep ?? null, () => {}, "duplicate"); if (verdict.keep) addOrigin(db, to, verdict.keep, { by: "move-section", sha: id, at: now, duplicate: id }); });
    else if (verdict?.supersedes) after.push(() => { hideRecord(db, to, verdict.supersedes!, "superseded", id, (project, record) => dropMemoryIndexes(db, project, record)); });
  }

  // --- rows that follow a note -------------------------------------------------------------------------------------------------------------------
  for (const table of ["lane_pilot_memory_vec", "lane_pilot_memory_vec_chunk"]) if (has(db, table)) for (const row of rowsWhereIn(db, table, "id", noteIds, " AND project_id=?", from)) push(table, table.endsWith("chunk") ? ["id", "chunk"] : ["id"], row, { project_id: to });
  for (const table of ["lane_pilot_memory_fts", "lane_pilot_memory_trgm"]) if (has(db, table)) for (const row of rowsWhereIn(db, table, "id", noteIds, " AND project_id=?", from)) push(table, ["id"], row, { project_id: to });
  if (has(db, "lane_pilot_memory_promotion")) for (const row of rowsWhereIn(db, "lane_pilot_memory_promotion", "memory_id", noteIds, " AND project_id=?", from)) push("lane_pilot_memory_promotion", ["memory_id", "query", "at"], row, { project_id: to });
  if (has(db, "lane_pilot_memory_conflict")) {
    const conflicts = all(db, "SELECT * FROM lane_pilot_memory_conflict WHERE project_id=?", from).filter((row) => movedIds.has(String(row.note_a)) || movedIds.has(String(row.note_b)));
    for (const row of conflicts) { if (movedIds.has(String(row.note_a)) && movedIds.has(String(row.note_b))) push("lane_pilot_memory_conflict", ["id"], row, { project_id: to }); else stay("conflicts with one side moved (left)", 1); }
  }
  if (has(db, "lane_pilot_memory_receipt")) {
    const every = all(db, "SELECT * FROM lane_pilot_memory_receipt WHERE project_id=?", from).filter((row) => parseList(row.returned_ids).some((id) => movedIds.has(id)));
    const whole = every.filter((row) => parseList(row.returned_ids).every((id) => movedIds.has(id)));
    for (const row of whole) push("lane_pilot_memory_receipt", ["id"], row, { project_id: to });
    stay("receipts that also name notes that stay (left)", every.length - whole.length);
  }
  if (has(db, "lane_pilot_memory_miss")) {
    const misses = all(db, "SELECT * FROM lane_pilot_memory_miss WHERE project_id=?", from);
    const mine = misses.filter((row) => row.note_id && movedIds.has(String(row.note_id)));
    for (const row of mine) push("lane_pilot_memory_miss", ["id"], row, { project_id: to });
    stay("memory misses that name no note (cannot be attributed to a section; left)", misses.length - mine.length);
  }

  // --- rules ------------------------------------------------------------------------------------------------------------------------------------
  for (const item of ruleMoves) if (ruleIds.has(String(item.row.id))) push("lane_pilot_rule_proposal", ["project_id", "id"], item.row, { project_id: to, scope_json: JSON.stringify(item.scope) });
  if (ruleIds.size) {
    if (has(db, "lane_pilot_rule_event")) for (const row of rowsWhereIn(db, "lane_pilot_rule_event", "rule_id", [...ruleIds], " AND project_id=?", from)) push("lane_pilot_rule_event", ["id"], row, { project_id: to });
    if (has(db, "lane_pilot_rule_promotion")) for (const row of rowsWhereIn(db, "lane_pilot_rule_promotion", "rule_id", [...ruleIds], " AND project_id=?", from)) push("lane_pilot_rule_promotion", ["rule_id"], row, { project_id: to });
  }

  // --- learning ---------------------------------------------------------------------------------------------------------------------------------
  if (has(db, "lane_pilot_learning_item")) {
    const threads = new Set(options.threadIds ?? []);
    const items = all(db, "SELECT * FROM lane_pilot_learning_item WHERE project_id=?", from).filter((row) => {
      const target = String(row.target ?? "");
      const ref = target.startsWith("memory:") ? target.slice(7) : target.startsWith("rule:") ? target.slice(5) : "";
      return (ref && (movedIds.has(ref) || ruleIds.has(ref))) || threads.has(String(row.thread_id));
    });
    for (const row of items) push("lane_pilot_learning_item", ["id"], row, { project_id: to });
    if (has(db, "lane_pilot_learning_obs")) {
      const obsIds = new Set(items.map((row) => String(row.obs_id)));
      for (const row of all(db, "SELECT * FROM lane_pilot_learning_obs WHERE project_id=?", from)) if (obsIds.has(String(row.id)) || threads.has(String(row.thread_id))) push("lane_pilot_learning_obs", ["id"], row, { project_id: to });
    }
  }

  // --- settings of the section and the wave summaries' facts ------------------------------------------------------------------------------------
  if (has(db, "lane_pilot_project_settings")) {
    const rename = (binding: string) => options.toSection && binding === primary ? sectionId(options.toSection) : binding;
    const rows = rowsWhereIn(db, "lane_pilot_project_settings", "binding_id", sections, " AND project_id=?", from);
    const taken = new Set(all(db, "SELECT binding_id, key FROM lane_pilot_project_settings WHERE project_id=?", to).map((row) => `${row.binding_id}\0${row.key}`));
    for (const row of rows) {
      if (options.root) { stay("section settings (would become project-wide at the target root; left)", 1); continue; }
      const binding = rename(String(row.binding_id));
      if (taken.has(`${binding}\0${row.key}`)) { stay("section settings the target already has (left)", 1); continue; }
      push("lane_pilot_project_settings", ["project_id", "binding_id", "key"], row, { project_id: to, binding_id: binding });
      if (has(db, "lane_pilot_setting_generation")) for (const generation of all(db, "SELECT * FROM lane_pilot_setting_generation WHERE project_id=? AND binding_id=? AND key=?", from, row.binding_id, row.key)) push("lane_pilot_setting_generation", ["project_id", "binding_id", "key"], generation, { project_id: to, binding_id: binding });
    }
  }
  if (has(db, "lane_pilot_run")) {
    const runs = all(db, "SELECT id, settings_scopes_json FROM lane_pilot_run WHERE project_id=?", from).filter((row) => parseList(row.settings_scopes_json).some((entry) => moved.has(entry)));
    stay("runs of the section and their task history (bound to BB threads and workspaces; left)", runs.length);
    if (runs.length && has(db, "lane_pilot_accepted_fact")) for (const row of rowsWhereIn(db, "lane_pilot_accepted_fact", "run_id", runs.map((run) => String(run.id)), " AND project_id=?", from)) push("lane_pilot_accepted_fact", ["run_id", "task_id"], row, { project_id: to });
  }

  let rootNotesMentioning: number | null = null;
  const names = (options.names ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (names.length) rootNotesMentioning = memory.filter((row) => row.status === "active" && parseList(row.scope_json).length === 0 && names.some((name) => String(row.content).toLowerCase().includes(name))).length;

  const moves: Record<string, number> = {};
  for (const change of changes) moves[change.table] = (moves[change.table] ?? 0) + 1;
  return { from, to, sections, moves, mergedAsDuplicate, supersedesTarget, stays, rootNotesMentioning, changes, after };
}

const jsonSafe = (value: unknown): unknown => Buffer.isBuffer(value) ? { $base64: value.toString("base64") } : value;

/** The backup file's content: every affected row as it was, with the change it gets. */
export function moveSectionBackup(plan: MoveSectionPlan, at: number): string {
  return JSON.stringify({ kind: "lane-pilot-move-section-backup", version: 1, at, from: plan.from, to: plan.to, sections: plan.sections, moves: plan.moves,
    rows: plan.changes.map((change) => ({ table: change.table, keys: change.keys, before: Object.fromEntries(Object.entries(change.row).map(([key, value]) => [key, jsonSafe(value)])), set: change.set })) }, null, 2);
}

/**
 * Writes the backup (through `writeBackup`, which returns the file's path), then moves everything in one transaction. A second run finds nothing in the
 * source project and changes nothing.
 */
export function applyMoveSection(db: Db, plan: MoveSectionPlan, writeBackup: (json: string) => string, now = Date.now()): { backup: string | null; changed: number } {
  if (!plan.changes.length) return { backup: null, changed: 0 };
  const backup = writeBackup(moveSectionBackup(plan, now));
  db.transaction(() => {
    for (const change of plan.changes) {
      const columns = Object.keys(change.set);
      const guarded = !change.keys.includes("project_id") && "project_id" in change.row;
      const where = [...change.keys.map((key) => `${key}=?`), ...(guarded ? ["project_id=?"] : [])];
      const done = db.prepare(`UPDATE ${change.table} SET ${columns.map((column) => `${column}=?`).join(",")} WHERE ${where.join(" AND ")}`)
        .run(...columns.map((column) => change.set[column]), ...change.keys.map((key) => change.row[key]), ...(guarded ? [plan.from] : []));
      if (done.changes === 0 && change.table === "lane_pilot_memory") throw new Error(`move-section: note ${String(change.row.id)} changed while moving; nothing was moved`);
    }
    for (const step of plan.after) step();
  })();
  return { backup, changed: plan.changes.length };
}
