import { fileFingerprint, pathsNamed } from "./fingerprint";
import { memoryContentIssue, memoryRecordId } from "./candidates";
import type Database from "better-sqlite3";
import { OBSERVED_QUARANTINE_MS, expireMemory, hideRecord, idleSql, sameSubject } from "./lifecycle";
import { memoryStem, memoryTokens } from "./terms";
import { heldClause } from "./conflict-store";
import type { MemoryAudience, MemoryCandidate, MemoryKind, MemoryRecord, MemorySearchEngine, MemoryStatus, MemoryTrust } from "./settings";

/** The better-sqlite3 surface this package needs; BB's `bb.storage.database()` satisfies it. */
export type MemoryDatabase = Pick<Database.Database, "prepare" | "transaction">;

/** Columns the package expects; the owning plugin ships the migration. */
export const MEMORY_SCHEMA = {
  table: "lane_pilot_memory",
  fts: "lane_pilot_memory_fts",
  columns: ["id", "project_id", "personal_bot", "kind", "audience", "content", "concepts_json", "source_sha256", "created_at",
    "status", "superseded_by", "valid_until", "last_used_at", "use_count", "accepted_count", "trust", "origin", "source_file_id", "scope_json", "file_fingerprint"],
} as const;

const COLUMNS = ["id", "project_id", "personal_bot", "kind", "audience", "content", "concepts_json", "source_sha256", "created_at",
  "status", "trust", "valid_until", "superseded_by", "source_file_id", "use_count", "accepted_count", "last_used_at", "file_fingerprint"];
const cols = (alias = "") => COLUMNS.map((name) => `${alias}${name}`).join(",");

type Row = { id: string; project_id: string; personal_bot: string; kind: MemoryKind; audience: string; content: string; concepts_json: string; source_sha256: string; created_at: number;
  status: MemoryStatus; trust: MemoryTrust; valid_until: number | null; superseded_by: string | null; source_file_id: string | null; use_count: number; accepted_count: number; last_used_at: number | null; file_fingerprint: string | null };

const toRecord = (row: Row): MemoryRecord => ({ id: row.id, projectId: row.project_id, personalBot: row.personal_bot, kind: row.kind, content: row.content,
  concepts: JSON.parse(row.concepts_json) as string[], sourceSha256: row.source_sha256, createdAt: row.created_at,
  status: row.status, trust: row.trust, validUntil: row.valid_until, supersededBy: row.superseded_by, sourceFileId: row.source_file_id,
  useCount: row.use_count, acceptedCount: row.accepted_count, lastUsedAt: row.last_used_at, fileFingerprint: row.file_fingerprint });

const estimate = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);
function storedFingerprint(content: string, readFile: StoreMemoryInput["readFile"]): string | null {
  if (!readFile) return null;
  const paths = pathsNamed(content);
  return paths.length ? fileFingerprint(paths.map((path) => ({ path, bytes: readFile(path) }))) : null;
}
const isRule = (row: Pick<Row, "concepts_json">) => row.concepts_json.includes('"rule"');

