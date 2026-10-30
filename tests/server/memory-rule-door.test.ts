import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { storeMemoryRecords } from "../../packages/memory-core/src";

const limits = { projectId: "P", audience: "subagent" as const, sourceSha256: "a".repeat(64), coreBudget: 999, noteBudget: 9_999, indexBudget: 99_999 };
const rule = { kind: "core" as const, content: "Run npm ci, never npm install.", concepts: ["rule", "npm"] };

describe("a rule concept", () => {
  const db = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);

  it("rejects a maintainer write on the raw door, and accepts the rules pipeline", () => {
    const maintainer = db();
    expect(() => storeMemoryRecords(maintainer, { ...limits, entries: [rule] })).toThrow(/rules pipeline/);
    expect(maintainer.prepare("SELECT count(*) AS n FROM lane_pilot_memory").get()).toEqual({ n: 0 });
    const adopted = db();
    expect(storeMemoryRecords(adopted, { ...limits, origin: "rule", entries: [rule] }).insertedIds).toHaveLength(1);
  });
});
