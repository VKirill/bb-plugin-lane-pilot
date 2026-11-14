import { fileFingerprint, pathsNamed } from "./fingerprint";
import { memoryContentIssue, memoryRecordId } from "./candidates";
import type Database from "better-sqlite3";
import { OBSERVED_QUARANTINE_MS, expireMemory, hideRecord, idleSql, sameSubject } from "./lifecycle";
import { memoryStem, memoryTokens } from "./terms";
import { conflictTableReady, heldClause, holdConflict } from "./conflict-store";
import { denseRank, queryVectorFor } from "./vectors";
import { duplicateDoor, withoutShadowedDuplicates } from "./duplicates";
import { pathAnchorsOf } from "./floor";
import { crossesLanguage, languageOf } from "./language";
import { boostAskingSection, type MemoryScopeMode } from "./section-boost"; export type { MemoryScopeMode };
import { doorOpens, lockQueryText, type DoorLock } from "./door-lock";
import type { MemoryAudience, MemoryCandidate, MemoryKind, MemoryRecord, MemorySearchEngine, MemoryStatus, MemoryTrust } from "./settings";

/** The better-sqlite3 surface this package needs; BB's `bb.storage.database()` satisfies it. */
export type MemoryDatabase = Pick<Database.Database, "prepare" | "transaction">;

/** Columns the package expects; the owning plugin ships the migration. */
export const MEMORY_SCHEMA = {
  table: "lane_pilot_memory",
  fts: "lane_pilot_memory_fts",
  columns: ["id", "project_id", "personal_bot", "kind", "audience", "content", "concepts_json", "source_sha256", "created_at",
    "status", "superseded_by", "valid_until", "valid_from", "last_used_at", "use_count", "accepted_count", "trust", "origin", "source_file_id", "scope_json", "file_fingerprint", "origin_task_id", "verification_json"],
} as const;

const COLUMNS = ["id", "project_id", "personal_bot", "kind", "audience", "content", "concepts_json", "source_sha256", "created_at",
  "status", "trust", "valid_until", "valid_from", "superseded_by", "source_file_id", "use_count", "accepted_count", "last_used_at", "file_fingerprint", "origin_task_id", "verification_json"];
const cols = (alias = "") => COLUMNS.map((name) => `${alias}${name}`).join(",");

type Row = { id: string; project_id: string; personal_bot: string; kind: MemoryKind; audience: string; content: string; concepts_json: string; source_sha256: string; created_at: number;
  status: MemoryStatus; trust: MemoryTrust; valid_until: number | null; valid_from: number | null; superseded_by: string | null; source_file_id: string | null; use_count: number; accepted_count: number; last_used_at: number | null; file_fingerprint: string | null; origin_task_id: string | null; verification_json: string | null };

const toRecord = (row: Row): MemoryRecord => ({ id: row.id, projectId: row.project_id, personalBot: row.personal_bot, kind: row.kind, content: row.content,
  concepts: JSON.parse(row.concepts_json) as string[], sourceSha256: row.source_sha256, createdAt: row.created_at,
  status: row.status, trust: row.trust, validUntil: row.valid_until, validFrom: row.valid_from, supersededBy: row.superseded_by, sourceFileId: row.source_file_id,
  useCount: row.use_count, acceptedCount: row.accepted_count, lastUsedAt: row.last_used_at, fileFingerprint: row.file_fingerprint, originTaskId: row.origin_task_id, verification: parseVerification(row.verification_json) });

const estimate = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);
function storedFingerprint(content: string, readFile: StoreMemoryInput["readFile"]): string | null {
  if (!readFile) return null;
  const paths = pathsNamed(content);
  return paths.length ? fileFingerprint(paths.map((path) => ({ path, bytes: readFile(path) }))) : null;
}
const parseVerification = (json: string | null): Array<{ by: string; sha: string; at: number }> => {
  try { const value = JSON.parse(json ?? "[]") as unknown; return Array.isArray(value) ? value as Array<{ by: string; sha: string; at: number }> : []; } catch { return []; }
};
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
  // A table made inside a transaction that later rolls back (a dry-run import on a fresh database) goes with it: only a call outside one is remembered.
  if (!(db as { inTransaction?: boolean }).inTransaction) trigramState.set(db, ok);
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
  /** The task these records came from: every stored row keeps it for the audit trail. */
  originTaskId?: string;
  /** Reads a repo-relative path. When set, a note that names files stores `file_fingerprint` of those bytes. */
  readFile?: (path: string) => Uint8Array | null;
  /** Near-duplicate door (`duplicates.ts`), default on; `vectorOf` is the embedding of a new text when the caller made one. */ nearDuplicates?: boolean; vectorOf?: (content: string) => Float32Array | null | undefined };
