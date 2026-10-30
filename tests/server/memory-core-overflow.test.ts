import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { coreShelf, memoryMaintenancePrompt, memoryRecordId, parseMemoryCandidates, parseMemorySettings, storeMemoryRecords, storeMemoryRecordsKeepingOverflow } from "../../packages/memory-core/src";

/**
 * Hub 2026-10-27/28: lp.after-accept went red when the project's core was already full.
 * The store counts active core plus the new core entries and throws; the parser throws the same
 * error when the batch's own core exceeds the budget. Both used to refuse the whole batch.
 */
const settings = parseMemorySettings({});
const base = { projectId: "P", audience: "subagent" as const, sourceSha256: "a".repeat(64), coreBudget: 3072, noteBudget: 24000, indexBudget: 65536 };

function fullCore() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  const entries = [
    ...Array.from({ length: 30 }, (_, index) => ({ kind: "core" as const, content: `Convention ${String(index).padStart(2, "0")} `.padEnd(400, "x"), concepts: ["convention"] })),
    { kind: "core" as const, content: "Last convention ".padEnd(280, "y"), concepts: ["convention"] },
  ];
  storeMemoryRecords(db, { ...base, sourceSha256: "b".repeat(64), entries, coreBudget: 1_000_000 });
  return db;
}

describe("a full project core no longer refuses the maintainer batch", () => {
  it("still refuses a core entry at the raw door when the corpus is full", () => {
    const db = fullCore();
    expect(coreShelf(db, base.projectId, "", "subagent").tokens).toBe(3070);
    const entries = [{ kind: "core" as const, content: "x".repeat(260), concepts: ["convention"] }];
    expect(() => storeMemoryRecords(db, { ...base, entries })).toThrow("memory core budget exceeded: 3135/3072 tokens");
  });

  it("stores a core entry that does not fit as a note and keeps the curated core", () => {
    const db = fullCore();
    const note = { kind: "note" as const, content: "A note about src/rooms/memory/memory.ts that still fits.", concepts: ["memory"] };
    const core = { kind: "core" as const, content: "x".repeat(260), concepts: ["convention"] };
    const stored = storeMemoryRecordsKeepingOverflow(db, { ...base, entries: [note, core] });
    expect(stored.demoted).toBe(1);
    expect(stored.entries.map((entry) => entry.kind)).toEqual(["note", "note"]);
    expect(stored.insertedIds).toHaveLength(2);
    for (const entry of stored.entries) expect(stored.insertedIds).toContain(memoryRecordId(base.projectId, entry.kind, entry.content));
    expect(coreShelf(db, base.projectId, "", "subagent").tokens).toBe(3070);
  });

  it("does not let the parser refuse a batch whose own core exceeds the core budget", () => {
    const tight = parseMemorySettings({ "memory.core_budget": 20, "memory.note_budget": 500, "memory.index_budget": 500 });
    const content = "word ".repeat(40);
    expect(parseMemoryCandidates([{ kind: "core", content, concepts: [] }], tight)[0]?.kind).toBe("core");
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const stored = storeMemoryRecordsKeepingOverflow(db, {
      projectId: "P", audience: "subagent", sourceSha256: "c".repeat(64),
      entries: [{ kind: "core", content, concepts: [] }],
      coreBudget: tight.coreBudget, noteBudget: tight.noteBudget, indexBudget: tight.indexBudget,
    });
    expect(stored.demoted).toBe(1);
    expect(stored.entries[0]?.kind).toBe("note");
  });

  it("still refuses a batch that does not fit the note budget", () => {
    const db = fullCore();
    expect(() => storeMemoryRecordsKeepingOverflow(db, { ...base, noteBudget: 1, entries: [{ kind: "note", content: "word ".repeat(50), concepts: [] }] })).toThrow("note budget");
  });

  it("reads a review flag and an empty extra, and still refuses a key that carries a value", () => {
    const entries = parseMemoryCandidates([{ kind: "note", content: "Check the door.", concepts: ["memory"], review: true, concepts_extra: [] }], settings);
    expect(entries[0]?.concepts).toContain("review");
    expect(() => parseMemoryCandidates([{ kind: "note", content: "x y z", concepts: [], audience: "pm" }], settings)).toThrow("unsupported fields");
  });

  it("tells the maintainer how full the core is", () => {
    const db = fullCore();
    const { tokens, replaceable } = coreShelf(db, base.projectId, "", "subagent");
    const prompt = memoryMaintenancePrompt({ task: {}, acceptedResult: {}, settings, core: { tokens, records: replaceable } });
    expect(prompt).toContain("CORE holds 3070 of 3072 tokens now");
    expect(prompt).toContain(replaceable[0]!.id.slice(0, 12));
    expect(memoryMaintenancePrompt({ task: {}, acceptedResult: {}, settings })).not.toContain("CORE holds");
  });

  it("tells the maintainer to keep a date and a version verbatim", () => {
    expect(memoryMaintenancePrompt({ task: {}, acceptedResult: {}, settings })).toContain("Keep a date, a version number and a deadline verbatim");
  });
});
