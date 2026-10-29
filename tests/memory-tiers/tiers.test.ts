import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { searchMemoryRecords, storeMemoryRecords } from "../../packages/memory-core/src";
import { queryWords } from "../../src/rooms/memory-tiers";
import { enrichMemoryContext, tierReport } from "../../src/rooms/memory-tiers/server";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/storage/database";

const NOW = Date.parse("2026-10-23T10:00:00Z");
const DAY = 86_400_000;
const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };

function world() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  // A note written 100 days ago that nobody was given: the next write expires it for idleness (the cold tier).
  storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: "Greeting cards render their share button through components/cards/share.ts", concepts: ["cards", "share"] }], now: NOW - 100 * DAY });
  storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: "Billing exports run at midnight", concepts: ["billing"] }], now: NOW - DAY });
  createRun(db, "run1", "P", "cli", "/repo");
  createTask(db, { id: "cards-share", runId: "run1", kind: "bb", contract: { title: "Share button on greeting cards", objective: "Add share for cards" } as never });
  createAttempt(db, { id: "a1", runId: "run1", taskId: "cards-share" });
  transitionAttempt(db, "a1", "spawn_requested");
  transitionAttempt(db, "a1", "running", { threadId: "thr_w" });
  transitionAttempt(db, "a1", "validation_failed", { reason: "verification failed (npm test): share link missing" });
  return db;
}

describe("memory tiers around the PM's query", () => {
  it("matches the query's own words, not the stop words", () => {
    expect(queryWords("How do the greeting cards share? share")).toEqual(["greeting", "cards", "share"]);
  });

  it("returns a cold candidate without reactivating it, adds past tasks like this one, and records nothing as a miss", () => {
    const db = world();
    expect(db.prepare("SELECT status, expired_reason FROM lane_pilot_memory WHERE content LIKE 'Greeting%'").get()).toEqual({ status: "expired", expired_reason: "idle" });
    const result = enrichMemoryContext(db, { projectId: "P", query: "greeting cards share button", activeCount: 0, now: NOW });
    expect(result.promoted).toHaveLength(1);
    expect(result.text).toContain("cold tier");
    expect(result.text).toContain("Greeting cards render their share button");
    expect(result.text).toContain("cards-share «Share button on greeting cards»");
    expect(result.text).toContain("validation_failed — verification failed (npm test): share link missing");
    expect(result.miss).toBe(false);
    expect(db.prepare("SELECT status FROM lane_pilot_memory WHERE content LIKE 'Greeting%'").get()).toEqual({ status: "expired" });
    expect(searchMemoryRecords(db, "P", "greeting cards share", 5, "auto", "subagent", "").map((row) => row.content)).not.toContain("Greeting cards render their share button through components/cards/share.ts");
    expect(tierReport(db, "P", NOW)).toMatchObject({ cold: 1, promoted: 0, misses: [] });
  });

  it("does not search the cold tier when enough active notes answer, and a query that finds nothing anywhere is a miss", () => {
    const db = world();
    expect(enrichMemoryContext(db, { projectId: "P", query: "greeting cards share button", activeCount: 5, now: NOW }).promoted).toEqual([]);
    const miss = enrichMemoryContext(db, { projectId: "P", query: "kubernetes ingress certificates", activeCount: 0, now: NOW });
    expect(miss).toMatchObject({ text: "", miss: true });
    expect(tierReport(db, undefined, NOW)).toMatchObject({ cold: 1, promoted: 0, misses: [{ projectId: "P", query: "kubernetes ingress certificates" }] });
  });
});
