import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import { dropMemoryIndexes, memoryIndexStatus, pendingVectors, searchMemoryRecords, storeMemoryRecords } from "../../packages/memory-core/src";
import { mixWriterMemory } from "../../src/rooms/memory/server/memory-mix";

type Db = ReturnType<typeof openDatabase>;
const newDb = (): Db => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 999, indexBudget: 99_999 };
const put = (db: Db, content: string, noteBudget: number, now: number) =>
  storeMemoryRecords(db, { projectId: "P", ...limits, noteBudget, now, entries: [{ kind: "note", content, concepts: ["area"] }] });
const OLD = "The invoice export retries three times in services/invoicer/retry.ts before it parks the job.";
const NEW = "The catalog cache keeps entries for fifteen minutes in services/catalog/cache.ts and is refilled nightly.";
const status = (db: Db, id: string) => db.prepare("SELECT status, expired_reason AS reason FROM lane_pilot_memory WHERE id=?").get(id) as { status: string; reason: string | null };
const ftsRows = (db: Db, id: string) => (db.prepare("SELECT count(*) AS n FROM lane_pilot_memory_fts WHERE id=?").get(id) as { n: number }).n;

describe("the note budget limits the shelf, not the memory", () => {
  it("a note the budget moves off the shelf is archived: found by an archive search, not by a brief or a plain search", () => {
    const db = newDb();
    const [old] = put(db, OLD, 40, 1_000).insertedIds;
    const moved = put(db, NEW, 40, 2_000);
    expect(moved.evictedIds).toEqual([old]);
    expect(status(db, old!)).toEqual({ status: "expired", reason: "budget" });
    expect(ftsRows(db, old!)).toBe(1);
    expect(searchMemoryRecords(db, "P", "invoice export retries", 5, "fts5").map((r) => r.id)).toEqual([]);
    expect(searchMemoryRecords(db, "P", "invoice export retries", 5, "fts5", "subagent", "", { includeArchive: true }).map((r) => r.id)).toEqual([old]);
    const brief = mixWriterMemory(db, { projectId: "P", query: "invoice export retries", task: { owns_paths: ["services/invoicer/retry.ts"], read_first: [] }, searchEngine: "fts5", personalBot: "", ruleMemoryIds: new Set() });
    expect(brief.ids).toEqual([]);
  });

  it("an archived note needs a vector like an active one, and the index status counts it as indexed", () => {
    const db = newDb();
    const [old] = put(db, OLD, 40, 1_000).insertedIds;
    put(db, NEW, 40, 2_000);
    expect(pendingVectors(db, 10).map((row) => row.id)).toContain(old);
    expect(memoryIndexStatus(db, "P")).toMatchObject({ active: 2, missingIds: [], orphanedIds: [] });
  });

  it("a note archived before the archive was searchable gets its word indexes back on the first archive search", () => {
    const db = newDb();
    const [old] = put(db, OLD, 40, 1_000).insertedIds;
    put(db, NEW, 40, 2_000);
    dropMemoryIndexes(db, "P", old!);
    expect(ftsRows(db, old!)).toBe(0);
    expect(searchMemoryRecords(db, "P", "invoice export retries", 5, "fts5", "subagent", "", { includeArchive: true }).map((r) => r.id)).toEqual([old]);
    expect(ftsRows(db, old!)).toBe(1);
  });

  it("stating an archived fact again brings it back to the shelf with one index row", () => {
    const db = newDb();
    const [old] = put(db, OLD, 40, 1_000).insertedIds;
    put(db, NEW, 40, 2_000);
    const again = put(db, OLD, 40, 3_000);
    expect(again.insertedIds).toEqual([old]);
    expect(status(db, old!).status).toBe("active");
    expect(ftsRows(db, old!)).toBe(1);
  });

  it("nothing is deleted by the budget: every note is still in the table", () => {
    const db = newDb();
    const names = ["alpha", "beta", "gamma", "delta", "omega", "sigma"];
    names.forEach((name, index) => put(db, `Fact ${index}: the ${name} service owns services/s${index}/main.ts and its queue.`, 40, 1_000 + index));
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_memory").get() as { n: number }).n).toBe(6);
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE status='expired' AND expired_reason='budget'").get() as { n: number }).n).toBeGreaterThan(0);
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE status IN ('active') OR (status='expired' AND expired_reason='budget')").get() as { n: number }).n).toBe(6);
  });
});
