import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/storage/database";
import { DEFAULT_RELEVANCE_FLOOR, NOTHING_RELEVANT, floorThreshold, pathAnchorsOf, questionWords, relevantRecords, searchMemoryRecords, storeMemoryRecords } from "../packages/memory-core/src";
import type { MemoryCandidate, MemoryDatabase } from "../packages/memory-core/src";
import { pmMemoryContext } from "../src/rooms/memory/server/memory-mix";
import { sessionMemoryRpc } from "../src/rooms/memory/server/session-memory";
import { parseMemorySettings } from "../packages/memory-core/src";
import type { ServerCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";

// SMA block 4 (P2-7 finding): the query paths returned something for 80-90 % of the questions memory cannot answer.
const newHost = () => createFakePluginHost({ pluginId: "lane-pilot" });
const put = (db: MemoryDatabase, entries: MemoryCandidate[]) =>
  storeMemoryRecords(db, { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent", coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999, trust: "confirmed", entries }).insertedIds;
const note = (content: string, concepts: string[] = ["area"]): MemoryCandidate => ({ kind: "note", content, concepts });

/** Forty notes about a billing service, each with the same filler words, so that «invoice» and «ledger» are uncommon and «service» is not. */
function billingMemory() {
  const host = newHost();
  const db = openDatabase(host.bb);
  const entries = Array.from({ length: 40 }, (_, n) => note(`The billing service keeps its state in a store module ${n}; the handler validates input before the store is touched.`));
  entries.push(note("Invoice rounding lives in apps/billing/ledger/rounding.ts: the ledger rounds half to even before the invoice total is stored."));
  entries.push(note("Refund webhooks for the invoice provider are signed with a rotating secret named in the ledger settings."));
  put(db, entries);
  return { db, bb: host.bb };
}
const longQuestion = "Change how the invoice total is rounded in the ledger so that half cents go to the even cent, keep the stored invoice total unchanged for old orders and add a regression check for the ledger rounding of refunds";

describe("the relevance floor of the query paths", () => {
  it("keeps the notes a question shares uncommon words with", () => {
    const { db } = billingMemory();
    const found = searchMemoryRecords(db, "P", longQuestion, 100, "auto");
    const kept = relevantRecords(db, "P", longQuestion, found);
    expect(kept.map((record) => record.content)).toEqual(expect.arrayContaining([expect.stringContaining("Invoice rounding lives in")]));
  });

  it("returns nothing for a long question about something else, where the old behaviour returned the nearest notes", () => {
    const { db } = billingMemory();
    const other = "Show a three day weather forecast with wind and tide tables for the harbour webcam page, keep the service responsive on mobile and store the chosen harbour in the store";
    const found = searchMemoryRecords(db, "P", other, 100, "auto");
    expect(found.length).toBeGreaterThan(0); // «service», «store» and «page» match many notes
    expect(relevantRecords(db, "P", other, found)).toEqual([]);
    expect(relevantRecords(db, "P", other, found, { floor: null })).toHaveLength(found.length);
  });

  it("lets a note through that names a path written in the question, whatever its words weigh", () => {
    const { db } = billingMemory();
    const query = "What is in apps/billing/ledger/rounding.ts? service store module handler validates input before the store is touched";
    expect(pathAnchorsOf(query)).toContain("ledger/rounding.ts");
    const found = searchMemoryRecords(db, "P", query, 100, "auto");
    expect(relevantRecords(db, "P", query, found).some((record) => record.content.includes("rounding.ts"))).toBe(true);
  });

  it("does not starve a short question: a question of a dozen words or fewer keeps what the search finds", () => {
    const { db } = billingMemory();
    const query = "billing service store";
    expect(questionWords(query)).toBeLessThanOrEqual(DEFAULT_RELEVANCE_FLOOR.shortWords);
    const found = searchMemoryRecords(db, "P", query, 100, "auto");
    expect(relevantRecords(db, "P", query, found)).toHaveLength(found.length);
  });

  it("moves the threshold in a straight line between the short and the long length", () => {
    const floor = { ...DEFAULT_RELEVANCE_FLOOR, minScore: 2, minScoreShort: 0, shortWords: 10, longWords: 20 };
    expect(floorThreshold(floor, 5)).toBe(0);
    expect(floorThreshold(floor, 15)).toBeCloseTo(1);
    expect(floorThreshold(floor, 80)).toBe(2);
  });

  it("an empty memory and a query with no words give nothing, not an error", () => {
    const db = openDatabase(newHost().bb);
    expect(relevantRecords(db, "P", "anything at all", [])).toEqual([]);
    expect(relevantRecords(db, "P", "", searchMemoryRecords(db, "P", "", 10, "auto"))).toEqual([]);
  });
});

describe("what the agent is told", () => {
  it("the PM tool packet says there is nothing, in words, and keeps its old fields", () => {
    const { db } = billingMemory();
    const settings = parseMemorySettings({});
    const none = pmMemoryContext(db, "P", settings, "Show a three day weather forecast with wind and tide tables for the harbour webcam page, keep the service responsive on mobile and store the chosen harbour in the store");
    expect(none).toMatchObject({ text: "", records: [], estimatedTokens: 0, nothingRelevant: true });
    const some = pmMemoryContext(db, "P", settings, longQuestion);
    expect(some.nothingRelevant).toBe(false);
    expect(some.text).toContain("Invoice rounding");
    // The old behaviour stays reachable.
    expect(pmMemoryContext(db, "P", settings, "Show a three day weather forecast with wind and tide tables for the harbour webcam page, keep the service responsive on mobile and store the chosen harbour in the store", null).records.length).toBeGreaterThan(0);
  });

  it("session_memory_search adds nothingRelevant and a message only when nothing clears, and its records field is unchanged", async () => {
    const { db, bb } = billingMemory();
    const rpc = sessionMemoryRpc({ bb, db } as unknown as ServerCore, {} as unknown as Services);
    const hit = await rpc.session_memory_search({ projectId: "P", query: longQuestion });
    expect(hit.records.some((record) => record.content.includes("Invoice rounding"))).toBe(true);
    expect(hit).not.toHaveProperty("nothingRelevant");
    const none = await rpc.session_memory_search({ projectId: "P", query: "Show a three day weather forecast with wind and tide tables for the harbour webcam page, keep the service responsive on mobile and store the chosen harbour in the store" });
    expect(none).toEqual({ records: [], nothingRelevant: true, message: NOTHING_RELEVANT });
    expect(NOTHING_RELEVANT).toMatch(/nothing relevant/i);
  });

  it("the limit still holds after the floor", async () => {
    const { db, bb } = billingMemory();
    const rpc = sessionMemoryRpc({ bb, db } as unknown as ServerCore, {} as unknown as Services);
    expect((await rpc.session_memory_search({ projectId: "P", query: "billing service store", limit: 3 })).records).toHaveLength(3);
  });
});
