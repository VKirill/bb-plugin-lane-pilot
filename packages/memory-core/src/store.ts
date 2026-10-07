import { memoryContentIssue } from "./candidates";
import type Database from "better-sqlite3";
import { memoryRecordId } from "./candidates";
import { OBSERVED_QUARANTINE_MS, expireMemory, hideRecord, idleSql, sameSubject } from "./lifecycle";
import type { MemoryAudience, MemoryCandidate, MemoryKind, MemoryRecord, MemorySearchEngine, MemoryStatus, MemoryTrust } from "./settings";

/** The better-sqlite3 surface this package needs; BB's `bb.storage.database()` satisfies it. */
export type MemoryDatabase = Pick<Database.Database, "prepare" | "transaction">;

/** Columns the package expects; the owning plugin ships the migration. */
export const MEMORY_SCHEMA = {
  table: "lane_pilot_memory",
  fts: "lane_pilot_memory_fts",
  columns: ["id", "project_id", "personal_bot", "kind", "audience", "content", "concepts_json", "source_sha256", "created_at",
    "status", "superseded_by", "valid_until", "last_used_at", "use_count", "accepted_count", "trust", "origin", "source_file_id"],
} as const;

const COLUMNS = ["id", "project_id", "personal_bot", "kind", "audience", "content", "concepts_json", "source_sha256", "created_at",
  "status", "trust", "valid_until", "superseded_by", "source_file_id", "use_count", "accepted_count", "last_used_at"];
const cols = (alias = "") => COLUMNS.map((name) => `${alias}${name}`).join(",");

type Row = { id: string; project_id: string; personal_bot: string; kind: MemoryKind; audience: string; content: string; concepts_json: string; source_sha256: string; created_at: number;
  status: MemoryStatus; trust: MemoryTrust; valid_until: number | null; superseded_by: string | null; source_file_id: string | null; use_count: number; accepted_count: number; last_used_at: number | null };

const toRecord = (row: Row): MemoryRecord => ({ id: row.id, projectId: row.project_id, personalBot: row.personal_bot, kind: row.kind, content: row.content,
  concepts: JSON.parse(row.concepts_json) as string[], sourceSha256: row.source_sha256, createdAt: row.created_at,
  status: row.status, trust: row.trust, validUntil: row.valid_until, supersededBy: row.superseded_by, sourceFileId: row.source_file_id,
  useCount: row.use_count, acceptedCount: row.accepted_count, lastUsedAt: row.last_used_at });

const estimate = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);
const isRule = (row: Pick<Row, "concepts_json">) => row.concepts_json.includes('"rule"');

/** Takes a record out of the search indexes (a hidden or deleted record is never found). */
export function dropMemoryIndexes(db: MemoryDatabase, projectId: string, id: string): void {
  db.prepare("DELETE FROM lane_pilot_memory_fts WHERE project_id=? AND id=?").run(projectId, id);
}

function addToIndexes(db: MemoryDatabase, projectId: string, id: string, content: string, concepts: string[]): void {
  db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES(?,?,?,?)").run(id, projectId, content, concepts.join(" "));
}

export type StoreMemoryInput = { projectId: string; personalBot?: string; audience: MemoryAudience; sourceSha256: string; entries: MemoryCandidate[];
  coreBudget: number; noteBudget: number; indexBudget: number;
  /** confirmed (default): the maintainer, a rule or a file; observed: one session wrote it, writers wait for a second source or the quarantine. */
  trust?: MemoryTrust; origin?: string; now?: number };
export type StoreMemoryResult = { records: MemoryRecord[]; insertedIds: string[];
  /** Notes hidden to make room under a budget, least useful first. */
  evictedIds: string[];
  /** Records a newer one replaced (same file edited, same subject, or named by the maintainer). */
  supersededIds: string[];
  /** Records whose date passed or that nobody was given for 90 days; hidden before this write. */
  expiredIds: string[];
  /** Observed records a second independent source confirmed. */
  corroboratedIds: string[] };