function parseScopeJson(json: string | null | undefined): string[] {
  try {
    const value = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}
const scopeKey = (scope: readonly string[]) => JSON.stringify([...scope]);

const trigramState = new WeakMap<object, boolean>();

/**
 * The trigram index (FTS5 `trigram` tokenizer: substrings and word forms). Made on first use rather than by a migration,
 * because a host SQLite older than 3.34 has no such tokenizer and a failing migration would stop the plugin; where it
 * cannot be made, search scans in code (`scanRows`). A new table is filled from the active records.
 */
export function trigramReady(db: MemoryDatabase): boolean {
  const known = trigramState.get(db);
  if (known !== undefined) return known;
  let ok = false;
  try {
    db.transaction(() => {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='lane_pilot_memory_trgm'").get()) return;
      db.prepare("CREATE VIRTUAL TABLE lane_pilot_memory_trgm USING fts5(id UNINDEXED, project_id UNINDEXED, content, concepts, tokenize='trigram')").run();
      db.prepare(`INSERT INTO lane_pilot_memory_trgm(id,project_id,content,concepts)
        SELECT id,project_id,content,COALESCE((SELECT group_concat(value,' ') FROM json_each(concepts_json)),'') FROM lane_pilot_memory WHERE status='active'`).run();
    })();
    ok = true;
  } catch { ok = false; }
  trigramState.set(db, ok);
  return ok;
}

/** Takes a record out of the search indexes (a hidden or deleted record is never found). */
export function dropMemoryIndexes(db: MemoryDatabase, projectId: string, id: string): void {
  db.prepare("DELETE FROM lane_pilot_memory_fts WHERE project_id=? AND id=?").run(projectId, id);
  if (trigramReady(db)) db.prepare("DELETE FROM lane_pilot_memory_trgm WHERE project_id=? AND id=?").run(projectId, id);
}

/** Puts a record in both search indexes; the write door and the evaluation harness share it, so a harness corpus is indexed exactly as a stored one. */
export function addToIndexes(db: MemoryDatabase, projectId: string, id: string, content: string, concepts: string[]): void {
  db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES(?,?,?,?)").run(id, projectId, content, concepts.join(" "));
  if (trigramReady(db)) db.prepare("INSERT INTO lane_pilot_memory_trgm(id,project_id,content,concepts) VALUES(?,?,?,?)").run(id, projectId, content, concepts.join(" "));
}

export type StoreMemoryInput = { projectId: string; personalBot?: string; audience: MemoryAudience; sourceSha256: string; entries: MemoryCandidate[];
  coreBudget: number; noteBudget: number; indexBudget: number;
  /** confirmed (default): the maintainer, a rule or a file; observed: one session wrote it, writers wait for a second source or the quarantine. */
  trust?: MemoryTrust; origin?: string; now?: number;
  /**
   * The sections the records belong to, outermost first (a run's settings scopes, `section:<id>`); empty or absent: the whole project.
   * A search with a chain reads the project's records and those of the chain's sections, never a sibling section's.
   */
  scope?: readonly string[];
  /** Reads a repo-relative path. When set, a note that names files stores `file_fingerprint` of those bytes. */
  readFile?: (path: string) => Uint8Array | null };
export type StoreMemoryResult = { records: MemoryRecord[]; insertedIds: string[];
  /** Notes hidden to make room under a budget, least useful first. */
  evictedIds: string[];
  /** Records a newer one replaced (same file edited, same subject, or named by the maintainer). */
  supersededIds: string[];
  /** Records whose date passed or that nobody was given for 90 days; hidden before this write. */
  expiredIds: string[];
  /** Observed records a second independent source confirmed. */
  corroboratedIds: string[] };

const HEDGED = /(?:^|[^\p{L}\p{N}])(?:maybe|perhaps|might|seems|appears|possibly|кажется|возможно|похоже)(?=$|[^\p{L}\p{N}])/iu;

/** A maintainer note that hedges is not a confirmed fact. Writers wait out the observed quarantine. */
export function claimIsHedged(content: string): boolean {
  return HEDGED.test(content);
}

export function storeMemoryRecords(db: MemoryDatabase, input: StoreMemoryInput): StoreMemoryResult {
  const now = input.now ?? Date.now();
  const trust = input.trust ?? "confirmed";
  const origin = input.origin ?? "maintainer";
  const trustOf = (entry: MemoryCandidate) => trust === "confirmed" && origin === "maintainer" && entry.kind === "note" && claimIsHedged(entry.content) ? "observed" : trust;
  trigramReady(db);
  return db.transaction(() => {
    const personalBot = input.personalBot ?? "";
    // The one door every write passes: rules and imports reach the corpus without the maintainer's parser.
    for (const entry of input.entries) { const issue = memoryContentIssue(entry.content); if (issue) throw new Error(issue); }
    // A rule concept is the rules pipeline (`origin: "rule"`). A maintainer that emits one is refused here, not only in the prompt.
    if (origin !== "rule") for (const entry of input.entries) if (entry.concepts.includes("rule")) throw new Error("memory rule concept is owned by the rules pipeline");
    const expiredIds = expireMemory(db, input.projectId, personalBot, now, (projectId, id) => dropMemoryIndexes(db, projectId, id));
    const rows = db.prepare(`SELECT ${cols()}, scope_json FROM lane_pilot_memory WHERE project_id=? AND personal_bot=?`).all(input.projectId, personalBot) as Array<Row & { scope_json: string | null }>;
    const scope = input.scope ?? [];
    const identity = (row: { kind: MemoryKind; content: string; audience: string; scope_json?: string | null }) => memoryRecordId(input.projectId, row.kind, row.content, personalBot, row.audience, parseScopeJson(row.scope_json));
    const known = new Map(rows.map((row) => [identity(row), row]));
    const pending: Array<{ entry: MemoryCandidate; id: string }> = [];
    const revive: Array<{ entry: MemoryCandidate; id: string }> = [];
    const corroborate: string[] = [];
    const seen = new Set<string>();
    for (const entry of input.entries) {
      const id = memoryRecordId(input.projectId, entry.kind, entry.content, personalBot, input.audience, scope);
      if (seen.has(id)) continue;
      seen.add(id);
      const hit = known.get(id);
      if (!hit) { if (entry.validUntil == null || entry.validUntil > now) pending.push({ entry, id }); continue; }
      if (hit.status === "active") { if (hit.trust === "observed" && hit.source_sha256 !== input.sourceSha256) corroborate.push(hit.id); continue; }
      // A hidden record comes back when its fact is stated again, or when the file it came from says so; a replaced one stays replaced otherwise.
      const wanted = hit.status === "expired" || (entry.sourceFileId != null && entry.sourceFileId === hit.source_file_id);
      if (wanted && (entry.validUntil == null || entry.validUntil > now)) revive.push({ entry, id: hit.id });
    }
    const adds = [...pending, ...revive];
    const gone = new Set<string>();
    const supersededIds: string[] = [];
    const unindex = (projectId: string, id: string) => dropMemoryIndexes(db, projectId, id);
    const replace = (oldId: string, by: string) => { if (hideRecord(db, input.projectId, oldId, "superseded", by, unindex)) { gone.add(oldId); supersededIds.push(oldId); } };
    for (const { entry, id } of adds) {
      // An edited file record: what the file said before is replaced by what it says now.
      const sameNamespace = (row: { audience: string; scope_json?: string | null }) => row.audience === input.audience && scopeKey(parseScopeJson(row.scope_json)) === scopeKey(scope);
      if (entry.sourceFileId) for (const row of rows) if (row.status === "active" && row.source_file_id === entry.sourceFileId && row.id !== id && sameNamespace(row)) replace(row.id, id);
      // One session's word does not retire what the maintainer or a file established.
      if (trust !== "confirmed") continue;
      // Replacement stays inside project + section + audience + bot. A fact already stored is not given a wider scope.
      const replaceable = rows.filter((row) => row.status === "active" && !gone.has(row.id) && row.id !== id && sameNamespace(row) && !isRule(row));
      for (const prefix of entry.supersedes ?? []) {
        const named = replaceable.filter((row) => row.id.startsWith(prefix));
        if (named.length === 1) replace(named[0]!.id, id);
      }
      // A restated note or core replaces the older wording of the same subject, inside this namespace. A different fact that only shares tags stays.
      if (entry.kind === "note" || entry.kind === "core") for (const row of replaceable) if (row.kind === entry.kind && !gone.has(row.id) && sameSubject(entry, { content: row.content, concepts: JSON.parse(row.concepts_json) as string[] })) replace(row.id, id);
    }
    const active = rows.filter((row) => row.status === "active" && !gone.has(row.id));
    const sum = (list: Array<{ content: string }>) => list.reduce((total, row) => total + estimate(row.content), 0);
    const core = sum(active.filter((row) => row.kind === "core")) + sum(adds.map((item) => item.entry).filter((entry) => entry.kind === "core"));
    const note = sum(active.filter((row) => row.kind === "note")) + sum(adds.map((item) => item.entry).filter((entry) => entry.kind === "note"));
    // Core is curated and never evicted; a corpus already over a lowered core budget still takes notes.
    if (adds.some((item) => item.entry.kind === "core") && core > input.coreBudget) throw new Error(`memory core budget exceeded: ${core}/${input.coreBudget} tokens`);
    let evictedIds: string[] = [];
    const over = (noteTokens: number) => noteTokens > input.noteBudget || core + noteTokens > input.indexBudget;
    if (over(note)) {
      // Make room instead of refusing: the notes that served briefs least go first (never core, never a rule). Nothing is hidden when even
      // an empty note shelf could not take the entry, so one oversize candidate cannot wipe the corpus.
      const victims = active.filter((row) => row.kind === "note" && !isRule(row))
        .sort((a, b) => a.accepted_count - b.accepted_count || a.use_count - b.use_count || (a.last_used_at ?? a.created_at) - (b.last_used_at ?? b.created_at) || a.created_at - b.created_at || a.id.localeCompare(b.id));
      let left = note;
      const picked: Row[] = [];
      for (const victim of victims) { if (!over(left)) break; left -= estimate(victim.content); picked.push(victim); }
      if (over(left)) throw new Error(left > input.noteBudget ? `memory note budget exceeded: ${left}/${input.noteBudget} tokens` : `memory index budget exceeded: ${core + left}/${input.indexBudget} tokens`);
      evictedIds = picked.filter((row) => hideRecord(db, input.projectId, row.id, "expired", null, unindex, "budget")).map((row) => row.id);
    }
    const insert = db.prepare(`INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin,valid_until,source_file_id,file_fingerprint)
      VALUES(@id,@projectId,@personalBot,@kind,@audience,@content,@conceptsJson,@sourceSha256,@createdAt,@trust,@origin,@validUntil,@sourceFileId,@fileFingerprint)
      ON CONFLICT(project_id,id) DO NOTHING`);
    const insertedIds: string[] = [];
    for (const { entry, id } of pending) {
      insert.run({ id, projectId: input.projectId, personalBot, kind: entry.kind, audience: input.audience, content: entry.content, conceptsJson: JSON.stringify(entry.concepts),
        sourceSha256: input.sourceSha256, createdAt: now, trust: trustOf(entry), origin, validUntil: entry.validUntil ?? null, sourceFileId: entry.sourceFileId ?? null, fileFingerprint: storedFingerprint(entry.content, input.readFile) });
      if (input.scope?.length) db.prepare("UPDATE lane_pilot_memory SET scope_json=? WHERE project_id=? AND id=?").run(JSON.stringify(input.scope), input.projectId, id);
      addToIndexes(db, input.projectId, id, entry.content, entry.concepts);
      insertedIds.push(id);
    }
    for (const { entry, id } of revive) {
      db.prepare("UPDATE lane_pilot_memory SET status='active', superseded_by=NULL, valid_until=?, source_sha256=?, trust=?, last_used_at=?, file_fingerprint=COALESCE(?, file_fingerprint) WHERE project_id=? AND id=?")
        .run(entry.validUntil ?? null, input.sourceSha256, trustOf(entry), now, storedFingerprint(entry.content, input.readFile), input.projectId, id);
      addToIndexes(db, input.projectId, id, entry.content, entry.concepts);
      insertedIds.push(id);
    }
    for (const id of corroborate) db.prepare("UPDATE lane_pilot_memory SET trust='confirmed' WHERE project_id=? AND id=?").run(input.projectId, id);
    const mine = new Set(input.entries.map((entry) => memoryRecordId(input.projectId, entry.kind, entry.content, personalBot, input.audience, scope)));
    const records = (db.prepare(`SELECT ${cols()} FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? ORDER BY created_at DESC`).all(input.projectId, personalBot) as Row[])
      .filter((row) => row.status === "active" || mine.has(row.id)).map(toRecord);
    return { records, insertedIds, evictedIds, supersededIds, expiredIds, corroboratedIds: corroborate };
  }).immediate();
}

/**
 * The project's core as the store counts it against `coreBudget` (every active core record of the bot), and the
 * records a maintainer of this audience and section may name in `supersedes` (rules stay with the rules pipeline).
 */
export function coreShelf(db: MemoryDatabase, projectId: string, personalBot: string, audience: MemoryAudience, scope: readonly string[] = []): { tokens: number; replaceable: Array<{ id: string; content: string }> } {
  const rows = db.prepare("SELECT id,audience,content,concepts_json,scope_json FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? AND kind='core' AND status='active' ORDER BY created_at, id")
    .all(projectId, personalBot) as Array<Pick<Row, "id" | "audience" | "content" | "concepts_json"> & { scope_json: string | null }>;
  const key = scopeKey(scope);
  return { tokens: rows.reduce((total, row) => total + estimate(row.content), 0),
    replaceable: rows.filter((row) => row.audience === audience && scopeKey(parseScopeJson(row.scope_json)) === key && !isRule(row)).map((row) => ({ id: row.id, content: row.content })) };
}

/**
 * The maintainer's write door. Core is curated and never evicted, so a full core used to refuse every batch that
 * contained a core entry and lose its notes too (hub 2026-10-27/28, «memory core budget exceeded: 3135/3072» on a
 * core of 3070; the same throw was reverted with 2f00913e). A core entry the core cannot take is kept as a note,
 * the last one first, until the batch fits. `entries` is what was stored, `demoted` how many core entries became notes.
 * Any other refusal is thrown. The raw door `storeMemoryRecords` still throws, so a rule that does not fit can evict
 * an unused convention instead of becoming a note.
 */
export function storeMemoryRecordsKeepingOverflow(db: MemoryDatabase, input: StoreMemoryInput): StoreMemoryResult & { entries: MemoryCandidate[]; demoted: number } {
  let entries = input.entries;
  for (let demoted = 0; ; demoted++) {
    try {
      return { ...storeMemoryRecords(db, { ...input, entries }), entries, demoted };
    } catch (cause) {
      let last = -1;
      for (let index = 0; index < entries.length; index++) if (entries[index]!.kind === "core") last = index;
      if (last < 0 || !/^memory core budget exceeded/.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
      entries = entries.map((entry, index) => (index === last ? { ...entry, kind: "note" as const } : entry));
    }
  }
}

/** What a file that is no longer true leaves behind: the records it made are hidden, with the status that says why. */
export function hideRecordsOfFile(db: MemoryDatabase, projectId: string, personalBot: string, fileId: string, status: "superseded" | "expired"): string[] {
  const ids = (db.prepare("SELECT id FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? AND source_file_id=? AND status='active'").all(projectId, personalBot, fileId) as Array<{ id: string }>).map((row) => row.id);
  return ids.filter((id) => hideRecord(db, projectId, id, status, null, (project, record) => dropMemoryIndexes(db, project, record)));
}

/** Who may read a record: active and in date; a record only one session or import vouches for waits for a second source or the quarantine. */
export type SearchOptions = { now?: number; includeObserved?: boolean;
  /**
   * The reader's sections, outermost first. Omitted means the project root only (`[]`): a working reader that forgot
   * its chain does not see every section. `allSections` is the named admin search.
   */
  chain?: readonly string[];
  allSections?: boolean };

/** The scope values a reader with this chain sees: the whole project and every prefix of its chain. */
export function scopeValuesFor(chain: readonly string[]): string[] {
  return Array.from({ length: chain.length + 1 }, (_, length) => JSON.stringify(chain.slice(0, length)));
}
const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

function visibility(db: MemoryDatabase, alias: string, options: SearchOptions): string {
  const now = Math.floor(options.now ?? Date.now());
  // A note of a held conflict (two notes that disagree, waiting for a person) is read by nobody: `conflict-store.ts`.
  return `${alias}.status='active' AND (${alias}.valid_until IS NULL OR ${alias}.valid_until>${now}) AND NOT (${idleSql(alias, now)})`
    + (options.includeObserved ? "" : ` AND (${alias}.trust='confirmed' OR ${alias}.created_at<=${now - OBSERVED_QUARANTINE_MS})`) + heldClause(db, alias)
    + (options.allSections ? "" : ` AND ${alias}.scope_json IN (${scopeValuesFor(options.chain ?? []).map(sqlString).join(",")})`);
}

/** The visibility clause working readers share. A missing chain is the project root, not every section. */
export function memoryVisibilitySql(db: MemoryDatabase, alias: string, options: SearchOptions = {}): string {
  return visibility(db, alias, options);
}

/** Admin search: every section of the project. Working readers use `searchMemoryRecords` and pass their chain. */
export function searchMemoryAllSections(db: MemoryDatabase, projectId: string, query: string, limit: number, engine: MemorySearchEngine, audience: MemoryAudience = "subagent", personalBot = "", options: Omit<SearchOptions, "allSections" | "chain"> = {}): MemoryRecord[] {
  return searchMemoryRecords(db, projectId, query, limit, engine, audience, personalBot, { ...options, allSections: true });
}

export function searchMemoryRecords(db: MemoryDatabase, projectId: string, query: string, limit: number, engine: MemorySearchEngine, audience: MemoryAudience = "subagent", personalBot = "", options: SearchOptions = {}): MemoryRecord[] {
  const tokens = [...new Set(memoryTokens(query))].slice(0, 32);
  if (tokens.length === 0 || limit <= 0) return [];
  let rows: Row[];
  if (engine !== "bm25") {
    const match = tokens.map((word) => `"${word.replaceAll('"', "")}"`).join(" OR ");
    const words = db.prepare(`SELECT ${cols("m.")}
      FROM lane_pilot_memory_fts f JOIN lane_pilot_memory m ON m.id=f.id AND m.project_id=f.project_id
      WHERE lane_pilot_memory_fts MATCH ? AND f.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility(db, "m", options)}
      ORDER BY bm25(lane_pilot_memory_fts) LIMIT ?`).all(match, projectId, audience, personalBot, limit) as Row[];
    // Word forms and substrings the whole-word index misses: the trigram index, or a scan where SQLite has none.
    const stems = [...new Set(tokens.map(memoryStem))];
    const parts = trigramReady(db)
      ? db.prepare(`SELECT ${cols("m.")}
        FROM lane_pilot_memory_trgm t JOIN lane_pilot_memory m ON m.id=t.id AND m.project_id=t.project_id
        WHERE lane_pilot_memory_trgm MATCH ? AND t.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility(db, "m", options)}
        ORDER BY bm25(lane_pilot_memory_trgm) LIMIT ?`).all(stems.map((stem) => `"${stem.replaceAll('"', "")}"`).join(" OR "), projectId, audience, personalBot, limit) as Row[]
      : scanRows(db, projectId, audience, personalBot, stems, options, limit);
    rows = fuse([words, parts], limit);
  } else {
    const all = db.prepare(`SELECT ${cols("m.")} FROM lane_pilot_memory m WHERE m.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility(db, "m", options)}`).all(projectId, audience, personalBot) as Row[];
    const score = (text: string) => tokens.reduce((sum, token) => sum + (text.toLowerCase().split(token).length - 1), 0);
    rows = all.map((row) => ({ ...row, _score: score(`${row.content} ${row.concepts_json}`) })).filter((row) => row._score > 0).sort((a, b) => b._score - a._score || b.created_at - a.created_at).slice(0, limit);
  }
  return rows.map(toRecord);
}

/** Reciprocal rank fusion of ranked lists with equal weight: a record both lists find outranks one only a list finds. */
function fuse(lists: Row[][], limit: number): Row[] {
  const scored = new Map<string, { row: Row; score: number }>();
  for (const list of lists) list.forEach((row, rank) => {
    const hit = scored.get(row.id);
    if (hit) hit.score += 1 / (60 + rank + 1); else scored.set(row.id, { row, score: 1 / (60 + rank + 1) });
  });
  return [...scored.values()].sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at).slice(0, limit).map((item) => item.row);
}

/** The in-code stand-in for the trigram index: records whose text contains the stems, most stems first. */
function scanRows(db: MemoryDatabase, projectId: string, audience: MemoryAudience, personalBot: string, stems: string[], options: SearchOptions, limit: number): Row[] {
  const all = db.prepare(`SELECT ${cols("m.")} FROM lane_pilot_memory m WHERE m.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility(db, "m", options)}`).all(projectId, audience, personalBot) as Row[];
  const score = (row: Row) => { const text = `${row.content} ${row.concepts_json}`.toLowerCase(); return stems.filter((stem) => text.includes(stem)).length; };
  return all.map((row) => ({ row, score: score(row) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at).slice(0, limit).map((item) => item.row);
}

/**
 * Visible records of a kind and/or carrying any of the given tags, newest first: what a role wants regardless of the
 * words of the task at hand (a reviewer's checks, the project's core conventions).
 */
export function listMemory(db: MemoryDatabase, projectId: string, filter: { kind?: MemoryKind; concepts?: readonly string[] }, limit: number, audience: MemoryAudience = "subagent", personalBot = "", options: SearchOptions = {}): MemoryRecord[] {
  if (limit <= 0) return [];
  const concepts = filter.concepts ?? [];
  const where = [filter.kind ? "m.kind=?" : "", concepts.length ? `(${concepts.map(() => "m.concepts_json LIKE ?").join(" OR ")})` : ""].filter(Boolean);
  const args = [...(filter.kind ? [filter.kind] : []), ...concepts.map((concept) => `%"${concept}"%`)];
  return (db.prepare(`SELECT ${cols("m.")} FROM lane_pilot_memory m WHERE m.project_id=? AND m.audience=? AND m.personal_bot=? ${where.map((part) => `AND ${part}`).join(" ")} AND ${visibility(db, "m", options)}
    ORDER BY m.created_at DESC LIMIT ?`).all(projectId, audience, personalBot, ...args, limit) as Row[]).map(toRecord);
}