export type StoreMemoryResult = { records: MemoryRecord[]; insertedIds: string[];
  /** Notes moved off the shelf to the archive to make room under a budget, least useful first. They stay searchable. */
  evictedIds: string[];
  /** New notes of an import that did not fit the shelf and were stored straight in the archive. */
  archivedIds: string[];
  /** Records a newer one replaced (same file edited, same subject, or named by the maintainer). */
  supersededIds: string[];
  /** Records whose date passed or that nobody was given for 90 days; hidden before this write. */
  expiredIds: string[];
  /** Observed records a second independent source confirmed. */
  corroboratedIds: string[];
  /** Recently used notes whose replacement is held as a conflict for a person (arXiv #15). */
  heldIds: string[];
  /** Stored notes that absorbed a copy of themselves (no new row; the copy's source is one more origin). */ duplicateIds: string[] };

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
    const rows = db.prepare(`SELECT ${cols()}, scope_json, expired_reason FROM lane_pilot_memory WHERE project_id=? AND personal_bot=?`).all(input.projectId, personalBot) as Array<Row & { scope_json: string | null; expired_reason: string | null }>;
    const scope = input.scope ?? [];
    const identity = (row: { kind: MemoryKind; content: string; audience: string; scope_json?: string | null }) => memoryRecordId(input.projectId, row.kind, row.content, personalBot, row.audience, parseScopeJson(row.scope_json));
    const known = new Map(rows.map((row) => [identity(row), row]));
    const pending: Array<{ entry: MemoryCandidate; id: string }> = [];
    const revive: Array<{ entry: MemoryCandidate; id: string }> = [];
    const corroborate: string[] = [];
    const seen = new Set<string>(); const door = duplicateDoor(db, { ...input, rows, origin, trust, now, corroborate, namespace: (row) => row.audience === input.audience && scopeKey(parseScopeJson(row.scope_json)) === scopeKey(scope) });
    // A note shortened by memory-compress stays shortened: its old long wording is not revived by a re-import of the same file.
    const compressed = new Set(rows.filter((row) => row.status === "active" && row.verification_json?.includes('"by":"compress"')).map((row) => row.id));
    for (const entry of input.entries) {
      const id = memoryRecordId(input.projectId, entry.kind, entry.content, personalBot, input.audience, scope);
      if (seen.has(id)) continue;
      seen.add(id);
      const hit = known.get(id);
      if (!hit) { if ((entry.validUntil == null || entry.validUntil > now) && !door.absorbs(entry, id)) pending.push({ entry, id }); continue; }
      if (hit.status === "superseded" && hit.superseded_by && compressed.has(hit.superseded_by)) continue;
      if (hit.status === "active") { if (hit.trust === "observed" && hit.source_sha256 !== input.sourceSha256) corroborate.push(hit.id); continue; }
      // An owner tombstone (`memory forget --expire` or `--replace`, both marked `owner`) never revives — a restated fact does not
      // bring it back, and a re-import of the file it came from does not either (SMA m_lifecycle).
      if (hit.expired_reason === "owner") continue;
      // A hidden record comes back when its fact is stated again, or when the file it came from says so; a replaced one stays replaced otherwise.
      // A revoked one never does, on any path (restated, re-imported from its file): the owner withdrew that fact. An archived one
      // stays in the cold tier too: the owner moved it there, and only a PM query (reactivateColdMemory) or the owner brings it back.
      if (hit.status === "expired" && (hit.expired_reason === "revoked" || hit.expired_reason === "archived" || hit.expired_reason === "duplicate")) continue;
      const wanted = hit.status === "expired" || (entry.sourceFileId != null && entry.sourceFileId === hit.source_file_id);
      if (wanted && (entry.validUntil == null || entry.validUntil > now)) revive.push({ entry, id: hit.id });
    }
    const adds = [...pending, ...revive];
    const gone = new Set<string>();
    const supersededIds: string[] = [];
    // A note a brief used in the last month is still load-bearing: its replacement is registered as a conflict for a
    // person to settle instead of being hidden silently (arXiv #15 stability check). The register also hides the new
    // wording until settled, so no version of a disputed fact is served meanwhile.
    const heldIds: string[] = [];
    const STABLE_MS = 30 * 86_400_000;
    const stillUsed = (row: Row) => (row.accepted_count > 0 || row.use_count > 0) && (row.last_used_at ?? row.created_at) >= now - STABLE_MS;
    const hold = (oldId: string, by: string) => {
      if (!conflictTableReady(db)) return false;
      return Boolean(holdConflict(db, { projectId: input.projectId, personalBot, now,
        conflict: { a: oldId, b: by, kind: "value", subject: "same-subject replacement of a recently used note", evidenceA: "", evidenceB: "" } }));
    };
    const unindex = (projectId: string, id: string) => dropMemoryIndexes(db, projectId, id);
    const replace = (oldId: string, by: string, row?: Row) => {
      if (row && stillUsed(row) && hold(oldId, by)) { gone.add(oldId); heldIds.push(oldId); return; }
      if (hideRecord(db, input.projectId, oldId, "superseded", by, unindex)) { gone.add(oldId); supersededIds.push(oldId); }
    };
    for (const { entry, id } of adds) {
      // An edited file record: what the file said before is replaced by what it says now.
      const sameNamespace = (row: { audience: string; scope_json?: string | null }) => row.audience === input.audience && scopeKey(parseScopeJson(row.scope_json)) === scopeKey(scope);
      if (entry.sourceFileId) for (const row of rows) if (row.status === "active" && row.source_file_id === entry.sourceFileId && row.id !== id && sameNamespace(row)) replace(row.id, id, row);
      // One session's word does not retire what the maintainer or a file established.
      if (trust !== "confirmed") continue;
      const extended = door.extendsOf.get(id); // a strict superset of a stored note is its next version
      if (extended && !gone.has(extended)) replace(extended, id, door.rows.get(extended) as Row | undefined);
      // Replacement stays inside project + section + audience + bot. A fact already stored is not given a wider scope.
      const replaceable = rows.filter((row) => row.status === "active" && !gone.has(row.id) && row.id !== id && sameNamespace(row) && !isRule(row));
      for (const prefix of entry.supersedes ?? []) {
        const named = replaceable.filter((row) => row.id.startsWith(prefix));
        if (named.length === 1) replace(named[0]!.id, id, named[0]);
      }
      // A restated note or core replaces the older wording of the same subject, inside this namespace. A note still in use is held instead of dropped. A different fact that only shares tags stays.
      if (entry.kind === "note" || entry.kind === "core") for (const row of replaceable) if (row.kind === entry.kind && !gone.has(row.id) && sameSubject(entry, { content: row.content, concepts: JSON.parse(row.concepts_json) as string[] })) replace(row.id, id, row);
    }
    const active = rows.filter((row) => row.status === "active" && !gone.has(row.id));
    const sum = (list: Array<{ content: string }>) => list.reduce((total, row) => total + estimate(row.content), 0);
    const core = sum(active.filter((row) => row.kind === "core")) + sum(adds.map((item) => item.entry).filter((entry) => entry.kind === "core"));
    const shelf = sum(active.filter((row) => row.kind === "note"));
    // Core is curated and never evicted; a corpus already over a lowered core budget still takes notes.
    if (adds.some((item) => item.entry.kind === "core") && core > input.coreBudget) throw new Error(`memory core budget exceeded: ${core}/${input.coreBudget} tokens`);
    let evictedIds: string[] = [];
    const over = (noteTokens: number) => noteTokens > input.noteBudget || core + noteTokens > input.indexBudget;
    // The budget limits the shelf (what a brief may inject), not the memory: what does not fit goes to the archive, still searchable, never deleted.
    // An import never displaces the shelf: the notes of a file that do not fit arrive in the archive.
    const archiveIds = new Set<string>();
    let note = shelf + sum(adds.map((item) => item.entry).filter((entry) => entry.kind === "note"));
    if (origin === "import") {
      note = shelf;
      for (const { entry, id } of adds) if (entry.kind === "note") { const cost = estimate(entry.content); if (over(note + cost)) archiveIds.add(id); else note += cost; }
    }
    if (origin !== "import" && over(note)) {
      // Make room instead of refusing: the notes that served briefs least go to the archive first (never core, never a rule). Nothing moves when even
      // an empty note shelf could not take the entry, so one oversize candidate cannot empty the shelf.
      const victims = active.filter((row) => row.kind === "note" && !isRule(row))
        .sort((a, b) => a.accepted_count - b.accepted_count || a.use_count - b.use_count || (a.last_used_at ?? a.created_at) - (b.last_used_at ?? b.created_at) || a.created_at - b.created_at || a.id.localeCompare(b.id));
      let left = note;
      const picked: Row[] = [];
      for (const victim of victims) { if (!over(left)) break; left -= estimate(victim.content); picked.push(victim); }
      if (over(left)) throw new Error(left > input.noteBudget ? `memory note budget exceeded: ${left}/${input.noteBudget} tokens` : `memory index budget exceeded: ${core + left}/${input.indexBudget} tokens`);
      // The word indexes and the vector of an archived note stay: `searchMemoryRecords` with `includeArchive` finds it.
      evictedIds = picked.filter((row) => hideRecord(db, input.projectId, row.id, "expired", null, () => {}, "budget")).map((row) => row.id);
    }
    const insert = db.prepare(`INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin,valid_until,valid_from,source_file_id,file_fingerprint,origin_task_id,verification_json)
      VALUES(@id,@projectId,@personalBot,@kind,@audience,@content,@conceptsJson,@sourceSha256,@createdAt,@trust,@origin,@validUntil,@validFrom,@sourceFileId,@fileFingerprint,@originTaskId,@verificationJson)
      ON CONFLICT(project_id,id) DO NOTHING`);
    const insertedIds: string[] = [];
    for (const { entry, id } of pending) {
      insert.run({ id, projectId: input.projectId, personalBot, kind: entry.kind, audience: input.audience, content: entry.content, conceptsJson: JSON.stringify(entry.concepts),
        sourceSha256: input.sourceSha256, createdAt: now, trust: trustOf(entry), origin, validUntil: entry.validUntil ?? null, validFrom: entry.validFrom ?? now, sourceFileId: entry.sourceFileId ?? null, fileFingerprint: storedFingerprint(entry.content, input.readFile), originTaskId: input.originTaskId ?? null, verificationJson: JSON.stringify([{ by: origin, sha: input.sourceSha256, at: now }]) });
      if (input.scope?.length) db.prepare("UPDATE lane_pilot_memory SET scope_json=? WHERE project_id=? AND id=?").run(JSON.stringify(input.scope), input.projectId, id);
      addToIndexes(db, input.projectId, id, entry.content, entry.concepts);
      if (archiveIds.has(id)) db.prepare("UPDATE lane_pilot_memory SET status='expired', expired_reason='budget' WHERE project_id=? AND id=?").run(input.projectId, id);
      insertedIds.push(id);
    }
    for (const { entry, id } of revive) {
      // A revived note that does not fit an import stays where it is.
      if (archiveIds.has(id)) continue;
      db.prepare("UPDATE lane_pilot_memory SET status='active', superseded_by=NULL, valid_until=?, source_sha256=?, trust=?, last_used_at=?, file_fingerprint=COALESCE(?, file_fingerprint) WHERE project_id=? AND id=?")
        .run(entry.validUntil ?? null, input.sourceSha256, trustOf(entry), now, storedFingerprint(entry.content, input.readFile), input.projectId, id);
      // An archived note kept its index rows; a hidden one lost them.
      dropMemoryIndexes(db, input.projectId, id);
      addToIndexes(db, input.projectId, id, entry.content, entry.concepts);
      insertedIds.push(id);
    }
    const verify = db.prepare(`UPDATE lane_pilot_memory SET trust='confirmed',
        verification_json=json_insert(COALESCE(verification_json,'[]'),'$[#]',json_object('by',?,'sha',?,'at',?)) WHERE project_id=? AND id=?`);
    const verifyObserved = db.prepare(`UPDATE lane_pilot_memory SET
        verification_json=json_insert(COALESCE(verification_json,'[]'),'$[#]',json_object('by',?,'sha',?,'at',?)) WHERE project_id=? AND id=?`);
    const contentOf = db.prepare("SELECT content FROM lane_pilot_memory WHERE project_id=? AND id=?");
    for (const id of corroborate) {
      // A corroborated hedged claim is still a hedge: the repeat adds a source, not certainty (session records too).
      const hedged = claimIsHedged((contentOf.get(input.projectId, id) as { content: string } | undefined)?.content ?? "");
      (hedged ? verifyObserved : verify).run(origin, input.sourceSha256, now, input.projectId, id);
    }
    const mine = new Set(input.entries.map((entry) => memoryRecordId(input.projectId, entry.kind, entry.content, personalBot, input.audience, scope)));
    const records = (db.prepare(`SELECT ${cols()} FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? ORDER BY created_at DESC`).all(input.projectId, personalBot) as Row[])
      .filter((row) => row.status === "active" || mine.has(row.id)).map(toRecord);
    return { records, insertedIds, evictedIds, archivedIds: [...archiveIds].filter((id) => pending.some((item) => item.id === id)), supersededIds, expiredIds, corroboratedIds: corroborate, heldIds, duplicateIds: door.duplicateIds };
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
export type SearchOptions = { /** M7: umbrella project — bare scopes are not project-wide. */ umbrella?: boolean; now?: number; includeObserved?: boolean;
  /**
   * The reader's sections, outermost first. Omitted means the project root only (`[]`): a working reader that forgot
   * its chain does not see every section. `allSections` is the named admin search.
   */
  chain?: readonly string[];
  allSections?: boolean;
  /** Also read the archive: notes the budget moved off the shelf (`ARCHIVE_SQL`). They are searchable, never injected; the PM search and explicit queries ask for them, a brief does not. */
  includeArchive?: boolean;
  /** `bridge`: the word layer is the base and the vectors add only notes in another language than the question (`language.ts`); `all` (unset): vectors rank every note, as before. */
  vectorMode?: "bridge" | "all";
  /** The door lock (`door-lock.ts`): with `literal` or `translated` a question the word layer left closed gets an empty list, whatever the vectors say. Unset reads as `off`. */
  doorLock?: DoorLock; /** `memory.scope` (`section-boost.ts`): unset reads as `section`; `project` ignores section scopes for visibility and only ranks the asking section's notes up. */ scopeMode?: MemoryScopeMode };

