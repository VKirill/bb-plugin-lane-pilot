import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { deleteMemoryRecord } from "../../src/rooms/self-repair/server/insights";
import { memoryContext, memoryRecordId, searchMemoryRecords, storeMemoryRecords } from "../../packages/memory-core/src";
import type { MemoryCandidate, MemoryDatabase } from "../../packages/memory-core/src";

type Db = ReturnType<typeof openDatabase>;
const newDb = (): Db => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const put = (db: MemoryDatabase, entries: MemoryCandidate[]) =>
  storeMemoryRecords(db, { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent", coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999, entries }).insertedIds;
const note = (content: string, concepts: string[] = ["area"]): MemoryCandidate => ({ kind: "note", content, concepts });
const find = (db: MemoryDatabase, query: string) => searchMemoryRecords(db, "P", query, 10, "fts5").map((row) => row.content);

describe("K8 trigram search: substrings and Russian word forms", () => {
  it("finds another form of a Russian word and a part of an identifier, which whole-word search misses", () => {
    const db = newDb();
    put(db, [note("Ошибка в тестах чекаута возникает при пустой корзине", ["чекаут"]), note("Totals come from calculateTotalPrice in src/cart", ["cart"])]);
    expect(find(db, "ошибки тестов")).toEqual(["Ошибка в тестах чекаута возникает при пустой корзине"]);
    expect(find(db, "TotalPrice")).toEqual(["Totals come from calculateTotalPrice in src/cart"]);
  });

  it("an exact word match still ranks first, and a record found both ways appears once", () => {
    const db = newDb();
    put(db, [note("Deploys use the staging environment", ["deploy"]), note("Environments are provisioned lazily", ["infra"])]);
    const found = find(db, "staging environment");
    expect(found[0]).toBe("Deploys use the staging environment");
    expect(new Set(found).size).toBe(found.length);
  });

  it("a hidden, evicted, superseded or deleted record is not found by trigram either", () => {
    const db = newDb();
    const [gone, hidden, kept] = put(db, [note("Ошибка в тестах первой группы", ["a"]), note("Ошибка в тестах второй группы", ["b"]), note("Ошибка в тестах третьей группы", ["c"])]);
    deleteMemoryRecord(db, "P", gone!);
    db.prepare("UPDATE lane_pilot_memory SET status='expired' WHERE id=?").run(hidden);
    expect(find(db, "ошибки тестов")).toEqual(["Ошибка в тестах третьей группы"]);
    expect(kept).toBeTruthy();
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory_trgm").get() as { n: number }).n).toBe(2);
  });

  it("indexes what was stored before the trigram table existed", () => {
    const db = newDb();
    const content = "Ошибка в тестах старой записи";
    const id = memoryRecordId("P", "note", content);
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "P", "note", "subagent", content, '["x"]', "s", Date.now());
    db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES(?,?,?,?)").run(id, "P", content, "x");
    expect(find(db, "ошибки тестов")).toEqual([content]);
  });

  it("without the trigram tokenizer the same words are found by an in-code scan", () => {
    const real = newDb();
    // A SQLite older than 3.34 refuses the tokenizer: the table cannot be made.
    const old: MemoryDatabase = { prepare: (sql: string) => { if (/tokenize\s*=\s*'trigram'/.test(sql)) throw new Error("no such tokenizer: trigram"); return real.prepare(sql); }, transaction: real.transaction.bind(real) } as MemoryDatabase;
    put(old, [note("Ошибка в тестах чекаута возникает при пустой корзине", ["чекаут"]), note("Totals come from calculateTotalPrice in src/cart", ["cart"])]);
    expect(find(old, "ошибки тестов")).toEqual(["Ошибка в тестах чекаута возникает при пустой корзине"]);
    expect(find(old, "TotalPrice")).toEqual(["Totals come from calculateTotalPrice in src/cart"]);
    expect(() => real.prepare("SELECT 1 FROM lane_pilot_memory_trgm").get()).toThrow();
  });

  it("the packed context matches word forms too", () => {
    const db = newDb();
    put(db, [note("Ошибка в тестах чекаута возникает при пустой корзине", ["чекаут"])]);
    const records = searchMemoryRecords(db, "P", "ошибки тестов", 10, "fts5");
    expect(memoryContext(records, "ошибки тестов", 1000).records).toHaveLength(1);
  });
});
