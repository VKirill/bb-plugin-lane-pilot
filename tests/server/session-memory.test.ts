import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { LESSON_PROPOSALS_MAX, listRuleProposals, upsertLessonProposal } from "@lane-pilot/run-insights";
import { sessionMemoryRpc } from "../../src/rooms/memory/server/session-memory";
import type { ServerCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";

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
    const { rpc } = setup();
    expect(await rpc.session_memory_write({ projectId:"P", kind:"note", content:"Greeting-card pages live in components/greeting-cards.", concepts:["greeting-cards"], source:"cli mini" }))
      .toMatchObject({ stored:true });
    expect((await rpc.session_memory_search({ projectId:"P", query:"greeting-cards pages" })).records).toHaveLength(1);
    expect(await rpc.session_memory_write({ projectId:"P", kind:"core", content:"token ghp_" + "a".repeat(30), concepts:["x"] })).toMatchObject({ stored:false, reason:expect.stringMatching(/credential/) });
    await rpc.session_memory_write({ projectId:"P", kind:"core", content:"Ship only from the PM chat.", concepts:["ship"] });
    expect((await rpc.session_memory_core({ projectId:"P" })).records.map((row) => row.content)).toEqual(["Ship only from the PM chat."]);
  });

  it("a lesson becomes a rule on trial; the same lesson again is a repeat, not a new rule", async () => {
    const { rpc, db } = setup();
    const first = await rpc.session_lesson({ projectId:"P", rule:"Run npm ci in a writer worktree, never npm install, the lockfile stays untouched", evidence:"owner corrected 2026-10-03" });
    expect(first).toMatchObject({ repeatOf:null, state:"accepted", adopted:true });
    const again = await rpc.session_lesson({ projectId:"P", rule:"In a writer worktree run npm ci, never npm install — the lockfile stays untouched" });
    expect(again).toMatchObject({ proposalId:first.proposalId, repeatOf:first.proposalId });
    expect(listRuleProposals(db, "P")).toHaveLength(1);
    expect(listRuleProposals(db, "P")[0]!.occurrences).toBe(2);
  });

  it("waiting lessons never pile up beyond the limit", () => {
    const { db } = setup();
    for (let n = 0; n < LESSON_PROPOSALS_MAX + 5; n++) upsertLessonProposal(db, "P", { rule:`Distinct lesson number ${n} about subsystem${n} configuration${n} handling${n}` }, 1000 + n);
    expect(listRuleProposals(db, "P", { state:"proposed", limit:500 })).toHaveLength(LESSON_PROPOSALS_MAX);
    expect(listRuleProposals(db, "P", { state:"rejected", limit:500 })).toHaveLength(5);
  });
});