/** The archive: a note the note budget moved off the shelf. Not deleted and not hidden from search, only not injected. Its word indexes and vector stay. */
const ARCHIVE_SQL = "status='expired' AND expired_reason IN ('budget','duplicate')";

/** The scope values a reader with this chain sees: the whole project and every prefix of its chain. */
export function scopeValuesFor(chain: readonly string[]): string[] {
  // Pre-M7 rows keep the old meaning of a bare scope — project-wide in every project (legacyScope marks them).
  // Records written since M7 carry a section, "project:<reason>" or "unassigned" — none of which matches "[]".
  return Array.from({ length: chain.length + 1 }, (_, length) => JSON.stringify(chain.slice(0, length)));
}

/** M7: a project whose runs or records already use section chains is an umbrella; `memory.project_kind` overrides. */
export function projectUsesSections(db: MemoryDatabase, projectId: string, hasScopedRun: (db: MemoryDatabase, projectId: string) => boolean): boolean {
  // Runs are the signal, not stored rows: one scoped note must not flip the project's kind.
  try { return hasScopedRun(db, projectId); } catch { return false; }
}
const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

function visibility(db: MemoryDatabase, alias: string, options: SearchOptions): string {
  const now = Math.floor(options.now ?? Date.now());
  // A note of a held conflict (two notes that disagree, waiting for a person) is read by nobody: `conflict-store.ts`.
  const archive = options.includeArchive ? ` OR (${alias}.status='expired' AND ${alias}.expired_reason IN ('budget','duplicate'))` : "";
  // The idle rule retires an active note; an archived one is old by definition and stays searchable.
  return `(${alias}.status='active'${archive}) AND (${alias}.valid_from IS NULL OR ${alias}.valid_from<=${now}) AND (${alias}.valid_until IS NULL OR ${alias}.valid_until>${now}) AND (${alias}.status<>'active' OR NOT (${idleSql(alias, now)}))`
    + (options.includeObserved ? "" : ` AND (${alias}.trust='confirmed' OR ${alias}.created_at<=${now - OBSERVED_QUARANTINE_MS})`) + heldClause(db, alias)
    + (options.allSections || options.scopeMode === "project" ? "" : ` AND (${alias}.scope_json IN (${scopeValuesFor(options.chain ?? []).map(sqlString).join(",")}) OR ${alias}.scope_json LIKE '%"project%')`);
}

