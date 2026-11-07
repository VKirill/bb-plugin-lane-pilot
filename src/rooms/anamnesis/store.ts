import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { parseJsonOr } from "@lane-pilot/kit";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { decryptOwnerField, encryptOwnerField, OwnerKeyError } from "./crypto";
import { infrastructureReason } from "./infra";
import {
  DEFAULT_SOURCES, SOURCES, maxSensitivity, recordId, recordInputSchema, scrubQuote, sensitivityFloor, unsafeReason,
  type AnamnesisRecord, type AnamnesisRecordFull, type Evidence, type HistoryEntry, type Kind, type Sensitivity, type Source, type Status,
} from "./model";

/**
 * The anamnesis store (A1, M1b). One implementation over a `DatabaseSync`-compatible handle: the Mac-mini file
 * (`~/.lane-pilot/anamnesis/anamnesis.db`, mode 0600 in a 0700 folder, opened by `openStore`) and the hub's plugin
 * base (`lane_pilot_owner_*` tables of `data.db`, opened by `openOwnerStore`). The hub serves every operation from
 * its own tables; the host keeps no store and only collects raw input and the one-off export for migration.
 *
 * The evidence rules are the ones of the retired memory-profile plugin, kept in the store so that no writer can skip them:
 *  - an automatic change names evidence (a pointer with the original date), or it is not stored;
 *  - an owner edit or decision protects the record (`manual_at`): evidence that predates it cannot change it again;
 *  - forgetting leaves a cutoff, so the chats and commits that taught it cannot bring it back; only newer evidence can;
 *  - each source has a checkpoint, advanced by the caller after its batch is stored;
 *  - text that carries a credential or an instruction to a reader is not stored.
 *
 * On the hub (`crypto` given) the free-text fields of a record whose sensitivity is `sensitive` — title, statement,
 * attributes, evidence quotes, history changes, note lines — are AES-256-GCM ciphertext (`v1:…`, see crypto.ts) under
 * `LP_OWNER_MEMORY_KEY` from Env Catalog. Without the key a sensitive record is refused (`owner_key_missing`), never
 * written in clear.
 */
export const anamnesisDir = (): string => process.env.LANE_PILOT_ANAMNESIS_DIR || join(homedir(), ".lane-pilot", "anamnesis");
export const anamnesisDbPath = (): string => join(anamnesisDir(), "anamnesis.db");

/** The hub's owner tables inside the plugin base. */
export const OWNER_TABLE_PREFIX = "lane_pilot_owner_";

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

/** What `purgeTechnical` found among the unconfirmed records: counts by why, by status and by kind. */
export type PurgeReport = { dryRun: boolean; scanned: number; deleted: number; byReason: Record<string, number>; byStatus: Record<string, number>; byKind: Record<string, number>; kept: { confirmed: number; ownerTouched: number } };

export type Counts = {
  records: number; evidence: number;
  byKind: Record<string, number>; byStatus: Record<string, number>; bySensitivity: Record<string, number>;
};

/** The slice of `node:sqlite`/`better-sqlite3` the store needs, so the hub base and the file share one implementation. */
export type StoreDb = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...args: Array<string | number | null>): unknown;
    all(...args: Array<string | number | null>): unknown[];
    run(...args: Array<string | number | null>): unknown;
  };
  close(): void;
};

/** Field encryption of the hub store; `missing` is the `owner_key_missing` log line, called on each refused sensitive write. */
export type OwnerCrypto = { key(): Buffer | null; missing(): void };

