import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { parseMemoryCandidates, searchMemoryRecords, storeMemoryRecords } from "../packages/memory-core/src";
import { openDatabase } from "../src/rooms/storage/database";

const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };

// X-3: a fact keeps the date it began to hold, distinct from the write and expiry times.
describe("valid_from (Graphiti-style validity window)", () => {
  it("stores an explicit valid_from and defaults to the write time", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const now = Date.parse("2026-10-30T12:00:00Z");
    const result = storeMemoryRecords(db, { projectId: "P", ...limits, now, entries: [
      { kind: "note", content: "The migration window opened 2026-10-01.", concepts: ["migration"], validFrom: Date.parse("2026-10-01T00:00:00Z") },
      { kind: "note", content: "Writers get at most three notes.", concepts: ["writer"] },
    ] });
    const found = searchMemoryRecords(db, "P", "migration writers", 10, "auto", "subagent", "", {});
    const byContent = new Map(found.map((row) => [row.content, row.validFrom]));
    expect(byContent.get("The migration window opened 2026-10-01.")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(byContent.get("Writers get at most three notes.")).toBe(now);
    expect(result.insertedIds).toHaveLength(2);
  });

  it("parses valid_from like valid_until", () => {
    const entries = parseMemoryCandidates([{ kind: "note", content: "Fact since March.", concepts: [], valid_from: "2026-03-01" }], { ...limits, contextBudget: 100 } as never);
    expect(entries[0]!.validFrom).toBe(Date.parse("2026-03-01"));
    expect(() => parseMemoryCandidates([{ kind: "note", content: "Bad.", concepts: [], valid_from: "soon" }], { ...limits, contextBudget: 100 } as never)).toThrow(/valid_from/);
  });
});
