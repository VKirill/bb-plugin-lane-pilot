import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { searchMemoryRecords, storeMemoryRecords } from "../../packages/memory-core/src/store";
import { OBSERVED_QUARANTINE_MS } from "../../packages/memory-core/src/lifecycle";
import { sessionMemoryRpc } from "../../src/rooms/memory/server/session-memory";
import type { ServerCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";

type Db = ReturnType<typeof openDatabase>;
const newDb = (): Db => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const };
const note = (content: string, concepts: string[] = ["area"]) => ({ kind: "note" as const, content, concepts });
const statusOf = (db: Db, id: string) => (db.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(id) as { status: string } | undefined)?.status;

describe("K8 defect 1: a full memory budget no longer stops memory silently", () => {
  const budgets = { coreBudget: 100, noteBudget: 20, indexBudget: 200 };

  it("makes room by hiding the least useful note, and says which", () => {
    const db = newDb();
    const a = storeMemoryRecords(db, { projectId: "P", ...limits, ...budgets, entries: [note("alpha note text about one area")] }).insertedIds[0]!;
    const b = storeMemoryRecords(db, { projectId: "P", ...limits, ...budgets, entries: [note("bravo note text about two area")] }).insertedIds[0]!;
    // b was given to a writer and the attempt was accepted: it is worth more than the never-used a.
    db.prepare("UPDATE lane_pilot_memory SET use_count=3, accepted_count=3 WHERE id=?").run(b);
    const result = storeMemoryRecords(db, { projectId: "P", ...limits, ...budgets, entries: [note("charlie note text about three")] });
    expect(result.insertedIds).toHaveLength(1);
    expect(result.evictedIds).toEqual([a]);
    expect(statusOf(db, a)).toBe("expired");
    expect(statusOf(db, b)).toBe("active");
    const found = searchMemoryRecords(db, "P", "note text area", 10, "fts5").map((row) => row.id);
    expect(found).not.toContain(a);
    expect(found).toContain(b);
  });

  it("never hides a core record, and an entry that cannot fit even alone leaves the corpus untouched", () => {
    const db = newDb();
    const core = storeMemoryRecords(db, { projectId: "P", ...limits, ...budgets, entries: [{ kind: "core", content: "core convention one", concepts: ["c"] }] }).insertedIds[0]!;
    const keep = storeMemoryRecords(db, { projectId: "P", ...limits, ...budgets, entries: [note("keep this note about area")] }).insertedIds[0]!;
    expect(() => storeMemoryRecords(db, { projectId: "P", ...limits, ...budgets, entries: [note("word ".repeat(200))] })).toThrow("note budget");
    expect(statusOf(db, core)).toBe("active");
    expect(statusOf(db, keep)).toBe("active");
    expect(() => storeMemoryRecords(db, { projectId: "P", ...limits, ...budgets, coreBudget: 3, entries: [{ kind: "core", content: "another core convention that is too long", concepts: [] }] })).toThrow("core budget");
  });

  it("a core corpus already over a lowered budget does not block notes", () => {
    const db = newDb();
    storeMemoryRecords(db, { projectId: "P", ...limits, ...budgets, entries: [{ kind: "core", content: "core convention one two three four", concepts: ["c"] }] });
    expect(storeMemoryRecords(db, { projectId: "P", ...limits, ...budgets, coreBudget: 2, entries: [note("a small note")] }).insertedIds).toHaveLength(1);
  });

});

describe("K8 defect 3: a note from a CLI session does not reach writers at once", () => {
  function setup() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { projects: { list: async () => [{ id: "P" }] } } as never });
    const db = openDatabase(bb);
    return { db, rpc: sessionMemoryRpc({ bb, db } as unknown as ServerCore, {} as unknown as Services) };
  }
  const writerSees = (db: Db, now?: number) => searchMemoryRecords(db, "P", "greeting-cards pages", 10, "fts5", "subagent", "", { now }).length;

  it("the session finds its own note, a writer does not until it is corroborated or has waited out the quarantine", async () => {
    const { db, rpc } = setup();
    const content = "Greeting-card pages live in components/greeting-cards.";
    expect(await rpc.session_memory_write({ projectId: "P", kind: "note", content, concepts: ["greeting-cards"], source: "cli mini" })).toMatchObject({ stored: true });
    expect((await rpc.session_memory_search({ projectId: "P", query: "greeting-cards pages" })).records).toHaveLength(1);
    expect(writerSees(db)).toBe(0);
    expect(writerSees(db, Date.now() + OBSERVED_QUARANTINE_MS + 60_000)).toBe(1);
    expect(db.prepare("SELECT trust, origin FROM lane_pilot_memory").get()).toEqual({ trust: "observed", origin: "session" });
  });

  it("the same note from another source corroborates it", async () => {
    const { db, rpc } = setup();
    const content = "Greeting-card pages live in components/greeting-cards.";
    await rpc.session_memory_write({ projectId: "P", kind: "note", content, concepts: ["greeting-cards"], source: "cli mini" });
    const again = await rpc.session_memory_write({ projectId: "P", kind: "note", content, concepts: ["greeting-cards"], source: "cli ovh" });
    expect(again).toMatchObject({ stored: false, reason: "corroborated" });
    expect(writerSees(db)).toBe(1);
  });

  it("the maintainer's record is trusted at once", () => {
    const db = newDb();
    storeMemoryRecords(db, { projectId: "P", ...limits, coreBudget: 99, noteBudget: 99, indexBudget: 999, entries: [note("Greeting-card pages live in components/greeting-cards.", ["greeting-cards"])] });
    expect(writerSees(db)).toBe(1);
  });
});