export function storeMemoryRecords(db: MemoryDatabase, input: StoreMemoryInput): StoreMemoryResult {
  const now = input.now ?? Date.now();
  const trust = input.trust ?? "confirmed";
  const origin = input.origin ?? "maintainer";
  return db.transaction(() => {
    const personalBot = input.personalBot ?? "";
    // The one door every write passes: rules and imports reach the corpus without the maintainer's parser.
    for (const entry of input.entries) { const issue = memoryContentIssue(entry.content); if (issue) throw new Error(issue); }
    const expiredIds = expireMemory(db, input.projectId, personalBot, now, (projectId, id) => dropMemoryIndexes(db, projectId, id));
    const rows = db.prepare(`SELECT ${cols()} FROM lane_pilot_memory WHERE project_id=? AND personal_bot=?`).all(input.projectId, personalBot) as Row[];
    const known = new Map(rows.map((row) => [memoryRecordId(input.projectId, row.kind, row.content, personalBot), row]));
    const pending: Array<{ entry: MemoryCandidate; id: string }> = [];
    const revive: Array<{ entry: MemoryCandidate; id: string }> = [];
    const corroborate: string[] = [];
    const seen = new Set<string>();
    for (const entry of input.entries) {
      const id = memoryRecordId(input.projectId, entry.kind, entry.content, personalBot);
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
      if (entry.sourceFileId) for (const row of rows) if (row.status === "active" && row.source_file_id === entry.sourceFileId && row.id !== id) replace(row.id, id);
      // One session's word does not retire what the maintainer or a file established.
      if (trust !== "confirmed") continue;
      const replaceable = rows.filter((row) => row.status === "active" && !gone.has(row.id) && row.id !== id && row.audience === input.audience && !isRule(row));
      for (const prefix of entry.supersedes ?? []) {
        const named = replaceable.filter((row) => row.id.startsWith(prefix));
        if (named.length === 1) replace(named[0]!.id, id);
      }
      // A restated note replaces the older wording of the same subject.
      if (entry.kind === "note") for (const row of replaceable) if (row.kind === "note" && !gone.has(row.id) && sameSubject(entry, { content: row.content, concepts: JSON.parse(row.concepts_json) as string[] })) replace(row.id, id);
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
      evictedIds = picked.filter((row) => hideRecord(db, input.projectId, row.id, "expired", null, unindex)).map((row) => row.id);
    }
    const insert = db.prepare(`INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin,valid_until,source_file_id)
      VALUES(@id,@projectId,@personalBot,@kind,@audience,@content,@conceptsJson,@sourceSha256,@createdAt,@trust,@origin,@validUntil,@sourceFileId)
      ON CONFLICT(project_id,id) DO NOTHING`);
    const insertedIds: string[] = [];
    for (const { entry, id } of pending) {
      insert.run({ id, projectId: input.projectId, personalBot, kind: entry.kind, audience: input.audience, content: entry.content, conceptsJson: JSON.stringify(entry.concepts),
        sourceSha256: input.sourceSha256, createdAt: now, trust, origin, validUntil: entry.validUntil ?? null, sourceFileId: entry.sourceFileId ?? null });
      addToIndexes(db, input.projectId, id, entry.content, entry.concepts);
      insertedIds.push(id);
    }
    for (const { entry, id } of revive) {
      db.prepare("UPDATE lane_pilot_memory SET status='active', superseded_by=NULL, valid_until=?, source_sha256=?, trust=?, last_used_at=? WHERE project_id=? AND id=?")
        .run(entry.validUntil ?? null, input.sourceSha256, trust, now, input.projectId, id);
      addToIndexes(db, input.projectId, id, entry.content, entry.concepts);
      insertedIds.push(id);
    }
    for (const id of corroborate) db.prepare("UPDATE lane_pilot_memory SET trust='confirmed' WHERE project_id=? AND id=?").run(input.projectId, id);
    const mine = new Set(input.entries.map((entry) => memoryRecordId(input.projectId, entry.kind, entry.content, personalBot)));
    const records = (db.prepare(`SELECT ${cols()} FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? ORDER BY created_at DESC`).all(input.projectId, personalBot) as Row[])
      .filter((row) => row.status === "active" || mine.has(row.id)).map(toRecord);
    return { records, insertedIds, evictedIds, supersededIds, expiredIds, corroboratedIds: corroborate };
  }).immediate();
}

/** What a file that is no longer true leaves behind: the records it made are hidden, with the status that says why. */
export function hideRecordsOfFile(db: MemoryDatabase, projectId: string, personalBot: string, fileId: string, status: "superseded" | "expired"): string[] {
  const ids = (db.prepare("SELECT id FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? AND source_file_id=? AND status='active'").all(projectId, personalBot, fileId) as Array<{ id: string }>).map((row) => row.id);
  return ids.filter((id) => hideRecord(db, projectId, id, status, null, (project, record) => dropMemoryIndexes(db, project, record)));
}

/** Who may read a record: active and in date; a record only one session or import vouches for waits for a second source or the quarantine. */
export type SearchOptions = { now?: number; includeObserved?: boolean };

function visibility(alias: string, options: SearchOptions): string {
  const now = Math.floor(options.now ?? Date.now());
  return `${alias}.status='active' AND (${alias}.valid_until IS NULL OR ${alias}.valid_until>${now}) AND NOT (${idleSql(alias, now)})`
    + (options.includeObserved ? "" : ` AND (${alias}.trust='confirmed' OR ${alias}.created_at<=${now - OBSERVED_QUARANTINE_MS})`);
}

export function searchMemoryRecords(db: MemoryDatabase, projectId: string, query: string, limit: number, engine: MemorySearchEngine, audience: MemoryAudience = "subagent", personalBot = "", options: SearchOptions = {}): MemoryRecord[] {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].slice(0, 32);
  if (tokens.length === 0 || limit <= 0) return [];
  let rows: Row[];
  if (engine !== "bm25") {
    const match = tokens.map((word) => `"${word.replaceAll('"', "")}"`).join(" OR ");
    rows = db.prepare(`SELECT ${cols("m.")}
      FROM lane_pilot_memory_fts f JOIN lane_pilot_memory m ON m.id=f.id AND m.project_id=f.project_id
      WHERE lane_pilot_memory_fts MATCH ? AND f.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility("m", options)}
      ORDER BY bm25(lane_pilot_memory_fts) LIMIT ?`).all(match, projectId, audience, personalBot, limit) as Row[];
  } else {
    const all = db.prepare(`SELECT ${cols("m.")} FROM lane_pilot_memory m WHERE m.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility("m", options)}`).all(projectId, audience, personalBot) as Row[];
    const score = (text: string) => tokens.reduce((sum, token) => sum + (text.toLowerCase().split(token).length - 1), 0);
    rows = all.map((row) => ({ ...row, _score: score(`${row.content} ${row.concepts_json}`) })).filter((row) => row._score > 0).sort((a, b) => b._score - a._score || b.created_at - a.created_at).slice(0, limit);
  }
  return rows.map(toRecord);
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
  return (db.prepare(`SELECT ${cols("m.")} FROM lane_pilot_memory m WHERE m.project_id=? AND m.audience=? AND m.personal_bot=? ${where.map((part) => `AND ${part}`).join(" ")} AND ${visibility("m", options)}
    ORDER BY m.created_at DESC LIMIT ?`).all(projectId, audience, personalBot, ...args, limit) as Row[]).map(toRecord);
}
