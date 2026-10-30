import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { storeMemoryRecords } from "../../packages/memory-core/src";

const limits = { projectId: "P", audience: "subagent" as const, sourceSha256: "a".repeat(64), coreBudget: 999, noteBudget: 9_999, indexBudget: 99_999, origin: "agentmemory" };

describe("agentmemory writes", () => {
  const db = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);

  it("rejects a core and a rule, and keeps an observation note", () => {
    const core = db();
    expect(() => storeMemoryRecords(core, { ...limits, entries: [{ kind: "core", content: "Writers keep one port per service.", concepts: ["convention"] }] })).toThrow(/not written by agentmemory/);
    expect(core.prepare("SELECT count(*) AS n FROM lane_pilot_memory").get()).toEqual({ n: 0 });
    const rule = db();
    expect(() => storeMemoryRecords(rule, { ...limits, entries: [{ kind: "note", content: "Run npm ci, never npm install.", concepts: ["rule"] }] })).toThrow(/rules pipeline/);
    const note = db();
    expect(storeMemoryRecords(note, { ...limits, entries: [{ kind: "note", content: "The session ran the typecheck.", concepts: ["session"] }] }).insertedIds).toHaveLength(1);
  });
});