/** The visibility clause working readers share. A missing chain is the project root, not every section. */
export function memoryVisibilitySql(db: MemoryDatabase, alias: string, options: SearchOptions = {}): string {
  return visibility(db, alias, options);
}

const archiveIndexed = new WeakSet<object>();
/**
 * Notes the budget archived before the archive was searchable lost their word indexes. Once per process, the first search that reads the archive
 * puts back what an index lacks (a note archived since keeps its rows, so this finds nothing to do).
 */
function indexArchive(db: MemoryDatabase): void {
  if (archiveIndexed.has(db)) return;
  archiveIndexed.add(db);
  try {
    const rows = db.prepare(`SELECT id, project_id, content, concepts_json FROM lane_pilot_memory WHERE ${ARCHIVE_SQL}`).all() as Array<{ id: string; project_id: string; content: string; concepts_json: string }>;
    if (!rows.length) return;
    const fts = indexIds(db, "lane_pilot_memory_fts");
    const trgm = trigramReady(db) ? indexIds(db, "lane_pilot_memory_trgm") : null;
    db.transaction(() => {
      for (const row of rows) {
        const concepts = parseConcepts(row.concepts_json).join(" ");
        if (!fts.has(row.id)) db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES(?,?,?,?)").run(row.id, row.project_id, row.content, concepts);
        if (trgm && !trgm.has(row.id)) db.prepare("INSERT INTO lane_pilot_memory_trgm(id,project_id,content,concepts) VALUES(?,?,?,?)").run(row.id, row.project_id, row.content, concepts);
      }
    })();
  } catch { /* the archive stays unsearched by words; the next process tries again */ }
}
const parseConcepts = (json: string): string[] => { try { const value = JSON.parse(json) as unknown; return Array.isArray(value) ? value.map(String) : []; } catch { return []; } };

/**
 * The versions a newer record replaced, for a history query: after each found record come the records it replaced (and those they replaced),
 * each carrying `supersededAt`, the day its successor began to hold. A replaced version is never found by a search of its own: it is not indexed, so a question that is not about the past never meets it.
 */
export function withHistory(db: MemoryDatabase, projectId: string, records: readonly MemoryRecord[]): MemoryRecord[] {
  const older = db.prepare(`SELECT ${cols()} FROM lane_pilot_memory WHERE project_id=? AND superseded_by=? AND status='superseded' ORDER BY created_at DESC`);
  const out: MemoryRecord[] = [], seen = new Set<string>();
  const add = (record: MemoryRecord, depth: number) => {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    out.push(record);
    if (depth >= 5) return;
    const began = record.validFrom ?? record.createdAt;
    for (const row of older.all(projectId, record.id) as Row[]) add({ ...toRecord(row), supersededAt: began }, depth + 1);
  };
  for (const record of records) add(record, 0);
  return out;
}

/** Admin search: every section of the project. Working readers use `searchMemoryRecords` and pass their chain. */
export function searchMemoryAllSections(db: MemoryDatabase, projectId: string, query: string, limit: number, engine: MemorySearchEngine, audience: MemoryAudience = "subagent", personalBot = "", options: Omit<SearchOptions, "allSections" | "chain"> = {}): MemoryRecord[] {
  return searchMemoryRecords(db, projectId, query, limit, engine, audience, personalBot, { ...options, allSections: true });
}

export function searchMemoryRecords(db: MemoryDatabase, projectId: string, query: string, limit: number, engine: MemorySearchEngine, audience: MemoryAudience = "subagent", personalBot = "", options: SearchOptions = {}): MemoryRecord[] {
  if (options.includeArchive) indexArchive(db);
  const tokens = [...new Set(memoryTokens(query))].slice(0, 32);
  if (tokens.length === 0 || limit <= 0) return [];
  let rows: Row[];
  if (engine !== "bm25") {
    const lock = options.doorLock ?? "off";
    const searchTokens = lock === "translated" ? [...new Set(memoryTokens(lockQueryText(query, lock)))].slice(0, 32) : tokens;
    rows = wordRows(db, projectId, searchTokens, audience, personalBot, options, limit);
    if (lock !== "off" && !doorOpens(db, projectId, query, lock, rows.length, audience, personalBot)) return [];
    const dense = options.vectorMode === "bridge" ? bridgeRows(db, projectId, query, audience, personalBot, options, rows, limit) : denseRows(db, projectId, query, audience, personalBot, options, rows);
    if (dense) rows = dense.slice(0, limit);
  } else {
    const all = db.prepare(`SELECT ${cols("m.")} FROM lane_pilot_memory m WHERE m.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility(db, "m", options)}`).all(projectId, audience, personalBot) as Row[];
    const score = (text: string) => tokens.reduce((sum, token) => sum + (text.toLowerCase().split(token).length - 1), 0);
    rows = all.map((row) => ({ ...row, _score: score(`${row.content} ${row.concepts_json}`) })).filter((row) => row._score > 0).sort((a, b) => b._score - a._score || b.created_at - a.created_at).slice(0, limit);
  }
  const boosted = boostAskingSection(db, projectId, rows, options.scopeMode, scopeValuesFor(options.chain ?? []).slice(1)); rows = boosted.rows; const records = rows.map((row) => { const record = { ...toRecord(row), ...(boosted.own.has(row.id) ? { askingSection: true } : {}) }; const { similarity, bestChunk } = row as Row & { similarity?: number; bestChunk?: number }; return { ...record, ...(similarity === undefined ? {} : { similarity }), ...(bestChunk === undefined ? {} : { bestChunk }) }; });
  // M7 receipt: a pre-M7 root row delivered inside an umbrella reads with the legacy_scope flag.
  if (options.umbrella) rows.forEach((row, index) => { if (!parseScopeJson((row as Row & { scope_json: string | null }).scope_json).length) (records[index] as MemoryRecord & { legacyScope?: boolean }).legacyScope = true; });
  return options.includeArchive ? withoutShadowedDuplicates(db, projectId, records) : records;
}

