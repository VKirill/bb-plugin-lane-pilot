import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { listMemory, scopeValuesFor, searchMemoryRecords, storeMemoryRecords } from "../packages/memory-core/src";
import { openDatabase } from "../src/rooms/storage/database";
import { createDigest } from "../src/rooms/learning/digest";
import { insertItem, type Item } from "../src/rooms/learning/store";

/**
 * «Мои проекты» holds several games and FeedGen in one BB project: what one section learned (a decision about Roblox characters)
 * reached the others' PMs and writers (2026-10-23). Memory now carries the sections it belongs to, and a reader sees the project's
 * records and its own sections', never a sibling's.
 */
const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const ROBLOX = ["section:roblox"], VAMPIRE = ["section:roblox", "section:vampirism"], FEEDGEN = ["section:feedgen"];

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const put = (content: string, scope?: string[]) => storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content, concepts: ["decision"] }], ...(scope ? { scope } : {}) }).insertedIds[0]!;
  return { db, put };
}

describe("memory of a section", () => {
  it("a reader sees the whole project's records and its own sections', never a sibling section's", () => {
    const { db, put } = setup();
    put("Decision: deploy images through the CDN");
    put("Decision: characters are built procedurally from references", ROBLOX);
    put("Decision: the vampire clock starts at 18:00", VAMPIRE);
    put("Decision: product photos are cached for a week", FEEDGEN);
    const read = (chain?: string[]) => searchMemoryRecords(db, "P", "decision", 20, "auto", "subagent", "", chain ? { chain } : {}).map((row) => row.content).sort();
    expect(read(VAMPIRE)).toEqual(["Decision: characters are built procedurally from references", "Decision: deploy images through the CDN", "Decision: the vampire clock starts at 18:00"]);
    expect(read(FEEDGEN)).toEqual(["Decision: deploy images through the CDN", "Decision: product photos are cached for a week"]);
    expect(read([])).toEqual(["Decision: deploy images through the CDN"]);
    expect(read()).toEqual(["Decision: deploy images through the CDN"]);
    expect(listMemory(db, "P", { kind: "note" }, 20, "subagent", "", { chain: FEEDGEN }).map((row) => row.content)).not.toContain("Decision: the vampire clock starts at 18:00");
    expect(scopeValuesFor(VAMPIRE)).toEqual(["[]", '["section:roblox"]', '["section:roblox","section:vampirism"]']);
  });
});

describe("the learning report", () => {
  const item = (id: string, threadId: string): Item => ({ id, obsId: `${threadId}:1:0`, projectId: "P", threadId, kind: "decision", text: `Decision ${id}`, audience: null,
    reach: "project", dueAt: null, state: "noted", target: null, evidence: `owner message ${threadId}:1:0`, duplicateOf: null, confirmations: 0, note: null,
    createdAt: 1, decidedAt: null, announcedAt: null });

  it("goes to the PM of the section the owner said it in, and wakes no other PM when that section has none", async () => {
    const { db } = setup();
    insertItem(db as never, item("a", "thr_roblox_chat"));
    insertItem(db as never, item("b", "thr_feedgen_chat"));
    const sent: Array<[string, string]> = [];
    const digest = createDigest({ db: db as never, pmThread: () => "thr_latest_pm", send: async (thread, text) => { sent.push([thread, text]); },
      pmThreadFor: async (row) => (row.threadId === "thr_feedgen_chat" ? "thr_feedgen_pm" : null) });
    const out = await digest.run();
    expect(sent.map(([thread]) => thread)).toEqual(["thr_feedgen_pm"]);
    expect(sent[0]![1]).toContain("Decision b");
    expect(out.find((row) => !row.sent)?.items).toBe(1);
  });
});