type Row = Record<string, unknown>;
const num = (value: unknown): number => Number(value ?? 0);
const json = (value: unknown): Record<string, unknown> => { const parsed = parseJsonOr<unknown>(String(value ?? "{}"), {}); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; };
const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, statement TEXT NOT NULL DEFAULT '', attributes TEXT NOT NULL DEFAULT '{}',
  sensitivity TEXT NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL, first_seen INTEGER, last_seen INTEGER,
  manual_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, authored_by TEXT);
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
CREATE TABLE IF NOT EXISTS notes_files(file TEXT PRIMARY KEY, hash TEXT NOT NULL, written_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes_lines(record_id TEXT PRIMARY KEY, file TEXT NOT NULL, line TEXT NOT NULL);
`;

/** The nine store tables, so one schema serves the file (`records`) and the hub base (`lane_pilot_owner_records`). */
const TABLE_RE = /\b(records|evidence|history|tombstones|checkpoints|sources|loads|notes_files|notes_lines)\b/g;
const prefixed = (prefix: string, sql: string): string => (prefix ? sql.replace(TABLE_RE, (name) => prefix + name) : sql);
/** The store's DDL for a table prefix — the file store's unprefixed names or the hub's `lane_pilot_owner_` ones. */
export const anamnesisSchemaSql = (prefix = ""): string => prefixed(prefix, SCHEMA);

export type Store = ReturnType<typeof createStore>;

function createStore(db: StoreDb, options: { prefix?: string; path?: string; crypto?: OwnerCrypto; ensureSchema?: boolean; closeDb?: boolean } = {}) {
  const prefix = options.prefix ?? "";
  const crypt = options.crypto;
  if (options.ensureSchema !== false) {
    db.exec(anamnesisSchemaSql(prefix));
    try { db.exec(`ALTER TABLE ${prefix}records ADD COLUMN authored_by TEXT`); } catch { /* the column is already in SCHEMA */ }
  }

  const one = (sql: string, ...args: Array<string | number | null>): Row | undefined => db.prepare(prefixed(prefix, sql)).get(...args) as Row | undefined;
  const all = (sql: string, ...args: Array<string | number | null>): Row[] => db.prepare(prefixed(prefix, sql)).all(...args) as Row[];
  const run = (sql: string, ...args: Array<string | number | null>): number => {
    const result = db.prepare(prefixed(prefix, sql)).run(...args) as { changes?: number | bigint } | undefined;
    return Number(result?.changes ?? 0);
  };
  let depth = 0;
  /** One transaction; a call made inside another one joins it. */
  const tx = <T>(work: () => T): T => {
    if (depth > 0) return work();
    db.exec("BEGIN IMMEDIATE");
    depth = 1;
    try { const out = work(); db.exec("COMMIT"); return out; } catch (cause) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw cause; } finally { depth = 0; }
  };
  /** `work` rolled back afterwards: a plan counted by the real rules that changes nothing (also the dry run of the migration). */
  const dry = <T>(work: () => T): T => {
    if (depth > 0) throw new Error("dryRun cannot join a transaction");
    db.exec("BEGIN IMMEDIATE");
    depth = 1;
    try { return work(); } finally { depth = 0; db.exec("ROLLBACK"); }
  };

  /* ---- field encryption: only the free text of a `sensitive` record, self-describing `v1:` ciphertext ---- */

  const isSensitive = (sensitivity: Sensitivity): boolean => sensitivity === "sensitive";
  /** Plain text in, storable text out: ciphertext for a sensitive record on the hub, the input itself elsewhere. */
  const seal = (plain: string, sensitiveRecord: boolean): string => {
    if (!plain || !sensitiveRecord || !crypt) return plain;
    const key = crypt.key();
    if (!key) { crypt.missing(); throw new OwnerKeyError("owner_key_missing: LP_OWNER_MEMORY_KEY is not available, sensitive records are refused"); }
    return encryptOwnerField(key, plain);
  };
  /** Stored text back to plain: `v1:` opens with the key, anything else passes through (the legacy file is plaintext). */
  const open = (value: string): string => (crypt ? decryptOwnerField(crypt.key(), value) : value);
  /** A sensitive write is refused, never written in clear, while the key is missing. */
  const keyRefusal = (sensitivity: Sensitivity): UpsertResult | null =>
    isSensitive(sensitivity) && crypt && !crypt.key() ? (crypt.missing(), { id: null, action: "ignored", reason: "owner_key_missing", newEvidence: 0 }) : null;

  /** Moves a record's encrypted fields across the sensitive boundary: evidence quotes, history changes and note lines follow it. */
  function rekeyRecord(id: string, toSensitive: boolean): void {
    if (!crypt) return;
    const flip = (value: string | null): string | null => {
      if (value === null) return null;
      const plain = open(value);
      return toSensitive ? seal(plain, true) : plain;
    };
    for (const row of all("SELECT rowid AS rid, quote FROM evidence WHERE record_id=? AND quote IS NOT NULL", id)) run("UPDATE evidence SET quote=? WHERE rowid=?", flip(str(row.quote))!, num(row.rid));
    for (const row of all("SELECT id AS hid, changes FROM history WHERE record_id=?", id)) run("UPDATE history SET changes=? WHERE id=?", flip(str(row.changes))!, num(row.hid));
    for (const row of all("SELECT line FROM notes_lines WHERE record_id=?", id)) run("UPDATE notes_lines SET line=? WHERE record_id=?", flip(str(row.line))!, id);
  }

  const toRecord = (row: Row): AnamnesisRecord | null => {
    try {
      return {
        id: str(row.id), kind: row.kind as Kind, title: open(str(row.title)), statement: open(str(row.statement)), attributes: json(open(str(row.attributes))),
        sensitivity: row.sensitivity as Sensitivity, confidence: num(row.confidence), status: row.status as Status,
        firstSeen: row.first_seen === null ? null : num(row.first_seen), lastSeen: row.last_seen === null ? null : num(row.last_seen),
        manualAt: num(row.manual_at), createdAt: num(row.created_at), updatedAt: num(row.updated_at), evidenceCount: num(row.evidence_count),
        authoredBy: row.authored_by === "model" || row.authored_by === "owner" ? row.authored_by : null,
      };
    } catch (cause) {
      // A sensitive record without its key stays closed: invisible to lists and reads, never an exception that stops a batch.
      if (cause instanceof OwnerKeyError) return null;
      throw cause;
    }
  };
  const SELECT = "SELECT r.*, (SELECT count(*) FROM evidence e WHERE e.record_id=r.id) AS evidence_count FROM records r";

  const sourceEnabled = (source: Source): boolean => {
    if (source === "manual") return true;
    const row = one("SELECT enabled FROM sources WHERE source=?", source);
    return row ? num(row.enabled) === 1 : DEFAULT_SOURCES[source];
  };
  const cutoffFor = (id: string): number => Math.max(num(one("SELECT cutoff FROM tombstones WHERE id='*'")?.cutoff), num(one("SELECT cutoff FROM tombstones WHERE id=?", id)?.cutoff));
  const log = (id: string, at: number, actor: string, action: string, reason: string, changes: Record<string, unknown>, sensitiveRecord = false): void => {
    run("INSERT INTO history(record_id,at,actor,action,reason,changes) VALUES (?,?,?,?,?,?)", id, at, actor, action, reason.slice(0, 300),
      sensitiveRecord ? seal(JSON.stringify(changes), true) : JSON.stringify(changes));
  };

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
    // Infrastructure (an address, an ssh command, a key path, a variable name) is never about the owner as a person; the owner may still write it himself.
    const infra = owner ? null : infrastructureReason(input.title, input.statement);
    if (infra) return { id, action: "ignored", reason: `infrastructure: ${infra}`, newEvidence: 0 };

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
      const refused = keyRefusal(sensitivity);
      if (refused) return { ...refused, id };
      const status: Status = owner ? "confirmed" : input.status ?? "draft";
      const authoredBy = input.attributes.authoredBy === "model" || input.attributes.authoredBy === "owner" ? input.attributes.authoredBy : null;
      const sensitiveRecord = isSensitive(sensitivity);
      run("INSERT INTO records(id,kind,title,statement,attributes,sensitivity,confidence,status,first_seen,last_seen,manual_at,created_at,updated_at,authored_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, input.kind, seal(input.title, sensitiveRecord), seal(input.statement, sensitiveRecord), seal(JSON.stringify(input.attributes), sensitiveRecord), sensitivity, input.confidence, status,
        input.firstSeen ?? oldest, input.lastSeen ?? newest, owner ? now : 0, now, now, authoredBy);
      for (const item of evidence) run("INSERT OR IGNORE INTO evidence(record_id,source,ref,at,quote) VALUES (?,?,?,?,?)", id, item.source, item.ref, item.at, item.quote == null ? null : seal(item.quote, sensitiveRecord));
      pruneEvidence(id);
      log(id, now, ctx.actor, "create", ctx.reason, { title: input.title, sensitivity, status, evidence: evidence.length }, sensitiveRecord);
      return { id, action: "created", reason: null, newEvidence: evidence.length };
    }

    const current = toRecord(existing);
    if (!current) return { id, action: "ignored", reason: "owner_key_missing", newEvidence: 0 };
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
    const sensitiveRecord = isSensitive(sensitivity);
    const refused = keyRefusal(sensitivity);
    if (refused) return { ...refused, id };
    let added = 0;
    for (const item of evidence) {
      const before = num(one("SELECT count(*) AS n FROM evidence WHERE record_id=? AND source=? AND ref=?", id, item.source, item.ref)?.n);
      if (!before) { run("INSERT INTO evidence(record_id,source,ref,at,quote) VALUES (?,?,?,?,?)", id, item.source, item.ref, item.at, item.quote == null ? null : seal(item.quote, sensitiveRecord)); added += 1; }
    }
    if (added) pruneEvidence(id);
    const dirty = Object.keys(changes).length > 0 || attributesChanged || confidence !== current.confidence || firstSeen !== current.firstSeen || lastSeen !== current.lastSeen || added > 0;
    if (!dirty) return { id, action: "unchanged", reason: null, newEvidence: 0 };
    if (isSensitive(current.sensitivity) !== sensitiveRecord) rekeyRecord(id, sensitiveRecord);
    run("UPDATE records SET title=?, statement=?, attributes=?, sensitivity=?, confidence=?, status=?, first_seen=?, last_seen=?, manual_at=?, updated_at=? WHERE id=?",
      seal(title, sensitiveRecord), seal(statement, sensitiveRecord), seal(JSON.stringify(attributes), sensitiveRecord), sensitivity, confidence, status, firstSeen, lastSeen, owner ? now : current.manualAt, now, id);
    // History keeps what a person would want to read back; counters that move on every pass are not a change.
    const meaningful = Object.keys(changes).length > 0;
    if (meaningful) log(id, now, ctx.actor, "update", ctx.reason, { ...changes, ...(added ? { evidence: added } : {}) }, sensitiveRecord);
    return { id, action: meaningful || added || attributesChanged ? "updated" : "unchanged", reason: null, newEvidence: added };
  }

  function readFull(id: string): AnamnesisRecordFull {
    const row = one(`${SELECT} WHERE r.id=?`, id)!;
    const record = toRecord(row);
    if (!record) throw new OwnerKeyError("owner_key_missing: the record stays closed without LP_OWNER_MEMORY_KEY");
    const evidence = all("SELECT source, ref, at, quote FROM evidence WHERE record_id=? ORDER BY at", id)
      .map((item) => ({ source: item.source as Source, ref: str(item.ref), at: num(item.at), ...(item.quote ? { quote: open(str(item.quote)) } : {}) }));
    return { ...record, evidence };
  }
  function checkpointAt(source: Source): number | null {
    const row = one("SELECT at FROM checkpoints WHERE source=?", source);
    return row ? num(row.at) : null;
  }

  return {
    path: options.path ?? ":memory:",
    close: () => { if (options.closeDb !== false) db.close(); },
    transaction: tx,
    /** Runs `work` and rolls everything back: the plan of a load, counted by the same rules as the real write, changing nothing. */
    dryRun: dry,

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
      if (!record) return null;
      if (record.sensitivity === "sensitive" && !options.includeSensitive) return null;
      const evidence = all("SELECT source, ref, at, quote FROM evidence WHERE record_id=? ORDER BY at", id)
        .map((item) => ({ source: item.source as Source, ref: str(item.ref), at: num(item.at), ...(item.quote ? { quote: open(str(item.quote)) } : {}) }));
      return { ...record, evidence };
    },

    list(filter: ListFilter = {}): AnamnesisRecord[] {
      const where: string[] = [], args: Array<string | number | null> = [];
      if (filter.kinds?.length) { where.push(`r.kind IN (${filter.kinds.map(() => "?").join(",")})`); args.push(...filter.kinds); }
      if (filter.statuses?.length) { where.push(`r.status IN (${filter.statuses.map(() => "?").join(",")})`); args.push(...filter.statuses); }
      if (!filter.includeSensitive) where.push("r.sensitivity != 'sensitive'");
      const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000), offset = Math.max(filter.offset ?? 0, 0);
      const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      // Encrypted fields cannot be matched by SQL LIKE: with the owner key the query filters decrypted text instead.
      if (filter.query && crypt) {
        const needle = filter.query.toLowerCase();
        return all(`${SELECT}${clause} ORDER BY COALESCE(r.last_seen, r.updated_at) DESC, r.id LIMIT 5000`, ...args)
          .map(toRecord)
          .filter((record): record is AnamnesisRecord => record !== null && (record.title.toLowerCase().includes(needle) || record.statement.toLowerCase().includes(needle)))
          .slice(offset, offset + limit);
      }
      if (filter.query) { where.push("(r.title LIKE ? ESCAPE '\\' OR r.statement LIKE ? ESCAPE '\\')"); const like = `%${filter.query.replace(/[\\%_]/g, "\\$&")}%`; args.push(like, like); }
      return all(`${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(r.last_seen, r.updated_at) DESC, r.id LIMIT ${limit} OFFSET ${offset}`, ...args)
        .map(toRecord).filter((record): record is AnamnesisRecord => record !== null);
    },

    counts(): Counts {
      const group = (column: string) => Object.fromEntries(all(`SELECT ${column} AS k, count(*) AS n FROM records GROUP BY ${column}`).map((row) => [str(row.k), num(row.n)]));
      return { records: num(one("SELECT count(*) AS n FROM records")?.n), evidence: num(one("SELECT count(*) AS n FROM evidence")?.n),
        byKind: group("kind"), byStatus: group("status"), bySensitivity: group("sensitivity") };
    },

    /** The owner's edit or decision. It protects the record from older evidence and is kept in the history. */
    edit(id: string, patch: EditPatch, reason: string, now = Date.now()): AnamnesisRecordFull {
      return tx(() => {
        const row = one(`${SELECT} WHERE r.id=?`, id);
        if (!row) throw new Error(`no record ${id}`);
        const current = toRecord(row);
        if (!current) throw new OwnerKeyError("owner_key_missing: the record stays closed without LP_OWNER_MEMORY_KEY");
        for (const text of [patch.title, patch.statement]) { const bad = text ? unsafeReason(text) : null; if (bad) throw new Error(`The text carries ${bad}; write plain facts`); }
        const changes: Record<string, unknown> = {};
        const next = { title: current.title, statement: current.statement, sensitivity: current.sensitivity, confidence: current.confidence, status: current.status, attributes: current.attributes };
        if (patch.title !== undefined && patch.title !== current.title) { changes.title = [current.title, patch.title]; next.title = patch.title; }
        if (patch.statement !== undefined && patch.statement !== current.statement) { changes.statement = [current.statement.slice(0, 120), patch.statement.slice(0, 120)]; next.statement = patch.statement; }
        if (patch.sensitivity !== undefined && patch.sensitivity !== current.sensitivity) { changes.sensitivity = [current.sensitivity, patch.sensitivity]; next.sensitivity = patch.sensitivity; }
        if (patch.confidence !== undefined && patch.confidence !== current.confidence) { changes.confidence = [current.confidence, patch.confidence]; next.confidence = patch.confidence; }
        if (patch.status !== undefined && patch.status !== current.status) { changes.status = [current.status, patch.status]; next.status = patch.status; }
        if (patch.attributes) { next.attributes = { ...current.attributes, ...patch.attributes }; changes.attributes = Object.keys(patch.attributes); }
        const sensitiveRecord = isSensitive(next.sensitivity);
        if (keyRefusal(next.sensitivity)) throw new OwnerKeyError("owner_key_missing: LP_OWNER_MEMORY_KEY is not available, sensitive records are refused");
        run("UPDATE records SET title=?, statement=?, attributes=?, sensitivity=?, confidence=?, status=?, manual_at=?, updated_at=? WHERE id=?",
          seal(next.title, sensitiveRecord), seal(next.statement, sensitiveRecord), seal(JSON.stringify(next.attributes), sensitiveRecord), next.sensitivity, next.confidence, next.status, now, now, id);
        if (isSensitive(current.sensitivity) !== sensitiveRecord) rekeyRecord(id, sensitiveRecord);
        run("INSERT OR IGNORE INTO evidence(record_id,source,ref,at,quote) VALUES (?,?,?,?,NULL)", id, "manual", `edit:${now}`, now);
        log(id, now, "owner", Object.keys(changes).length === 1 && changes.status ? "status" : "edit", reason, changes, sensitiveRecord);
        return readFull(id);
      });
    },

    history(id: string, limit = 50): HistoryEntry[] {
      return all("SELECT id, record_id, at, actor, action, reason, changes FROM history WHERE record_id=? ORDER BY id DESC LIMIT ?", id, Math.min(Math.max(limit, 1), 500))
        .map((row) => ({ id: num(row.id), recordId: str(row.record_id), at: num(row.at), actor: str(row.actor), action: str(row.action), reason: str(row.reason), changes: json(open(str(row.changes))) }));
    },

    /** Removes one record with its evidence and history and keeps only a cutoff: older sources cannot bring it back. */
    forget(id: string, now = Date.now()): boolean {
      return tx(() => {
        const existed = !!one("SELECT 1 AS x FROM records WHERE id=?", id);
        run("DELETE FROM records WHERE id=?", id);
        run("DELETE FROM history WHERE record_id=?", id);
        run("DELETE FROM notes_lines WHERE record_id=?", id);
        run("INSERT INTO tombstones(id,cutoff) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET cutoff=excluded.cutoff", id, now);
        return existed;
      });
    },

    /** Everything goes, history and load reports with it; the checkpoints restart from the cutoff. */
    forgetAll(now = Date.now()): { removed: number } {
      return tx(() => {
        const removed = num(one("SELECT count(*) AS n FROM records")?.n);
        for (const table of ["evidence", "history", "records", "tombstones", "checkpoints", "loads", "notes_lines"]) run(`DELETE FROM ${table}`);
        run("INSERT INTO tombstones(id,cutoff) VALUES ('*',?)", now);
        return { removed };
      });
    },

    /** Drops what one source taught and switches it off; records that only it supported are forgotten with a cutoff. */
    forgetSource(source: Source, now = Date.now()): { evidence: number; records: number } {
      return tx(() => {
        const evidence = num(one("SELECT count(*) AS n FROM evidence WHERE source=?", source)?.n);
        const orphans = all("SELECT record_id FROM evidence GROUP BY record_id HAVING sum(CASE WHEN source=? THEN 0 ELSE 1 END)=0 AND count(*)>0", source).map((row) => str(row.record_id));
        run("DELETE FROM evidence WHERE source=?", source);
        for (const id of orphans) {
          run("DELETE FROM records WHERE id=?", id); run("DELETE FROM history WHERE record_id=?", id); run("DELETE FROM notes_lines WHERE record_id=?", id);
          run("INSERT INTO tombstones(id,cutoff) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET cutoff=excluded.cutoff", id, now);
        }
        run("DELETE FROM checkpoints WHERE source=?", source);
        run("INSERT INTO sources(source,enabled,changed_at) VALUES (?,0,?) ON CONFLICT(source) DO UPDATE SET enabled=0, changed_at=excluded.changed_at", source, now);
        return { evidence, records: orphans.length };
      });
    },

    /**
     * One-shot cleanup of what the first load put in that is not about the owner as a person: unconfirmed records (draft or candidate)
     * that no one has touched whose evidence comes only from the project data (journal, registry, Lane Pilot runs, Claude memories of
     * type project or reference, BB memories that are not preferences, the message counts of a BB project), or whose text is
     * infrastructure. Confirmed, rejected and owner-touched records are never touched.
     */
    purgeTechnical(options: { dryRun?: boolean } = {}): PurgeReport {
      const dryRun = options.dryRun === true;
      const report: PurgeReport = { dryRun, scanned: 0, deleted: 0, byReason: {}, byStatus: {}, byKind: {}, kept: { confirmed: 0, ownerTouched: 0 } };
      const technical = (source: string, record: AnamnesisRecord): boolean => {
        if (source === "journal" || source === "registry" || source === "lp-runs") return true;
        if (source === "claude-memory") return !["user", "feedback"].includes(String(record.attributes.type ?? ""));
        if (source === "bb-memory") return record.attributes.memoryKind !== "preference";
        return false;
      };
      return tx(() => {
        report.kept.confirmed = num(one("SELECT count(*) AS n FROM records WHERE status='confirmed'")?.n);
        report.kept.ownerTouched = num(one("SELECT count(*) AS n FROM records WHERE status IN ('draft','candidate') AND manual_at>0")?.n);
        // A record that stays closed without its key cannot be judged and is kept.
        const rows = all(`${SELECT} WHERE r.status IN ('draft','candidate') AND r.manual_at=0`).map(toRecord).filter((record): record is AnamnesisRecord => record !== null);
        report.scanned = rows.length;
        for (const record of rows) {
          const sources = all("SELECT DISTINCT source FROM evidence WHERE record_id=?", record.id).map((row) => str(row.source));
          let reason: string | null = null;
          if (infrastructureReason(record.title, record.statement)) reason = "infrastructure";
          else if (record.kind === "project" && record.attributes.bbProjectId !== undefined) reason = "project_activity";
          else if (sources.length && sources.every((source) => technical(source, record))) reason = "technical_source";
          if (!reason) continue;
          report.deleted += 1;
          report.byReason[reason] = (report.byReason[reason] ?? 0) + 1;
          report.byStatus[record.status] = (report.byStatus[record.status] ?? 0) + 1;
          report.byKind[record.kind] = (report.byKind[record.kind] ?? 0) + 1;
          if (!dryRun) { run("DELETE FROM records WHERE id=?", record.id); run("DELETE FROM history WHERE record_id=?", record.id); }
        }
        return report;
      });
    },

    /** For each record, its newest evidence and, when messages taught it, the thread of the newest message: what the notes files point to. */
    evidenceHeads(): Map<string, { latest: { source: string; at: number }; thread?: string }> {
      const heads = new Map<string, { latest: { source: string; at: number }; thread?: string }>();
      for (const row of all("SELECT record_id, source, MAX(at) AS at FROM evidence GROUP BY record_id")) heads.set(str(row.record_id), { latest: { source: str(row.source), at: num(row.at) } });
      for (const row of all("SELECT record_id, ref, MAX(at) AS at FROM evidence WHERE source='bb-message' GROUP BY record_id")) {
        const head = heads.get(str(row.record_id));
        if (head) head.thread = str(row.ref).split(":")[0]!;
      }
      return heads;
    },

    /** Where the portrait files stand: the hash of what was last written per file and the line written for each record. */
    notesState(): { files: Map<string, string>; lines: Map<string, { file: string; line: string }> } {
      return {
        files: new Map(all("SELECT file, hash FROM notes_files").map((row) => [str(row.file), str(row.hash)])),
        lines: new Map(all("SELECT record_id, file, line FROM notes_lines").map((row) => [str(row.record_id), { file: str(row.file), line: open(str(row.line)) }])),
      };
    },
    saveNotesState(file: string, hash: string, lines: ReadonlyMap<string, string>, now = Date.now()): void {
      tx(() => {
        run("INSERT INTO notes_files(file,hash,written_at) VALUES (?,?,?) ON CONFLICT(file) DO UPDATE SET hash=excluded.hash, written_at=excluded.written_at", file, hash, now);
        run("DELETE FROM notes_lines WHERE file=?", file);
        for (const [id, line] of lines) {
          const sensitive = one("SELECT sensitivity FROM records WHERE id=?", id)?.sensitivity === "sensitive";
          run("INSERT OR REPLACE INTO notes_lines(record_id,file,line) VALUES (?,?,?)", id, file, seal(line, sensitive));
        }
      });
    },
    dropNotesLine(id: string): void { run("DELETE FROM notes_lines WHERE record_id=?", id); },

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
      return all("SELECT id, at, mode, report FROM loads ORDER BY id DESC LIMIT ?", limit).map((row) => ({ id: num(row.id), at: num(row.at), mode: str(row.mode), report: JSON.parse(str(row.report)) as unknown }));
    },

    /** Every row of every table, for the one-off migration export → hub import. Raw values, encryption applied on the way in. */
    exportAll(): Record<string, Row[]> {
      const tables: Record<string, Row[]> = {};
      for (const table of ["records", "evidence", "history", "tombstones", "checkpoints", "sources", "loads", "notes_files", "notes_lines"]) tables[table] = all(`SELECT * FROM ${table} ORDER BY rowid`);
      return tables;
    },

    /**
     * The migration's write side: rows from the host's `export` op into this store, idempotent by primary key.
     * Sensitive records are sealed again under this store's key; without the key they are skipped (`owner_key_missing`),
     * never written in clear, and so are the rows that only they parent. `dryRun` counts what a run would do.
     */
    importRows(tables: Record<string, Row[]>, options: { dryRun?: boolean } = {}): Record<string, { rows: number; inserted: number; existing: number; skipped: number }> {
      const work = () => {
        const counts: Record<string, { rows: number; inserted: number; existing: number; skipped: number }> = {};
        const bump = (table: string, key: "rows" | "inserted" | "existing" | "skipped"): void => { (counts[table] ??= { rows: 0, inserted: 0, existing: 0, skipped: 0 })[key] += 1; };
        const sensitivityOf = new Map<string, string>();
        for (const row of all("SELECT id, sensitivity FROM records")) sensitivityOf.set(str(row.id), str(row.sensitivity));
        const skippedRecords = new Set<string>();
        let keyMissingLogged = false;
        const refuse = (): boolean => {
          if (keyMissingLogged) return true;
          keyMissingLogged = true; crypt?.missing();
          return true;
        };
        for (const row of tables.records ?? []) {
          bump("records", "rows");
          const id = str(row.id), sensitivity = str(row.sensitivity);
          sensitivityOf.set(id, sensitivity);
          const sensitiveRecord = isSensitive(sensitivity as Sensitivity);
          if (sensitiveRecord && crypt && !crypt.key() && refuse()) { skippedRecords.add(id); bump("records", "skipped"); continue; }
          const written = run("INSERT OR IGNORE INTO records(id,kind,title,statement,attributes,sensitivity,confidence,status,first_seen,last_seen,manual_at,created_at,updated_at,authored_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            id, str(row.kind), seal(str(row.title), sensitiveRecord), seal(str(row.statement), sensitiveRecord), seal(str(row.attributes), sensitiveRecord), sensitivity, num(row.confidence), str(row.status),
            row.first_seen == null ? null : num(row.first_seen), row.last_seen == null ? null : num(row.last_seen), num(row.manual_at), num(row.created_at), num(row.updated_at), row.authored_by == null ? null : str(row.authored_by));
          bump("records", written ? "inserted" : "existing");
        }
        for (const row of tables.evidence ?? []) {
          bump("evidence", "rows");
          const record = str(row.record_id);
          if (skippedRecords.has(record)) { bump("evidence", "skipped"); continue; }
          const sensitiveRecord = sensitivityOf.get(record) === "sensitive";
          const written = run("INSERT OR IGNORE INTO evidence(record_id,source,ref,at,quote) VALUES (?,?,?,?,?)", record, str(row.source), str(row.ref), num(row.at), row.quote == null ? null : seal(str(row.quote), sensitiveRecord));
          bump("evidence", written ? "inserted" : "existing");
        }
        for (const row of tables.history ?? []) {
          bump("history", "rows");
          const record = str(row.record_id);
          if (skippedRecords.has(record)) { bump("history", "skipped"); continue; }
          const sensitiveRecord = sensitivityOf.get(record) === "sensitive";
          const written = run("INSERT OR IGNORE INTO history(id,record_id,at,actor,action,reason,changes) VALUES (?,?,?,?,?,?,?)",
            num(row.id), record, num(row.at), str(row.actor), str(row.action), str(row.reason), sensitiveRecord ? seal(str(row.changes), true) : str(row.changes));
          bump("history", written ? "inserted" : "existing");
        }
        for (const row of tables.tombstones ?? []) {
          bump("tombstones", "rows");
          const written = run("INSERT OR IGNORE INTO tombstones(id,cutoff) VALUES (?,?)", str(row.id), num(row.cutoff));
          bump("tombstones", written ? "inserted" : "existing");
        }
        for (const row of tables.checkpoints ?? []) {
          bump("checkpoints", "rows");
          const written = run("INSERT OR IGNORE INTO checkpoints(source,at,detail,updated_at) VALUES (?,?,?,?)", str(row.source), num(row.at), str(row.detail), num(row.updated_at));
          bump("checkpoints", written ? "inserted" : "existing");
        }
        for (const row of tables.sources ?? []) {
          bump("sources", "rows");
          const written = run("INSERT OR IGNORE INTO sources(source,enabled,changed_at) VALUES (?,?,?)", str(row.source), num(row.enabled), num(row.changed_at));
          bump("sources", written ? "inserted" : "existing");
        }
        for (const row of tables.loads ?? []) {
          bump("loads", "rows");
          const written = run("INSERT OR IGNORE INTO loads(id,at,mode,report) VALUES (?,?,?,?)", num(row.id), num(row.at), str(row.mode), str(row.report));
          bump("loads", written ? "inserted" : "existing");
        }
        for (const row of tables.notes_files ?? []) {
          bump("notes_files", "rows");
          const written = run("INSERT OR IGNORE INTO notes_files(file,hash,written_at) VALUES (?,?,?)", str(row.file), str(row.hash), num(row.written_at));
          bump("notes_files", written ? "inserted" : "existing");
        }
        for (const row of tables.notes_lines ?? []) {
          bump("notes_lines", "rows");
          const record = str(row.record_id);
          if (skippedRecords.has(record)) { bump("notes_lines", "skipped"); continue; }
          const sensitiveRecord = sensitivityOf.get(record) === "sensitive";
          const written = run("INSERT OR IGNORE INTO notes_lines(record_id,file,line) VALUES (?,?,?)", record, str(row.file), seal(str(row.line), sensitiveRecord));
          bump("notes_lines", written ? "inserted" : "existing");
        }
        return counts;
      };
      return options.dryRun ? dry(work) : tx(work);
    },
  };
}

/** The Mac-mini file store: plaintext at rest, the migration's export source and the tests' fixture. */
export function openStore(path: string = anamnesisDbPath()): Store {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(path), 0o700); } catch { /* a folder we do not own keeps its mode */ }
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  const store = createStore(db as unknown as StoreDb, { path, ensureSchema: true });
  if (path !== ":memory:") for (const suffix of ["", "-wal", "-shm"]) { try { chmodSync(path + suffix, 0o600); } catch { /* not created yet */ } }
  return store;
}

/**
 * The hub's store: the same implementation over the plugin base's `lane_pilot_owner_*` tables (already created by the
 * append-only migrations; `ensureSchema` keeps tests on a bare handle working). `crypto` turns on field encryption of
 * sensitive records; the handle stays open — the plugin base owns it.
 */
export function openOwnerStore(db: StoreDb, options: { crypto?: OwnerCrypto; path?: string } = {}): Store {
  return createStore(db, { prefix: OWNER_TABLE_PREFIX, path: options.path ?? "hub:data.db", crypto: options.crypto, ensureSchema: true, closeDb: false });
}
