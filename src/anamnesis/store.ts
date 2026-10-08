import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_SOURCES, SOURCES, maxSensitivity, recordId, recordInputSchema, scrubQuote, sensitivityFloor, unsafeReason,
  type AnamnesisRecord, type AnamnesisRecordFull, type Evidence, type HistoryEntry, type Kind, type Sensitivity, type Source, type Status,
} from "./model";

/**
 * The anamnesis store (A1). A SQLite file on the owner's machine (the Mac mini), `~/.lane-pilot/anamnesis/anamnesis.db`, mode 0600 in
 * a 0700 folder; the hub never holds a copy. Opened by the host worker for each call.
 *
 * The evidence rules are the ones of the retired memory-profile plugin, kept in the store so that no writer can skip them:
 *  - an automatic change names evidence (a pointer with the original date), or it is not stored;
 *  - an owner edit or decision protects the record (`manual_at`): evidence that predates it cannot change it again;
 *  - forgetting leaves a cutoff, so the chats and commits that taught it cannot bring it back; only newer evidence can;
 *  - each source has a checkpoint, advanced by the caller after its batch is stored;
 *  - text that carries a credential or an instruction to a reader is not stored.
 */
export const anamnesisDir = (): string => process.env.LANE_PILOT_ANAMNESIS_DIR || join(homedir(), ".lane-pilot", "anamnesis");
export const anamnesisDbPath = (): string => join(anamnesisDir(), "anamnesis.db");

const KEEP_OLDEST_EVIDENCE = 40;
const KEEP_NEWEST_EVIDENCE = 100;

export type UpsertContext = { actor: string; reason: string; now?: number };
export type UpsertAction = "created" | "updated" | "unchanged" | "blocked" | "ignored" | "invalid";
export type UpsertResult = { id: string | null; action: UpsertAction; reason: string | null; newEvidence: number };

export type ListFilter = {
  kinds?: readonly Kind[]; statuses?: readonly Status[]; query?: string;
  /** Sensitive records are hidden unless the caller asks for them by name. */
  includeSensitive?: boolean; limit?: number; offset?: number;
};

export type EditPatch = { title?: string; statement?: string; attributes?: Record<string, unknown>; sensitivity?: Sensitivity; confidence?: number; status?: Status };

export type Counts = {
  records: number; evidence: number;
  byKind: Record<string, number>; byStatus: Record<string, number>; bySensitivity: Record<string, number>;
};

