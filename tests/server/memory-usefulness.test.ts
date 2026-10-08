import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, createTask, openDatabase, saveReasoningTrace, transitionAttempt } from "../../src/database";
import { memoryContext, memoryUsefulness, recordMemoryMixed, searchMemoryRecords, storeMemoryRecords } from "../../packages/memory-core/src";
import type { MemoryRecord } from "../../packages/memory-core/src";
import { writerMemory } from "../../src/writer-brief";
import { mixWriterMemory } from "../../src/server/memory-mix";

type Db = ReturnType<typeof openDatabase>;
const newDb = (): Db => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 999, noteBudget: 9_999, indexBudget: 99_999 };
const task = { owns_paths: ["components/greeting-cards/**"], read_first: [] };
const put = (db: Db, contents: string[]) => storeMemoryRecords(db, { projectId: "P", ...limits, entries: contents.map((content, index) => ({ kind: "note" as const, content, concepts: [`c${index}`] })) }).insertedIds;
const counts = (db: Db, id: string) => db.prepare("SELECT use_count AS u, accepted_count AS a, last_used_at AS at FROM lane_pilot_memory WHERE id=?").get(id) as { u: number; a: number; at: number | null };

describe("K8 usefulness: how often a note was mixed into a brief, and how often that attempt was accepted", () => {
  it("counts a mix with its time", () => {
    const db = newDb();
    const [id] = put(db, ["Cards live in components/greeting-cards"]);
    recordMemoryMixed(db, "P", [id!, id!], 5_000);
    expect(counts(db, id!)).toEqual({ u: 1, a: 0, at: 5_000 });
  });

  it("an accepted attempt counts for every note in its brief, once", () => {
    const db = newDb();
    const [used, other] = put(db, ["Cards live in components/greeting-cards", "Unrelated note about billing"]);
    createRun(db, "run", "P", "bb", "/w");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: { id: "t1" } as never });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    saveReasoningTrace(db, { attemptId: "a1", runId: "run", threadId: "thr", providerId: "p", model: "m", effectiveReasoningLevel: "high", serviceTier: null,
      dispatchContext: { memoryText: "x", memoryPicked: [used!], executionPacket: "", executionPacketSha256: "", pmReadContext: "", agent: "w", helperMode: "inherit", helperRequired: false } } as never);
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr" });
    expect(counts(db, used!).a).toBe(0);
    transitionAttempt(db, "a1", "accepted");
    transitionAttempt(db, "a1", "accepted");
    expect(counts(db, used!).a).toBe(1);
    expect(counts(db, other!).a).toBe(0);
  });

  it("a rejected attempt counts as a use only, never as an acceptance", () => {
    const db = newDb();
    const [id] = put(db, ["Cards live in components/greeting-cards"]);
    recordMemoryMixed(db, "P", [id!]);
    expect(counts(db, id!)).toMatchObject({ u: 1, a: 0 });
    expect(memoryUsefulness({ useCount: 1, acceptedCount: 0 })).toBeLessThan(memoryUsefulness({}));
    expect(memoryUsefulness({ useCount: 4, acceptedCount: 4 })).toBeGreaterThan(memoryUsefulness({}));
  });

  const rec = (id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({ id, projectId: "P", personalBot: "", kind: "note", content, concepts: [], sourceSha256: "s", createdAt: 1, ...over });

  it("ranks the note that served accepted attempts first among those about the task's paths", () => {
    const notes = ["one", "two", "three", "four"].map((word, index) => rec(`id${index}`, `The ${word} fact about components/greeting-cards`, index === 3 ? { useCount: 6, acceptedCount: 6 } : index === 0 ? { useCount: 6, acceptedCount: 0 } : {}));
    const text = writerMemory(notes, task);
    expect(text.split("\n")[0]).toContain("four fact");
    expect(text).not.toContain("one fact");
  });

  it("ranks the PM and council context the same way", () => {
    const records = [rec("bad", "deploy staging checklist", { useCount: 8, acceptedCount: 0 }), rec("good", "deploy staging checklist", { useCount: 8, acceptedCount: 8 })];
    expect(memoryContext(records, "deploy staging checklist", 1000).records.map((row) => row.id)).toEqual(["good", "bad"]);
  });

  it("a writer mix returns the ids that went into the brief", () => {
    const db = newDb();
    const [id] = put(db, ["Cards live in components/greeting-cards"]);
    put(db, ["Nothing to do with the task at all"]);
    const mix = mixWriterMemory(db, { projectId: "P", query: "greeting cards page", task, searchEngine: "fts5", personalBot: "", ruleMemoryIds: new Set() });
    expect(mix.ids).toEqual([id]);
    expect(mix.text).toContain("components/greeting-cards");
    expect(searchMemoryRecords(db, "P", "greeting cards", 5, "fts5")[0]!.useCount).toBe(0);
  });
});
