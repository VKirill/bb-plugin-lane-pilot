import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import { sessionMemoryRpc } from "../../src/rooms/memory/server/handlers/session-memory";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";

function setup() {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ projects:{ list:async () => [{ id:"P" }, { id:"Q" }] } } as never });
  const db = openDatabase(bb);
  const services = { docsPlaces: async (projectId:string) => projectId === "P"
    ? [{ hostId:"ovh", path:"/home/u/apps/selfy", scopes:[] }, { hostId:"ovh", path:"/home/u/apps/selfy/apps/bot", scopes:["section:bot"] }]
    : [{ hostId:"mini", path:"/Users/k/Documents/BB", scopes:[] }] } as unknown as Services;
  return { db, rpc:sessionMemoryRpc({ bb, db } as unknown as ServerCore, services) };
}

describe("session memory on the hub", () => {
  it("finds the project and the deepest section of a folder on a machine", async () => {
    const { rpc } = setup();
    expect(await rpc.session_memory_project({ hostId:"ovh", path:"/home/u/apps/selfy/apps/bot/src" })).toEqual({ projectId:"P", scopes:["section:bot"] });
    expect(await rpc.session_memory_project({ hostId:"ovh", path:"/home/u/apps/selfy" })).toEqual({ projectId:"P", scopes:[] });
    expect(await rpc.session_memory_project({ hostId:"mini", path:"/home/u/apps/selfy" })).toEqual({ projectId:null, scopes:[] });
  });

  it("writes through the hub's door, finds the record from any machine, and refuses secrets", async () => {
    const { db, rpc } = setup();
    expect(await rpc.session_memory_write({ projectId:"P", kind:"note", content:"Greeting-card pages live in components/greeting-cards.", concepts:["greeting-cards"], source:"cli mini" }))
      .toMatchObject({ stored:true });
    expect((await rpc.session_memory_search({ projectId:"P", query:"greeting-cards pages" })).records).toHaveLength(1);
    expect(await rpc.session_memory_write({ projectId:"P", kind:"core", content:"token ghp_" + "a".repeat(30), concepts:["x"] })).toMatchObject({ stored:false, reason:expect.stringMatching(/credential/) });
    await rpc.session_memory_write({ projectId:"P", kind:"core", content:"Ship only from the PM chat.", concepts:["ship"] });
    expect((await rpc.session_memory_core({ projectId:"P" })).records).toEqual([]);
    db.prepare("UPDATE lane_pilot_memory SET trust='confirmed' WHERE content='Ship only from the PM chat.'").run();
    expect((await rpc.session_memory_core({ projectId:"P" })).records.map((row) => row.content)).toEqual(["Ship only from the PM chat."]);
  });

  it("gives the proven CORE facts first, so a client keeping only its byte budget keeps the useful ones", async () => {
    const { rpc, db } = setup();
    await rpc.session_memory_write({ projectId:"P", kind:"core", content:"Old fact nobody uses.", concepts:["old"] });
    await rpc.session_memory_write({ projectId:"P", kind:"core", content:"Proven fact writers accept.", concepts:["proven"] });
    db.prepare("UPDATE lane_pilot_memory SET trust='confirmed', accepted_count=5, use_count=9 WHERE content='Proven fact writers accept.'").run();
    db.prepare("UPDATE lane_pilot_memory SET trust='confirmed' WHERE content='Old fact nobody uses.'").run();
    expect((await rpc.session_memory_core({ projectId:"P" })).records.map((row) => row.content)).toEqual(["Proven fact writers accept.", "Old fact nobody uses."]);
  });

  it("evaluates an import receipt through the actual memory_import_eval RPC", async () => {
    const { db, rpc } = setup();
    const stored = await rpc.session_memory_write({ projectId:"P", kind:"note", content:"Deploy staging safely after review.", concepts:["deploy"], source:"import-eval" });
    expect(stored).toMatchObject({ stored:true, id:expect.any(String) });
    db.prepare("UPDATE lane_pilot_memory SET trust='confirmed' WHERE id=?").run(stored.id);
    const result = await rpc.memory_import_eval({ report: {
      source: "bb-memory", projectId: "P", generatedAt: 1, dryRun: false,
      counts: { added: 1, merged_with: 0, dropped: 0 }, byReason: {}, evictedIds: [], archivedIds: [], heldIds: [],
      outcomes: [{ line: 1, source_id: "import-1", outcome: "added", id: stored.id!, concepts:["deploy"], content: "Deploy staging safely after review." }],
    } });
    expect(result).toMatchObject({ projectId: "P", source: "bb-memory", questions: 1, hits: 1, silentQuestions: 10 });
    const missing = await rpc.memory_import_eval({ report: {
      source: "bb-memory", projectId: "P", generatedAt: 1, dryRun: false,
      counts: { added: 1, merged_with: 0, dropped: 0 }, byReason: {}, evictedIds: [], archivedIds: [], heldIds: [],
      outcomes: [{ line: 2, source_id: "missing", outcome: "added", id: "missing-id", concepts:["deploy"], content: "Deploy staging safely after review." }],
    } });
    expect(missing).toMatchObject({ questions: 1, hits: 0 });
  });
});