type Row = Record<string, unknown>;
const num = (value: unknown): number => Number(value ?? 0);
const json = (value: unknown): Record<string, unknown> => { try { const parsed = JSON.parse(String(value ?? "{}")) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, statement TEXT NOT NULL DEFAULT '', attributes TEXT NOT NULL DEFAULT '{}',
  sensitivity TEXT NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL, first_seen INTEGER, last_seen INTEGER,
  manual_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_kind ON records(kind, status);
CREATE TABLE IF NOT EXISTS evidence(
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, source TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, quote TEXT,
  PRIMARY KEY(record_id, source, ref));
CREATE INDEX IF NOT EXISTS evidence_source ON evidence(source);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS history_record ON history(record_id, id);
CREATE TABLE IF NOT EXISTS tombstones(id TEXT PRIMARY KEY, cutoff INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints(source TEXT PRIMARY KEY, at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sources(source TEXT PRIMARY KEY, enabled INTEGER NOT NULL, changed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS loads(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, mode TEXT NOT NULL, report TEXT NOT NULL);
`;

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string = anamnesisDbPath()) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(path), 0o700); } catch { /* a folder we do not own keeps its mode */ }
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);
  if (path !== ":memory:") for (const suffix of ["", "-wal", "-shm"]) { try { chmodSync(path + suffix, 0o600); } catch { /* not created yet */ } }

  const one = (sql: string, ...args: Array<string | number | null>): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;
  const all = (sql: string, ...args: Array<string | number | null>): Row[] => db.prepare(sql).all(...args) as Row[];
  const run = (sql: string, ...args: Array<string | number | null>): void => { db.prepare(sql).run(...args); };
  let depth = 0;
  /** One transaction; a call made inside another one joins it. */
  const tx = <T>(work: () => T): T => {
    if (depth > 0) return work();
    db.exec("BEGIN IMMEDIATE");
    depth = 1;
    try { const out = work(); db.exec("COMMIT"); return out; } catch (cause) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw cause; } finally { depth = 0; }
  };

  const toRecord = (row: Row): AnamnesisRecord => ({
    id: String(row.id), kind: row.kind as Kind, title: String(row.title), statement: String(row.statement), attributes: json(row.attributes),
    sensitivity: row.sensitivity as Sensitivity, confidence: num(row.confidence), status: row.status as Status,
    firstSeen: row.first_seen === null ? null : num(row.first_seen), lastSeen: row.last_seen === null ? null : num(row.last_seen),
    manualAt: num(row.manual_at), createdAt: num(row.created_at), updatedAt: num(row.updated_at), evidenceCount: num(row.evidence_count),
  });
  const SELECT = "SELECT r.*, (SELECT count(*) FROM evidence e WHERE e.record_id=r.id) AS evidence_count FROM records r";

  const sourceEnabled = (source: Source): boolean => {
    if (source === "manual") return true;
    const row = one("SELECT enabled FROM sources WHERE source=?", source);
    return row ? num(row.enabled) === 1 : DEFAULT_SOURCES[source];
  };
  const cutoffFor = (id: string): number => Math.max(num(one("SELECT cutoff FROM tombstones WHERE id='*'")?.cutoff), num(one("SELECT cutoff FROM tombstones WHERE id=?", id)?.cutoff));
  const log = (id: string, at: number, actor: string, action: string, reason: string, changes: Record<string, unknown>): void =>
    run("INSERT INTO history(record_id,at,actor,action,reason,changes) VALUES (?,?,?,?,?,?)", id, at, actor, action, reason.slice(0, 300), JSON.stringify(changes));

  function pruneEvidence(id: string): void {
    const total = num(one("SELECT count(*) AS n FROM evidence WHERE record_id=?", id)?.n);
    if (total <= KEEP_OLDEST_EVIDENCE + KEEP_NEWEST_EVIDENCE) return;
    run(`DELETE FROM evidence WHERE record_id=? AND rowid NOT IN (
      SELECT rowid FROM (SELECT rowid FROM evidence WHERE record_id=? ORDER BY at ASC LIMIT ${KEEP_OLDEST_EVIDENCE})
      UNION SELECT rowid FROM (SELECT rowid FROM evidence WHERE record_id=? ORDER BY at DESC LIMIT ${KEEP_NEWEST_EVIDENCE}))`, id, id, id);
  }

  function upsertOne(raw: unknown, ctx: UpsertContext): UpsertResult {
    const now = ctx.now ?? Date.now();
    const owner = ctx.actor === "owner";
    const parsed = recordInputSchema.safeParse(raw);
    if (!parsed.success) return { id: null, action: "invalid", reason: parsed.error.issues[0]?.message ?? "invalid record", newEvidence: 0 };
    const input = parsed.data;
    const id = recordId(input.kind, input.key);
    const bad = unsafeReason(input.title) ?? unsafeReason(input.statement);
    if (bad) return { id, action: "ignored", reason: `unsafe_text: ${bad}`, newEvidence: 0 };

    let evidence: Evidence[] = input.evidence.map((item) => ({ ...item, ...(item.quote ? { quote: scrubQuote(item.quote) } : {}) }));
    if (owner && !evidence.length) evidence = [{ source: "manual", ref: `owner:${now}`, at: now }];
    if (!evidence.length) return { id, action: "ignored", reason: "no_evidence", newEvidence: 0 };
    if (!owner) {
      evidence = evidence.filter((item) => sourceEnabled(item.source));
      if (!evidence.length) return { id, action: "ignored", reason: "source_off", newEvidence: 0 };
      const cutoff = cutoffFor(id);
      evidence = evidence.filter((item) => item.at > cutoff);
      if (!evidence.length) return { id, action: "ignored", reason: "before_forget_cutoff", newEvidence: 0 };
    }
    const newest = Math.max(...evidence.map((item) => item.at)), oldest = Math.min(...evidence.map((item) => item.at));
    const floor = sensitivityFloor({ kind: input.kind, title: input.title, statement: input.statement, attributes: input.attributes });
    const existing = one(`${SELECT} WHERE r.id=?`, id);

    if (!existing) {
      const sensitivity: Sensitivity = owner ? (input.sensitivity ?? floor) : maxSensitivity(input.sensitivity === "public" ? "private" : input.sensitivity, floor);
      const status: Status = owner ? "confirmed" : input.status ?? "draft";
      run("INSERT INTO records(id,kind,title,statement,attributes,sensitivity,confidence,status,first_seen,last_seen,manual_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, input.kind, input.title, input.statement, JSON.stringify(input.attributes), sensitivity, input.confidence, status,
        input.firstSeen ?? oldest, input.lastSeen ?? newest, owner ? now : 0, now, now);
      for (const item of evidence) run("INSERT OR IGNORE INTO evidence(record_id,source,ref,at,quote) VALUES (?,?,?,?,?)", id, item.source, item.ref, item.at, item.quote ?? null);
      pruneEvidence(id);
      log(id, now, ctx.actor, "create", ctx.reason, { title: input.title, sensitivity, status, evidence: evidence.length });
      return { id, action: "created", reason: null, newEvidence: evidence.length };
    }

    const current = toRecord(existing);
    if (!owner) {
      // The owner's word protects a record from evidence that came before it; a record the owner rejected stays rejected.
      if (current.status === "rejected") return { id, action: "blocked", reason: "rejected_by_owner", newEvidence: 0 };
      if (current.manualAt > 0 && newest <= current.manualAt) return { id, action: "blocked", reason: "predates_owner_edit", newEvidence: 0 };
    }
    const changes: Record<string, unknown> = {};
    let { title, statement, sensitivity, status } = current;
    const newer = owner || newest >= (current.lastSeen ?? 0);
    // Newer evidence of a statement the owner confirmed may change it, but the owner sees it again: it goes back to draft.
    if (input.statement && input.statement !== statement && newer) {
      changes.statement = [statement.slice(0, 120), input.statement.slice(0, 120)];
      statement = input.statement;
      if (!owner && status === "confirmed") status = "draft";
    }
    if (input.title !== title && newer) { changes.title = [title, input.title]; title = input.title; }
    // Words and automatic classifiers only raise sensitivity; the owner alone lowers it, and only the owner sets `public`.
    const raised = owner ? (input.sensitivity ?? current.sensitivity)
      : maxSensitivity(current.sensitivity, floor === "sensitive" ? "sensitive" : undefined, current.manualAt > 0 || input.sensitivity === "public" ? undefined : input.sensitivity);
    if (raised !== sensitivity) { changes.sensitivity = [sensitivity, raised]; sensitivity = raised; }
    if (!owner && current.status === "candidate" && input.status && input.status !== "candidate") { changes.status = ["candidate", input.status]; status = input.status; }
    const attributes = { ...current.attributes, ...input.attributes };
    const attributesChanged = JSON.stringify(attributes) !== JSON.stringify(current.attributes);
    const confidence = Math.max(current.confidence, input.confidence);
    const firstSeen = Math.min(current.firstSeen ?? Infinity, input.firstSeen ?? oldest);
    const lastSeen = Math.max(current.lastSeen ?? 0, input.lastSeen ?? newest);
    let added = 0;
    for (const item of evidence) {
      const before = num(one("SELECT count(*) AS n FROM evidence WHERE record_id=? AND source=? AND ref=?", id, item.source, item.ref)?.n);
      if (!before) { run("INSERT INTO evidence(record_id,source,ref,at,quote) VALUES (?,?,?,?,?)", id, item.source, item.ref, item.at, item.quote ?? null); added += 1; }
    }
    if (added) pruneEvidence(id);
    const dirty = Object.keys(changes).length > 0 || attributesChanged || confidence !== current.confidence || firstSeen !== current.firstSeen || lastSeen !== current.lastSeen || added > 0;
    if (!dirty) return { id, action: "unchanged", reason: null, newEvidence: 0 };
    run("UPDATE records SET title=?, statement=?, attributes=?, sensitivity=?, confidence=?, status=?, first_seen=?, last_seen=?, manual_at=?, updated_at=? WHERE id=?",
      title, statement, JSON.stringify(attributes), sensitivity, confidence, status, firstSeen, lastSeen, owner ? now : current.manualAt, now, id);
    // History keeps what a person would want to read back; counters that move on every pass are not a change.
    const meaningful = Object.keys(changes).length > 0;
    if (meaningful) log(id, now, ctx.actor, "update", ctx.reason, { ...changes, ...(added ? { evidence: added } : {}) });
    return { id, action: meaningful || added || attributesChanged ? "updated" : "unchanged", reason: null, newEvidence: added };
  }

  return {
    path,
    close: () => db.close(),
    transaction: tx,
    /** Runs `work` and rolls everything back: the plan of a load, counted by the same rules as the real write, changing nothing. */
    dryRun<T>(work: () => T): T {
      if (depth > 0) throw new Error("dryRun cannot join a transaction");
      db.exec("BEGIN IMMEDIATE");
      depth = 1;
      try { return work(); } finally { depth = 0; db.exec("ROLLBACK"); }
    },

    /** One record; a bad record is a result, never an exception, so one fragment cannot stop a batch. */
    upsert(raw: unknown, ctx: UpsertContext): UpsertResult {
      return tx(() => upsertOne(raw, ctx));
    },
    upsertMany(raws: readonly unknown[], ctx: UpsertContext): UpsertResult[] {
      return tx(() => raws.map((raw) => upsertOne(raw, ctx)));
    },

    get(id: string, options: { includeSensitive?: boolean } = {}): AnamnesisRecordFull | null {
      const row = one(`${SELECT} WHERE r.id=?`, id);
      if (!row) return null;
      const record = toRecord(row);
      if (record.sensitivity === "sensitive" && !options.includeSensitive) return null;
      const evidence = all("SELECT source, ref, at, quote FROM evidence WHERE record_id=? ORDER BY at", id)
        .map((item) => ({ source: item.source as Source, ref: String(item.ref), at: num(item.at), ...(item.quote ? { quote: String(item.quote) } : {}) }));
      return { ...record, evidence };
    },

    list(filter: ListFilter = {}): AnamnesisRecord[] {
      const where: string[] = [], args: Array<string | number | null> = [];
      if (filter.kinds?.length) { where.push(`r.kind IN (${filter.kinds.map(() => "?").join(",")})`); args.push(...filter.kinds); }
      if (filter.statuses?.length) { where.push(`r.status IN (${filter.statuses.map(() => "?").join(",")})`); args.push(...filter.statuses); }
      if (!filter.includeSensitive) where.push("r.sensitivity != 'sensitive'");
      if (filter.query) { where.push("(r.title LIKE ? ESCAPE '\\' OR r.statement LIKE ? ESCAPE '\\')"); const like = `%${filter.query.replace(/[\\%_]/g, "\\$&")}%`; args.push(like, like); }
      const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000), offset = Math.max(filter.offset ?? 0, 0);
      return all(`${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(r.last_seen, r.updated_at) DESC, r.id LIMIT ${limit} OFFSET ${offset}`, ...args).map(toRecord);
    },

    counts(): Counts {
      const group = (column: string) => Object.fromEntries(all(`SELECT ${column} AS k, count(*) AS n FROM records GROUP BY ${column}`).map((row) => [String(row.k), num(row.n)]));
      return { records: num(one("SELECT count(*) AS n FROM records")?.n), evidence: num(one("SELECT count(*) AS n FROM evidence")?.n),
        byKind: group("kind"), byStatus: group("status"), bySensitivity: group("sensitivity") };
    },

    /** The owner's edit or decision. It protects the record from older evidence and is kept in the history. */
    edit(id: string, patch: EditPatch, reason: string, now = Date.now()): AnamnesisRecordFull {
      return tx(() => {
        const row = one(`${SELECT} WHERE r.id=?`, id);
        if (!row) throw new Error(`no record ${id}`);
        const current = toRecord(row);
        for (const text of [patch.title, patch.statement]) { const bad = text ? unsafeReason(text) : null; if (bad) throw new Error(`The text carries ${bad}; write plain facts`); }
        const changes: Record<string, unknown> = {};
        const next = { title: current.title, statement: current.statement, sensitivity: current.sensitivity, confidence: current.confidence, status: current.status, attributes: current.attributes };
        if (patch.title !== undefined && patch.title !== current.title) { changes.title = [current.title, patch.title]; next.title = patch.title; }
        if (patch.statement !== undefined && patch.statement !== current.statement) { changes.statement = [current.statement.slice(0, 120), patch.statement.slice(0, 120)]; next.statement = patch.statement; }
        if (patch.sensitivity !== undefined && patch.sensitivity !== current.sensitivity) { changes.sensitivity = [current.sensitivity, patch.sensitivity]; next.sensitivity = patch.sensitivity; }
        if (patch.confidence !== undefined && patch.confidence !== current.confidence) { changes.confidence = [current.confidence, patch.confidence]; next.confidence = patch.confidence; }
        if (patch.status !== undefined && patch.status !== current.status) { changes.status = [current.status, patch.status]; next.status = patch.status; }
        if (patch.attributes) { next.attributes = { ...current.attributes, ...patch.attributes }; changes.attributes = Object.keys(patch.attributes); }
        run("UPDATE records SET title=?, statement=?, attributes=?, sensitivity=?, confidence=?, status=?, manual_at=?, updated_at=? WHERE id=?",
          next.title, next.statement, JSON.stringify(next.attributes), next.sensitivity, next.confidence, next.status, now, now, id);
        run("INSERT OR IGNORE INTO evidence(record_id,source,ref,at,quote) VALUES (?,?,?,?,NULL)", id, "manual", `edit:${now}`, now);
        log(id, now, "owner", Object.keys(changes).length === 1 && changes.status ? "status" : "edit", reason, changes);
        return readFull(id);
      });
    },

    history(id: string, limit = 50): HistoryEntry[] {
      return all("SELECT id, record_id, at, actor, action, reason, changes FROM history WHERE record_id=? ORDER BY id DESC LIMIT ?", id, Math.min(Math.max(limit, 1), 500))
        .map((row) => ({ id: num(row.id), recordId: String(row.record_id), at: num(row.at), actor: String(row.actor), action: String(row.action), reason: String(row.reason), changes: json(row.changes) }));
    },

    /** Removes one record with its evidence and history and keeps only a cutoff: older sources cannot bring it back. */
    forget(id: string, now = Date.now()): boolean {
      return tx(() => {
        const existed = !!one("SELECT 1 AS x FROM records WHERE id=?", id);
        run("DELETE FROM records WHERE id=?", id);
        run("DELETE FROM history WHERE record_id=?", id);
        run("INSERT INTO tombstones(id,cutoff) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET cutoff=excluded.cutoff", id, now);
        return existed;
      });
    },

    /** Everything goes, history and load reports with it; the checkpoints restart from the cutoff. */
    forgetAll(now = Date.now()): { removed: number } {
      return tx(() => {
        const removed = num(one("SELECT count(*) AS n FROM records")?.n);
        for (const table of ["evidence", "history", "records", "tombstones", "checkpoints", "loads"]) run(`DELETE FROM ${table}`);
        run("INSERT INTO tombstones(id,cutoff) VALUES ('*',?)", now);
        return { removed };
      });
    },

    /** Drops what one source taught and switches it off; records that only it supported are forgotten with a cutoff. */
    forgetSource(source: Source, now = Date.now()): { evidence: number; records: number } {
      return tx(() => {
        const evidence = num(one("SELECT count(*) AS n FROM evidence WHERE source=?", source)?.n);
        const orphans = all("SELECT record_id FROM evidence GROUP BY record_id HAVING sum(CASE WHEN source=? THEN 0 ELSE 1 END)=0 AND count(*)>0", source).map((row) => String(row.record_id));
        run("DELETE FROM evidence WHERE source=?", source);
        for (const id of orphans) {
          run("DELETE FROM records WHERE id=?", id); run("DELETE FROM history WHERE record_id=?", id);
          run("INSERT INTO tombstones(id,cutoff) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET cutoff=excluded.cutoff", id, now);
        }
        run("DELETE FROM checkpoints WHERE source=?", source);
        run("INSERT INTO sources(source,enabled,changed_at) VALUES (?,0,?) ON CONFLICT(source) DO UPDATE SET enabled=0, changed_at=excluded.changed_at", source, now);
        return { evidence, records: orphans.length };
      });
    },

    cutoff: (): number => num(one("SELECT cutoff FROM tombstones WHERE id='*'")?.cutoff),

    checkpoint(source: Source): { at: number; detail: Record<string, unknown> } | null {
      const row = one("SELECT at, detail FROM checkpoints WHERE source=?", source);
      return row ? { at: num(row.at), detail: json(row.detail) } : null;
    },
    /** Called after the batch of that window is stored: a failed pass leaves the window to be read again. */
    setCheckpoint(source: Source, at: number, detail: Record<string, unknown> = {}, now = Date.now()): void {
      run("INSERT INTO checkpoints(source,at,detail,updated_at) VALUES (?,?,?,?) ON CONFLICT(source) DO UPDATE SET at=excluded.at, detail=excluded.detail, updated_at=excluded.updated_at", source, at, JSON.stringify(detail), now);
    },

    sources(): Array<{ source: Exclude<Source, "manual">; enabled: boolean; checkpoint: number | null }> {
      return SOURCES.filter((source): source is Exclude<Source, "manual"> => source !== "manual").map((source) => ({ source, enabled: sourceEnabled(source), checkpoint: checkpointAt(source) }));
    },
    setSource(source: Source, enabled: boolean, now = Date.now()): void {
      if (source === "manual") throw new Error("manual cannot be switched off");
      run("INSERT INTO sources(source,enabled,changed_at) VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET enabled=excluded.enabled, changed_at=excluded.changed_at", source, enabled ? 1 : 0, now);
    },
    sourceEnabled,

    saveLoad(mode: string, report: unknown, now = Date.now()): number {
      run("INSERT INTO loads(at,mode,report) VALUES (?,?,?)", now, mode, JSON.stringify(report));
      run("DELETE FROM loads WHERE id NOT IN (SELECT id FROM loads ORDER BY id DESC LIMIT 20)");
      return num(one("SELECT max(id) AS id FROM loads")?.id);
    },
    loads(limit = 5): Array<{ id: number; at: number; mode: string; report: unknown }> {
      return all("SELECT id, at, mode, report FROM loads ORDER BY id DESC LIMIT ?", limit).map((row) => ({ id: num(row.id), at: num(row.at), mode: String(row.mode), report: JSON.parse(String(row.report)) as unknown }));
    },
  };

  function readFull(id: string): AnamnesisRecordFull {
    const row = one(`${SELECT} WHERE r.id=?`, id)!;
    const evidence = all("SELECT source, ref, at, quote FROM evidence WHERE record_id=? ORDER BY at", id)
      .map((item) => ({ source: item.source as Source, ref: String(item.ref), at: num(item.at), ...(item.quote ? { quote: String(item.quote) } : {}) }));
    return { ...toRecord(row), evidence };
  }
  function checkpointAt(source: Source): number | null {
    const row = one("SELECT at FROM checkpoints WHERE source=?", source);
    return row ? num(row.at) : null;
  }
}
