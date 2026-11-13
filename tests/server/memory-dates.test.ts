import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import { isHistoryQuery, memoryContext, memoryContextLine, parseMemorySettings, storeMemoryRecords, type MemoryRecord } from "../../packages/memory-core/src";
import { memoryLine } from "../../src/rooms/memory/server/memory-picks";
import { pmMemoryContext } from "../../src/rooms/memory/server/memory-mix";

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const rec = (id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({ id, projectId: "P", personalBot: "", kind: "note", content, concepts: ["labels", "limits"], sourceSha256: "s", createdAt: day("2026-11-01"), ...over });

describe("dates in the packed context", () => {
  it("every pack line carries the day the fact began to hold: valid_from, else created_at", () => {
    expect(memoryContextLine(rec("a", "Labels are 4x6."))).toBe("- [note; 2026-11-01; concepts=labels, limits] Labels are 4x6.");
    expect(memoryContextLine(rec("a", "Labels are 4x6.", { validFrom: day("2026-10-02") }))).toContain("[note; 2026-10-02;");
  });

  it("a replaced version shows its interval, from..until", () => {
    const old = rec("old", "Parcels over 25 kilograms are rejected.", { status: "superseded", validFrom: day("2026-09-01"), supersededAt: day("2026-11-05") });
    expect(memoryContextLine(old)).toBe("- [note; replaced; 2026-09-01..2026-11-05; concepts=labels, limits] Parcels over 25 kilograms are rejected.");
  });

  it("records of one topic come oldest first, whatever order the ranking gave them", () => {
    const newer = rec("new", "Parcels over 30 kilograms are rejected by the label service.", { createdAt: day("2026-11-05") });
    const older = rec("old", "Parcels over 25 kilograms are rejected by the label service.", { status: "superseded", supersededBy: "new", createdAt: day("2026-09-01"), supersededAt: day("2026-11-05") });
    const other = rec("other", "The dashboard refresh interval is ten seconds.", { concepts: ["dashboard"], createdAt: day("2026-10-01") });
    const packed = memoryContext([newer, other, older], "parcels kilograms rejected label service dashboard refresh interval", 1000);
    expect(packed.records.map((r) => r.id)).toEqual(["old", "new", "other"]);
    expect(packed.text.split("\n")[0]).toContain("replaced; 2026-09-01..2026-11-05");
  });

  it("the dates stay inside the token budget the lines are counted against", () => {
    const many = Array.from({ length: 30 }, (_, index) => rec(`r${index}`, `Fact number ${index} about the shipping tracker parcels and labels.`, { concepts: [`c${index}`] }));
    const packed = memoryContext(many, "shipping tracker parcels labels fact", 120);
    expect(packed.estimatedTokens).toBeLessThanOrEqual(120);
    expect(packed.records.length).toBeGreaterThan(0);
  });

  it("a writer brief line carries the date too", () => {
    expect(memoryLine({ content: "Labels are 4x6.", createdAt: day("2026-11-01") })).toBe("- [2026-11-01] Labels are 4x6.");
    expect(memoryLine({ content: "Labels are 4x6." })).toBe("- Labels are 4x6.");
  });
});

describe("a history query shows the replaced version, any other question does not", () => {
  const seed = () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const limits = { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 999, noteBudget: 99_999, indexBudget: 99_999 };
    const [old] = storeMemoryRecords(db, { ...limits, now: day("2026-09-01"), entries: [{ kind: "note", content: "Parcels over 25 kilograms are rejected by the label service in services/labels/limits.ts.", concepts: ["labels", "limits"] }] }).insertedIds;
    storeMemoryRecords(db, { ...limits, now: day("2026-11-05"), entries: [{ kind: "note", content: "Parcels over 30 kilograms are rejected by the label service in services/labels/limits.ts.", concepts: ["labels", "limits"], supersedes: [old!.slice(0, 12)] }] });
    return db;
  };
  const ask = (db: ReturnType<typeof seed>, query: string) => pmMemoryContext(db, "P", parseMemorySettings({}), query, [], "pm", undefined, true).text;

  it("the history question carries both versions, dated, oldest first", () => {
    const text = ask(seed(), "What was the parcel weight limit of the label service before the change?");
    const lines = text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("replaced; 2026-09-01..2026-11-05");
    expect(lines[0]).toContain("25 kilograms");
    expect(lines[1]).toContain("[note; 2026-11-05;");
    expect(lines[1]).toContain("30 kilograms");
  });

  it("the current-fact question gets the new version alone", () => {
    const text = ask(seed(), "What is the heaviest parcel the label service rejects?");
    expect(text).toContain("30 kilograms");
    expect(text).not.toContain("25 kilograms");
  });
});

describe("isHistoryQuery", () => {
  it.each([
    "What did the cache TTL use to be?", "previous limit of the label service", "the history of the queue choice", "Какой лимит был раньше?", "что было до миграции", "до изменения лимита",
  ])("is a question about the past: %s", (query) => expect(isHistoryQuery(query)).toBe(true));
  it.each([
    "What is the heaviest parcel the label service accepts?", "Which key signs the partner API requests?", "Каков сейчас лимит запросов?",
  ])("is not: %s", (query) => expect(isHistoryQuery(query)).toBe(false));
});
