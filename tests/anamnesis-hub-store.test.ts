import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { OWNER_KEY_NAME, decryptOwnerField, encryptOwnerField, parseOwnerKey } from "../src/rooms/anamnesis/crypto";
import { anamnesisOwnerMigrations } from "../src/rooms/anamnesis/migrations";
import { anamnesisSchemaSql, openOwnerStore, openStore, OWNER_TABLE_PREFIX, type OwnerCrypto, type StoreDb } from "../src/rooms/anamnesis/store";
import { createHub } from "../src/rooms/anamnesis/hub";

/**
 * M1b: the anamnesis lives in the hub's `lane_pilot_owner_*` tables. These tests pin the four things the move must not
 * lose: the same columns and rules as the file store, field encryption of sensitive records under LP_OWNER_MEMORY_KEY,
 * the missing-key refusal, and the idempotent one-off migration.
 */
const T0 = Date.UTC(2026, 2, 1);
const key = Buffer.alloc(32, 7);
const crypto = (value: Buffer | null = key): OwnerCrypto => ({ key: () => value, missing: () => undefined });
const ownerDb = () => new DatabaseSync(":memory:");
const evidence = [{ source: "git" as const, ref: "r@1", at: T0 }];

describe("the owner tables of the plugin base", () => {
  it("carry the same columns as the file store, under the lane_pilot_owner_ prefix", () => {
    const fileDb = new DatabaseSync(":memory:");
    fileDb.exec(anamnesisSchemaSql());
    const hubDb = ownerDb();
    openOwnerStore(hubDb as unknown as StoreDb).close();
    const cols = (db: DatabaseSync, table: string) =>
      (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((row) => row.name).sort();
    for (const table of ["records", "evidence", "history", "tombstones", "checkpoints", "sources", "loads", "notes_files", "notes_lines"]) {
      const prefixedTable = `${OWNER_TABLE_PREFIX}${table}`;
      expect(anamnesisOwnerMigrations.some((sql) => sql.includes(`CREATE TABLE ${prefixedTable}`)), prefixedTable).toBe(true);
      expect(cols(hubDb, prefixedTable), prefixedTable).toEqual(cols(fileDb, table));
    }
    fileDb.close(); hubDb.close();
  });

  it("keeps the evidence rules: no evidence, no record; the owner's edit protects it; forget leaves a cutoff", () => {
    const store = openOwnerStore(ownerDb() as unknown as StoreDb);
    expect(store.upsert({ kind: "skill", key: "NoProof", title: "No proof" }, { actor: "auto:git", reason: "t", now: T0 }).action).toBe("ignored");
    expect(store.upsert({ kind: "skill", key: "TS", title: "TypeScript", evidence }, { actor: "auto:git", reason: "t", now: T0 }).action).toBe("created");
    store.edit("skill:ts", { statement: "owner words" }, "owner", T0 + 10);
    const older = store.upsert({ kind: "skill", key: "TS", title: "TypeScript", statement: "auto words", evidence: [{ source: "git", ref: "r@2", at: T0 + 5 }] }, { actor: "auto:git", reason: "t", now: T0 + 20 });
    expect(older).toMatchObject({ action: "blocked", reason: "predates_owner_edit" });
    store.forget("skill:ts", T0 + 30);
    const revive = store.upsert({ kind: "skill", key: "TS", title: "TypeScript", statement: "back?", evidence: [{ source: "git", ref: "r@3", at: T0 + 25 }] }, { actor: "auto:git", reason: "t", now: T0 + 40 });
    expect(revive).toMatchObject({ action: "ignored", reason: "before_forget_cutoff" });
  });
});

describe("field encryption of sensitive records", () => {
  it("round-trips v1: ciphertext and passes plaintext through", () => {
    const sealed = encryptOwnerField(key, "Anna, health issues");
    expect(sealed).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(decryptOwnerField(key, sealed)).toBe("Anna, health issues");
    expect(decryptOwnerField(key, "plain text")).toBe("plain text");
    expect(() => decryptOwnerField(null, sealed)).toThrow(/owner_key_missing/);
    expect(parseOwnerKey(key.toString("base64"))?.length).toBe(32);
    expect(parseOwnerKey("not-a-key")).toBeNull();
    expect(parseOwnerKey(null)).toBeNull();
    expect(OWNER_KEY_NAME).toBe("LP_OWNER_MEMORY_KEY");
  });

  it("stores sensitive free text as ciphertext and reads it back decrypted; private stays plaintext", () => {
    const db = ownerDb();
    const store = openOwnerStore(db as unknown as StoreDb, { crypto: crypto() });
    store.upsert({ kind: "person", key: "Anna", title: "Anna", statement: "wife, health", attributes: { relation: "family" }, evidence },
      { actor: "auto:bb-message", reason: "t", now: T0 });
    store.upsert({ kind: "skill", key: "TS", title: "TypeScript", evidence }, { actor: "auto:git", reason: "t", now: T0 });
    const raw = db.prepare("SELECT title, statement, attributes FROM lane_pilot_owner_records WHERE id='person:anna'").get() as Record<string, string>;
    expect(raw.title).toMatch(/^v1:/);
    expect(raw.statement).toMatch(/^v1:/);
    expect(raw.attributes).toMatch(/^v1:/);
    expect(decryptOwnerField(key, raw.statement)).toBe("wife, health");
    const plain = db.prepare("SELECT title FROM lane_pilot_owner_records WHERE id='skill:ts'").get() as { title: string };
    expect(plain.title).toBe("TypeScript");
    const record = store.get("person:anna", { includeSensitive: true })!;
    expect(record).toMatchObject({ title: "Anna", statement: "wife, health", attributes: { relation: "family" } });
    expect(record.evidence[0]!.quote).toBeUndefined();
    store.upsert({ kind: "person", key: "Anna", title: "Anna", statement: "wife, health", attributes: { relation: "family" },
      evidence: [{ source: "bb-message", ref: "t:9", at: T0 + 1, quote: "Anna called about her health" }] }, { actor: "auto:bb-message", reason: "t", now: T0 + 2 });
    const quote = db.prepare("SELECT quote FROM lane_pilot_owner_evidence WHERE record_id='person:anna' AND ref='t:9'").get() as { quote: string };
    expect(quote.quote).toMatch(/^v1:/);
    expect(store.get("person:anna", { includeSensitive: true })!.evidence.find((e) => e.ref === "t:9")!.quote).toBe("Anna called about her health");
    // History changes of a sensitive record are ciphertext too.
    store.edit("person:anna", { statement: "wife, health, hospital" }, "owner", T0 + 3);
    const changes = db.prepare("SELECT changes FROM lane_pilot_owner_history WHERE record_id='person:anna' ORDER BY id DESC LIMIT 1").get() as { changes: string };
    expect(changes.changes).toMatch(/^v1:/);
    expect(store.history("person:anna")[0]!.changes).toMatchObject({ statement: expect.any(Array) });
  });

  it("refuses a sensitive write without the key — owner_key_missing, never clear text", () => {
    const db = ownerDb();
    const missing: string[] = [];
    const store = openOwnerStore(db as unknown as StoreDb, { crypto: { key: () => null, missing: () => missing.push("logged") } });
    const result = store.upsert({ kind: "person", key: "Anna", title: "Anna", attributes: { relation: "family" }, evidence },
      { actor: "auto:bb-message", reason: "t", now: T0 });
    expect(result).toMatchObject({ action: "ignored", reason: "owner_key_missing" });
    expect(missing).toEqual(["logged"]);
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_owner_records").get()).toEqual({ n: 0 });
    expect(() => store.edit("person:anna", { status: "confirmed" }, "owner")).toThrow(/no record|owner_key_missing/);
    // A private record is unaffected by the missing key.
    expect(store.upsert({ kind: "skill", key: "TS", title: "TypeScript", evidence }, { actor: "auto:git", reason: "t", now: T0 }).action).toBe("created");
  });

  it("a record that crosses the sensitive boundary re-encrypts its evidence, history and note lines", () => {
    const db = ownerDb();
    const store = openOwnerStore(db as unknown as StoreDb, { crypto: crypto() });
    store.upsert({ kind: "fact", key: "Health", title: "Health", statement: "checkup", evidence: [{ source: "git", ref: "r@1", at: T0, quote: "checkup note" }] },
      { actor: "auto:git", reason: "t", now: T0 });
    store.edit("fact:health", { sensitivity: "sensitive" }, "owner marks it", T0 + 1);
    const quote = db.prepare("SELECT quote FROM lane_pilot_owner_evidence WHERE record_id='fact:health'").get() as { quote: string };
    expect(quote.quote).toMatch(/^v1:/);
    expect(decryptOwnerField(key, quote.quote)).toBe("checkup note");
    store.edit("fact:health", { sensitivity: "private" }, "owner lowers it", T0 + 2);
    const lowered = db.prepare("SELECT quote FROM lane_pilot_owner_evidence WHERE record_id='fact:health'").get() as { quote: string };
    expect(lowered.quote).toBe("checkup note");
    expect(store.get("fact:health")!.sensitivity).toBe("private");
  });
});

describe("the one-off migration", () => {
  it("imports the file store's rows once; a second run inserts nothing; dryRun counts only", () => {
    const file = openStore(":memory:");
    file.upsert({ kind: "skill", key: "TS", title: "TypeScript", evidence }, { actor: "auto:git", reason: "t", now: T0 });
    file.upsert({ kind: "person", key: "Anna", title: "Anna", attributes: { relation: "family" }, evidence: [{ source: "bb-message", ref: "t:1", at: T0, quote: "Anna called" }] },
      { actor: "auto:bb-message", reason: "t", now: T0 });
    file.setCheckpoint("git", T0, { repos: 1 }, T0);
    file.setSource("telegram", false, T0);
    const tables = file.exportAll();

    const db = ownerDb();
    const hub = openOwnerStore(db as unknown as StoreDb, { crypto: crypto() });
    const dry = hub.importRows(tables, { dryRun: true });
    expect(dry.records).toMatchObject({ rows: 2, inserted: 2, existing: 0 });
    expect(hub.counts().records).toBe(0);

    const first = hub.importRows(tables);
    expect(first.records).toMatchObject({ rows: 2, inserted: 2 });
    expect(hub.counts().records).toBe(2);
    expect(hub.checkpoint("git")).toMatchObject({ at: T0 });
    expect(hub.sources().find((s) => s.source === "telegram")!.enabled).toBe(false);
    // Anna is sensitive: her fields arrived as ciphertext under the hub key.
    const raw = db.prepare("SELECT title FROM lane_pilot_owner_records WHERE id='person:anna'").get() as { title: string };
    expect(raw.title).toMatch(/^v1:/);
    expect(hub.get("person:anna", { includeSensitive: true })!.title).toBe("Anna");

    const second = hub.importRows(tables);
    expect(second.records).toMatchObject({ rows: 2, inserted: 0, existing: 2 });
    expect(hub.counts().records).toBe(2);
    file.close();
  });

  it("skips sensitive rows without the key instead of writing them in clear", () => {
    const file = openStore(":memory:");
    file.upsert({ kind: "person", key: "Anna", title: "Anna", attributes: { relation: "family" }, evidence }, { actor: "auto:bb-message", reason: "t", now: T0 });
    file.upsert({ kind: "skill", key: "TS", title: "TypeScript", evidence }, { actor: "auto:git", reason: "t", now: T0 });
    const tables = file.exportAll();
    const hub = openOwnerStore(ownerDb() as unknown as StoreDb, { crypto: crypto(null) });
    const counts = hub.importRows(tables);
    expect(counts.records).toMatchObject({ rows: 2, inserted: 1, skipped: 1 });
    expect(counts.evidence).toMatchObject({ skipped: 1 });
    expect(hub.counts().records).toBe(1);
    expect(hub.get("skill:ts")).not.toBeNull();
    file.close();
  });
});

describe("collection routing (M1b)", () => {
  it("store ops never reach the host; collect goes to the host as a raw scan and lands in the hub store", async () => {
    const calls: unknown[] = [];
    const hub = createHub({
      hostCall: async (_hostId, request) => {
        calls.push(request);
        return { mode: "run", sources: [{ source: "git", items: 1, records: [{ kind: "skill", key: "TS", title: "TypeScript", evidence }] }] };
      },
      listHosts: async () => [{ id: "mini", name: "Mac mini", connected: true }],
      kv: { get: async () => undefined, set: async () => undefined },
      store: openStore(":memory:"),
    });
    await hub.ask({ op: "add", record: { kind: "skill", key: "Local", title: "Local only" }, reason: "told" });
    await hub.ask({ op: "list" });
    // Store ops stay on the hub; the only host traffic a write may cause is the portrait files' sync.
    expect(calls.every((call) => ["notes_read", "notes_write"].includes((call as { op: string }).op))).toBe(true);
    const response = await hub.ask({ op: "collect", mode: "run", sources: ["git"], since: T0, until: T0 + 1 });
    expect(calls).toContainEqual(expect.objectContaining({ op: "collect", mode: "run" }));
    expect(calls.every((call) => ["notes_read", "notes_write", "collect"].includes((call as { op: string }).op))).toBe(true);
    expect((response as { sources: Array<{ records: number }> }).sources[0]!.records).toBe(1);
    expect(hub.store.counts().records).toBe(2);
    expect(hub.store.get("skill:ts")).not.toBeNull();
  });
});