/**
 * The word layer: whole words (FTS5) and word forms (trigram), fused by rank, each row carrying the BM25 score of the whole-word hit (`_bm25`, lower is
 * better in SQLite; `wordCandidates` turns it into a score where higher is better). The base of the search under `vector_mode = bridge`.
 */
function wordRows(db: MemoryDatabase, projectId: string, tokens: string[], audience: MemoryAudience, personalBot: string, options: SearchOptions, limit: number): Array<Row & { _bm25?: number }> {
  if (!tokens.length) return [];
  const match = tokens.map((word) => `"${word.replaceAll('"', "")}"`).join(" OR ");
  const words = db.prepare(`SELECT ${cols("m.")}, bm25(lane_pilot_memory_fts) AS _bm25
    FROM lane_pilot_memory_fts f JOIN lane_pilot_memory m ON m.id=f.id AND m.project_id=f.project_id
    WHERE lane_pilot_memory_fts MATCH ? AND f.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility(db, "m", options)}
    ORDER BY bm25(lane_pilot_memory_fts) LIMIT ?`).all(match, projectId, audience, personalBot, limit) as Array<Row & { _bm25?: number }>;
  // Word forms and substrings the whole-word index misses: the trigram index, or a scan where SQLite has none.
  const stems = [...new Set(tokens.map(memoryStem))];
  const parts = trigramReady(db)
    ? db.prepare(`SELECT ${cols("m.")}
      FROM lane_pilot_memory_trgm t JOIN lane_pilot_memory m ON m.id=t.id AND m.project_id=t.project_id
      WHERE lane_pilot_memory_trgm MATCH ? AND t.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility(db, "m", options)}
      ORDER BY bm25(lane_pilot_memory_trgm) LIMIT ?`).all(stems.map((stem) => `"${stem.replaceAll('"', "")}"`).join(" OR "), projectId, audience, personalBot, limit) as Row[]
    : scanRows(db, projectId, audience, personalBot, stems, options, limit);
  const bm25 = new Map(words.map((row) => [row.id, row._bm25]));
  return fuse([words, parts], limit).map((row) => bm25.has(row.id) ? { ...row, _bm25: bm25.get(row.id)! } : row);
}

/**
 * The candidates of the word layer alone, best first, each with a score where higher is better (the BM25 of its whole-word hit; a note only the
 * trigram index found scores 0). No vectors, no lock: this is the layer `vector_mode = bridge` builds on, and what answers when no embedding is available.
 */
export function wordCandidates(db: MemoryDatabase, projectId: string, query: string, limit: number, audience: MemoryAudience = "subagent", personalBot = "", options: SearchOptions = {}): Array<{ record: MemoryRecord; score: number }> {
  if (options.includeArchive) indexArchive(db);
  const tokens = [...new Set(memoryTokens(query))].slice(0, 32);
  if (!tokens.length || limit <= 0) return [];
  return wordRows(db, projectId, tokens, audience, personalBot, options, limit).map((row) => ({ record: toRecord(row), score: row._bm25 === undefined ? 0 : -row._bm25 }));
}

/**
 * The vector bridge: the word layer's rows stay the base; the vectors add only the notes in another language than the question (the words cannot
 * reach them), the best `BRIDGE_TOP` of those, fused with the words by rank. A path written in the question still comes first. No question
 * vector or no project vectors: null, and the caller keeps the word rows.
 */
export const BRIDGE_TOP = 10;
function bridgeRows(db: MemoryDatabase, projectId: string, query: string, audience: MemoryAudience, personalBot: string, options: SearchOptions, wordList: Row[], limit: number): Array<Row & { similarity?: number; bestChunk?: number }> | null {
  const vector = queryVectorFor(query);
  const ranked = vector ? denseRank(db, projectId, vector) : null;
  if (!ranked) return null;
  const visible = new Map((db.prepare(`SELECT ${cols("m.")} FROM lane_pilot_memory m WHERE m.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility(db, "m", options)}`)
    .all(projectId, audience, personalBot) as Row[]).map((row) => [row.id, row]));
  const asked = languageOf(query);
  const across: Array<Row & { similarity: number; bestChunk?: number }> = [];
  for (const item of ranked) {
    const row = visible.get(item.id);
    if (!row || !crossesLanguage(asked, languageOf(row.content))) continue;
    across.push({ ...row, similarity: item.similarity, ...(item.chunk !== undefined ? { bestChunk: item.chunk } : {}) });
    if (across.length >= BRIDGE_TOP) break;
  }
  const anchors = pathAnchorsOf(query);
  const anchored = anchors.length ? wordList.filter((row) => anchors.some((anchor) => row.content.includes(anchor))) : [];
  const out: Array<Row & { similarity?: number; bestChunk?: number }> = [], seen = new Set<string>();
  for (const row of anchored) { seen.add(row.id); out.push(row); }
  for (const row of fuse([wordList, across], limit * 2)) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(across.find((item) => item.id === row.id) ?? row);
  }
  return out;
}

/**
 * The meaning ranking (`vectors.ts`) when the caller embedded the question and the project has vectors: visible records by cosine,
 * each carrying its `similarity` for the floor. Words only add the records that name a path written in the question, first — an exact
 * path is the one thing a word match knows better. A record with no vector yet is not lost: the word hits follow the ranked ones.
 */
function denseRows(db: MemoryDatabase, projectId: string, query: string, audience: MemoryAudience, personalBot: string, options: SearchOptions, wordRows: Row[]): Array<Row & { similarity?: number; bestChunk?: number }> | null {
  const vector = queryVectorFor(query);
  const ranked = vector ? denseRank(db, projectId, vector) : null;
  if (!ranked) return null;
  const visible = new Map((db.prepare(`SELECT ${cols("m.")} FROM lane_pilot_memory m WHERE m.project_id=? AND m.audience=? AND m.personal_bot=? AND ${visibility(db, "m", options)}`)
    .all(projectId, audience, personalBot) as Row[]).map((row) => [row.id, row]));
  const similarity = new Map(ranked.map((item) => [item.id, item.similarity]));
  const chunkOf = new Map(ranked.filter((item) => item.chunk !== undefined).map((item) => [item.id, item.chunk!]));
  const anchors = pathAnchorsOf(query);
  const anchored = anchors.length ? wordRows.filter((row) => anchors.some((anchor) => row.content.includes(anchor))) : [];
  const out: Array<Row & { similarity?: number; bestChunk?: number }> = [], seen = new Set<string>();
  const add = (row: Row | undefined) => { if (row && !seen.has(row.id)) { seen.add(row.id); out.push({ ...row, ...(similarity.has(row.id) ? { similarity: similarity.get(row.id)! } : {}), ...(chunkOf.has(row.id) ? { bestChunk: chunkOf.get(row.id)! } : {}) }); } };
  anchored.forEach(add);
  for (const item of ranked) add(visible.get(item.id));
  wordRows.filter((row) => !similarity.has(row.id)).forEach(add);
  return out;
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

// ---- foreign-SQL reads moved home from the rooms (same SQL text, named) ----

/** Fill of every project's memory shelf, by kind (the learning housekeeping's budget report). */
export function memoryFillRows(db: Database.Database): Array<{ projectId: string; kind: string; n: number; bytes: number | null; used: number | null }> {
  return db.prepare(`SELECT project_id AS projectId, kind, count(*) AS n, sum(length(CAST(content AS BLOB))) AS bytes, sum(CASE WHEN use_count>0 THEN 1 ELSE 0 END) AS used
    FROM lane_pilot_memory WHERE status='active' GROUP BY project_id, kind`).all() as Array<{ projectId: string; kind: string; n: number; bytes: number | null; used: number | null }>;
}

/** Active memory records of one origin across every project (the hub-wide lessons query, SMA k_t_learnings). */
export function listMemoryByOrigin(db: Database.Database, origin: string, text?: string, limit = 50): Array<{ id: string; projectId: string; content: string; createdAt: number }> {
  const rows = db.prepare(`SELECT id, project_id, content, created_at FROM lane_pilot_memory WHERE origin=? AND status='active' ORDER BY created_at DESC LIMIT 500`).all(origin) as Array<{ id: string; project_id: string; content: string; created_at: number }>;
  const needle = text?.trim().toLowerCase();
  return rows.filter((row) => !needle || row.content.toLowerCase().includes(needle)).slice(0, limit)
    .map((row) => ({ id: row.id, projectId: row.project_id, content: row.content, createdAt: row.created_at }));
}

/** Hidden memory rows of every project, by status (the same report's shadow count). */
export function memoryHiddenRows(db: Database.Database): Array<{ projectId: string; status: string; n: number }> {
  return db.prepare("SELECT project_id AS projectId, status, count(*) AS n FROM lane_pilot_memory WHERE status<>'active' GROUP BY project_id, status").all() as Array<{ projectId: string; status: string; n: number }>;
}

/** The oldest maintainer core record no one accepted yet and that is not a rule (the insights' unused-convention pick). */
export function firstUnusedCoreRecordId(db: Database.Database, projectId: string): string | null {
  return (db.prepare(`SELECT id FROM lane_pilot_memory WHERE project_id=? AND kind='core' AND status='active' AND origin='maintainer'
    AND accepted_count=0 AND concepts_json NOT LIKE '%"rule"%' ORDER BY created_at, id LIMIT 1`).get(projectId) as { id: string } | undefined)?.id ?? null;
}

const hasTable = (db: MemoryDatabase, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name));

/**
 * Removes a record and its bytes everywhere: the row, both word indexes, its embedding, the promotion and
 * conflict rows that name it (SMA k_lib_erase). `eraseLeftovers` verifies nothing is left; callers report what it returns.
 * A conflict row quotes both notes, so it goes with the record, and the surviving note is no longer held by it. A held pair may
 * have opened a deferral entry: its ids are returned so the caller (the conflict service) closes them and none stays open.
 */
export function deleteMemoryRecord(db: Database.Database, projectId: string, id: string): string[] {
  // secure_delete is a setting of the shared connection: put back what it was.
  const before = (db.prepare("PRAGMA secure_delete").get() as { secure_delete: number } | undefined)?.secure_delete ?? 0;
  db.prepare("PRAGMA secure_delete=ON").get();
  try {
    let orphaned: string[] = [];
    if (hasTable(db, "lane_pilot_memory_conflict")) orphaned = (db.prepare("SELECT deferral_id FROM lane_pilot_memory_conflict WHERE project_id=? AND state='held' AND deferral_id IS NOT NULL AND (note_a=? OR note_b=?)")
      .all(projectId, id, id) as Array<{ deferral_id: string }>).map((row) => row.deferral_id);
    dropMemoryIndexes(db, projectId, id);
    if (hasTable(db, "lane_pilot_memory_vec")) db.prepare("DELETE FROM lane_pilot_memory_vec WHERE project_id=? AND id=?").run(projectId, id);
    if (hasTable(db, "lane_pilot_memory_vec_chunk")) db.prepare("DELETE FROM lane_pilot_memory_vec_chunk WHERE project_id=? AND id=?").run(projectId, id);
    if (hasTable(db, "lane_pilot_memory_promotion")) db.prepare("DELETE FROM lane_pilot_memory_promotion WHERE project_id=? AND memory_id=?").run(projectId, id);
    if (hasTable(db, "lane_pilot_memory_conflict")) db.prepare("DELETE FROM lane_pilot_memory_conflict WHERE project_id=? AND (note_a=? OR note_b=?)").run(projectId, id, id);
    db.prepare("DELETE FROM lane_pilot_memory WHERE project_id=? AND id=?").run(projectId, id);
    return orphaned;
  } finally { db.prepare(`PRAGMA secure_delete=${Math.trunc(before)}`).get(); }
}

/** The tables that still hold the id (or its embedding) after an erase; empty means the record is gone everywhere. */
export function eraseLeftovers(db: MemoryDatabase, projectId: string, id: string): string[] {
  const left: string[] = [];
  const holds = (table: string, where: string, args: unknown[]) => {
    if (!hasTable(db, table)) return;
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get(...args)) left.push(table);
  };
  holds("lane_pilot_memory", "project_id=? AND id=?", [projectId, id]);
  holds("lane_pilot_memory_fts", "project_id=? AND id=?", [projectId, id]);
  holds("lane_pilot_memory_trgm", "project_id=? AND id=?", [projectId, id]);
  holds("lane_pilot_memory_vec", "project_id=? AND id=?", [projectId, id]);
  holds("lane_pilot_memory_vec_chunk", "project_id=? AND id=?", [projectId, id]);
  holds("lane_pilot_memory_promotion", "project_id=? AND memory_id=?", [projectId, id]);
  holds("lane_pilot_memory_conflict", "project_id=? AND (note_a=? OR note_b=?)", [projectId, id, id]);
  return left;
}

/** Active records of a project, newest first (the records tab's list). */
export function listActiveMemoryRows(db: Database.Database, projectId: string, limit: number): Array<{
  id: string; kind: "core" | "note"; audience: string; content: string; concepts_json: string; created_at: number;
  use_count: number; accepted_count: number; origin_task_id: string | null; source_file_id: string | null; origin: string; scope_json: string | null; sources: number;
}> {
  return db.prepare("SELECT id, kind, audience, content, concepts_json, created_at, use_count, accepted_count, origin_task_id, source_file_id, origin, scope_json, json_array_length(COALESCE(verification_json,'[]')) AS sources FROM lane_pilot_memory WHERE project_id=? AND status='active' ORDER BY created_at DESC LIMIT ?")
    .all(projectId, limit) as Array<{ id: string; kind: "core" | "note"; audience: string; content: string; concepts_json: string; created_at: number; use_count: number; accepted_count: number; origin_task_id: string | null; source_file_id: string | null; origin: string; scope_json: string | null; sources: number }>;
}

/** A record's concepts_json (the delete guard reads it for the rule tag). */
export function memoryConceptsJson(db: Database.Database, projectId: string, id: string): string | null {
  return (db.prepare("SELECT concepts_json FROM lane_pilot_memory WHERE project_id=? AND id=?").get(projectId, id) as { concepts_json: string } | undefined)?.concepts_json ?? null;
}

/* --- tier / eval / probe readers -------------------------------------------------
 * Rooms that rank, seed and probe memory cannot all import each other; the table's
 * engine lives in this package, so the SQL they share sits here. */

/** Idle-expired note rows for one project's cold-tier read (memory-tiers). An owner-archived note is cold too: a PM query can bring it back. */
const COLD_TIER = "status='expired' AND kind='note' AND valid_until IS NULL AND superseded_by IS NULL AND (expired_reason IN ('idle','archived') OR expired_reason IS NULL)";

export function coldMemoryRows(db: MemoryDatabase, input: { projectId: string; audience: MemoryAudience; personalBot: string; chain: readonly string[]; includeObserved: boolean; now: number; scopeMode?: MemoryScopeMode }): Array<{ id: string; content: string; concepts_json: string }> {
  return db.prepare(`SELECT id, content, concepts_json FROM lane_pilot_memory WHERE project_id=? AND audience=? AND personal_bot=? AND ${COLD_TIER}${input.scopeMode === "project" ? "" : ` AND scope_json IN (${scopeValuesFor(input.chain).map(sqlString).join(",")})`}${input.includeObserved ? "" : ` AND (trust='confirmed' OR created_at<=${Math.floor(input.now) - OBSERVED_QUARANTINE_MS})`}${heldClause(db, "lane_pilot_memory")}`)
    .all(input.projectId, input.audience, input.personalBot) as Array<{ id: string; content: string; concepts_json: string }>;
}

/** Re-activates one cold-tier note; true when the row was still cold. */
export function reactivateColdMemory(db: MemoryDatabase, projectId: string, id: string, now: number): boolean {
  return db.prepare(`UPDATE lane_pilot_memory SET status='active', last_used_at=? WHERE project_id=? AND id=? AND ${COLD_TIER}`).run(now, projectId, id).changes === 1;
}

/** The promotion row a re-activation leaves (memory-tiers). */
export function recordMemoryPromotion(db: MemoryDatabase, projectId: string, memoryId: string, query: string, now: number): void {
  db.prepare("INSERT OR IGNORE INTO lane_pilot_memory_promotion(project_id,memory_id,query,at) VALUES (?,?,?,?)").run(projectId, memoryId, query.slice(0, 500), now);
}

/** Notes a promotion re-activated that stayed idle past the window (the demote sweep). */
export function listIdlePromotions(db: MemoryDatabase, beforeMs: number): Array<{ id: string; projectId: string }> {
  return db.prepare(`SELECT m.id, m.project_id AS projectId FROM lane_pilot_memory m JOIN lane_pilot_memory_promotion p ON p.memory_id=m.id AND p.project_id=m.project_id
    WHERE m.status='active' AND m.last_used_at=p.at AND p.at<?`).all(beforeMs) as Array<{ id: string; projectId: string }>;
}

/** Expires a still-active note as idle (the demote sweep's write). */
export function expireIdleMemory(db: MemoryDatabase, id: string): void {
  db.prepare("UPDATE lane_pilot_memory SET status='expired', expired_reason='idle' WHERE id=? AND status='active'").run(id);
}

/** Cold-tier size, optionally one project (the tier report). */
export function countColdMemories(db: MemoryDatabase, projectId?: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM lane_pilot_memory WHERE ${COLD_TIER} ${projectId ? "AND project_id=?" : ""}`).get(...(projectId ? [projectId] : [])) as { n: number }).n;
}

/** Distinct promoted notes, optionally one project (the tier report). */
export function countMemoryPromotions(db: MemoryDatabase, projectId?: string): number {
  return (db.prepare(`SELECT count(DISTINCT project_id||memory_id) AS n FROM lane_pilot_memory_promotion WHERE 1=1 ${projectId ? "AND project_id=?" : ""}`).get(...(projectId ? [projectId] : [])) as { n: number }).n;
}

/** Latest misses since a time, newest first (the tier report pages at 50; the self-improve curriculum reads the whole window). */
export function listMemoryMisses(db: Pick<Database.Database, "prepare">, sinceMs: number, projectId?: string, limit = 50): Array<{ projectId: string; query: string; at: number }> {
  const args: unknown[] = [sinceMs];
  let sql = "SELECT project_id AS projectId, query, at FROM lane_pilot_memory_miss WHERE at>=?";
  if (projectId) { sql += " AND project_id=?"; args.push(projectId); }
  sql += " ORDER BY at DESC LIMIT ?";
  args.push(limit);
  return db.prepare(sql).all(...args) as Array<{ projectId: string; query: string; at: number }>;
}

export * from "./store-eval";
/** kind/content/concepts of a project's active notes, most-accepted first (the cockpit memory card), with the trace columns the lint reads. */
export function activeMemoryDigestRows(db: MemoryDatabase, projectId: string): Array<{ id: string; kind: string; content: string; concepts_json: string; origin_task_id: string | null; source_file_id: string | null }> {
  return db.prepare("SELECT id, kind, content, concepts_json, origin_task_id, source_file_id FROM lane_pilot_memory WHERE project_id=? AND status='active' ORDER BY accepted_count DESC, created_at DESC LIMIT 80").all(projectId) as
    Array<{ id: string; kind: string; content: string; concepts_json: string; origin_task_id: string | null; source_file_id: string | null }>;
}

/** Whether a memory record exists in a project (the rule proposal's join guard). */
export function memoryRecordExists(db: MemoryDatabase, projectId: string, memoryId: string): boolean {
  return db.prepare("SELECT 1 FROM lane_pilot_memory WHERE project_id=? AND id=? LIMIT 1").get(projectId, memoryId) !== undefined;
}

// ---- index operator verbs (SMA d_mem_index / k_v_mem_index / k_v_build_index) ----

const indexIds = (db: MemoryDatabase, table: string, projectId?: string): Set<string> =>
  new Set((db.prepare(`SELECT id FROM ${table}${projectId ? " WHERE project_id=?" : ""}`).all(...(projectId ? [projectId] : [])) as Array<{ id: string }>).map((row) => row.id));

const activeRowsForIndex = (db: MemoryDatabase, projectId?: string): Array<{ id: string; project_id: string; content: string; concepts_json: string }> =>
  db.prepare(`SELECT id, project_id, content, concepts_json FROM lane_pilot_memory WHERE (status='active' OR (${ARCHIVE_SQL}))${projectId ? " AND project_id=?" : ""}`)
    .all(...(projectId ? [projectId] : [])) as Array<{ id: string; project_id: string; content: string; concepts_json: string }>;

/**
 * Drift between the indexed records (active and archived) and the derived word indexes (fts, trigram, vectors): `missing` are ids an
 * index lost (a failed write, a hand edit), `orphaned` are ids an index still serves though the record is hidden or gone.
 */
export function memoryIndexStatus(db: MemoryDatabase, projectId?: string): {
  active: number; fts: number; trgm: number | null; vec: number | null;
  missingIds: string[]; orphanedIds: string[];
} {
  const rows = activeRowsForIndex(db, projectId);
  const active = new Set(rows.map((row) => row.id));
  const fts = indexIds(db, "lane_pilot_memory_fts", projectId);
  const missingIds: string[] = [], orphanedIds: string[] = [];
  for (const id of active) if (!fts.has(id)) missingIds.push(id);
  for (const id of fts) if (!active.has(id)) orphanedIds.push(id);
  const trgm = trigramReady(db) ? indexIds(db, "lane_pilot_memory_trgm", projectId).size : null;
  const vec = hasTable(db, "lane_pilot_memory_vec")
    ? (db.prepare(`SELECT count(*) AS n FROM lane_pilot_memory_vec${projectId ? " WHERE project_id=?" : ""}`).get(...(projectId ? [projectId] : [])) as { n: number }).n
    : null;
  return { active: rows.length, fts: fts.size, trgm, vec, missingIds: missingIds.sort(), orphanedIds: orphanedIds.sort() };
}

/**
 * Rebuilds the derived word indexes from the active records in one transaction: the project's fts and trigram rows are
 * dropped and every active or archived record goes back through `addToIndexes`. `check` only counts the drift. Returns how many
 * index rows were missing (`added`) and how many stale ones were removed (`stale`).
 */
export function rebuildMemoryIndexes(db: MemoryDatabase, projectId?: string, options: { check?: boolean } = {}): { active: number; added: number; stale: number } {
  const status = memoryIndexStatus(db, projectId);
  const counts = { active: status.active, added: status.missingIds.length, stale: status.orphanedIds.length };
  if (options.check || (!status.missingIds.length && !status.orphanedIds.length)) return counts;
  db.transaction(() => {
    db.prepare(`DELETE FROM lane_pilot_memory_fts${projectId ? " WHERE project_id=?" : ""}`).run(...(projectId ? [projectId] : []));
    if (trigramReady(db)) db.prepare(`DELETE FROM lane_pilot_memory_trgm${projectId ? " WHERE project_id=?" : ""}`).run(...(projectId ? [projectId] : []));
    for (const row of activeRowsForIndex(db, projectId)) {
      let concepts: string[] = [];
      try { concepts = JSON.parse(row.concepts_json) as string[]; } catch { /* indexed without tags */ }
      addToIndexes(db, row.project_id, row.id, row.content, concepts);
    }
  })();
  return counts;
}

/**
 * Active records with no trace back to the pipeline (SMA d_mem_lint): no task they came from, no file, no voucher,
 * and not written by the owner or an import (those legitimately have none). The one definition: lint, the cockpit and
 * the records badge all use it. Without a project it covers every project.
 */
export function memoryWithoutTrace(db: MemoryDatabase, projectId?: string): Array<{ id: string; content: string }> {
  return db.prepare(`SELECT id, content FROM lane_pilot_memory WHERE status='active'${projectId ? " AND project_id=?" : ""}
    AND origin_task_id IS NULL AND source_file_id IS NULL
    AND (verification_json IS NULL OR verification_json='[]')
    AND COALESCE(origin,'') NOT IN ('owner','import')
    ORDER BY created_at, id`).all(...(projectId ? [projectId] : [])) as Array<{ id: string; content: string }>;
}

/** All active records of a project: the real total behind «N of M» (the digest read is capped at 80). */
export function countActiveMemory(db: MemoryDatabase, projectId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE project_id=? AND status='active'").get(projectId) as { n: number }).n;
}

/** One recorded miss, optionally an owner-reminded one tied to the record that held the answer (SMA k_v_mem_miss). */
export function recordMemoryMiss(db: MemoryDatabase, projectId: string, query: string, now: number, kind: "empty" | "reminded" = "empty", noteId?: string): void {
  const columns = hasTable(db, "lane_pilot_memory_miss") && db.prepare("PRAGMA table_info(lane_pilot_memory_miss)").all().some((row) => (row as { name: string }).name === "kind");
  if (columns) db.prepare("INSERT INTO lane_pilot_memory_miss(project_id,query,at,kind,note_id) VALUES (?,?,?,?,?)").run(projectId, query.slice(0, 1000), now, kind, noteId ?? null);
  else db.prepare("INSERT INTO lane_pilot_memory_miss(project_id,query,at) VALUES (?,?,?)").run(projectId, query.slice(0, 1000), now);
}

/** Misses with the new columns; empty rows on a database from before them. */
export function listRemindedMisses(db: MemoryDatabase, projectId?: string): Array<{ projectId: string; query: string; noteId: string }> {
  if (!hasTable(db, "lane_pilot_memory_miss")) return [];
  if (!db.prepare("PRAGMA table_info(lane_pilot_memory_miss)").all().some((row) => (row as { name: string }).name === "note_id")) return [];
  const sql = "SELECT project_id AS projectId, query, note_id AS noteId FROM lane_pilot_memory_miss WHERE kind='reminded' AND note_id IS NOT NULL";
  return db.prepare(projectId ? `${sql} AND project_id=?` : sql).all(...(projectId ? [projectId] : [])) as Array<{ projectId: string; query: string; noteId: string }>;
}

/** Token weight of the corpus against its budgets (SMA k_v_mem_stats): core, notes, the whole index, and the hidden rows by status. */
export function memoryTokenStats(db: MemoryDatabase, projectId: string, budgets: { coreBudget: number; noteBudget: number; indexBudget: number }): {
  coreTokens: number; noteTokens: number; indexTokens: number; budgets: { coreBudget: number; noteBudget: number; indexBudget: number };
  records: { active: number; hidden: Record<string, number> };
} {
  const rows = db.prepare("SELECT kind, status, content FROM lane_pilot_memory WHERE project_id=?").all(projectId) as Array<{ kind: string; status: string; content: string }>;
  let coreTokens = 0, noteTokens = 0;
  const hidden: Record<string, number> = {};
  for (const row of rows) {
    if (row.status !== "active") { hidden[row.status] = (hidden[row.status] ?? 0) + 1; continue; }
    if (row.kind === "core") coreTokens += estimate(row.content); else noteTokens += estimate(row.content);
  }
  const active = rows.filter((row) => row.status === "active").length;
  return { coreTokens, noteTokens, indexTokens: coreTokens + noteTokens, budgets, records: { active, hidden } };
}
