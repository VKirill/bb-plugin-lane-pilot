import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { storeMemoryRecords } from "../../packages/memory-core/src";
import { mixWriterMemory } from "../../src/rooms/memory/server/memory-mix";

const limits = { projectId: "P", audience: "subagent" as const, sourceSha256: "a".repeat(64), coreBudget: 999, noteBudget: 9_999, indexBudget: 99_999 };
const task = { owns_paths: ["src/home/port.ts"], read_first: [] as string[] };

describe("a sibling section", () => {
  it("does not hand a sibling note to this section's writer", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const put = (content: string, scope: string[]) => storeMemoryRecords(db, { ...limits, scope, entries: [{ kind: "note", content, concepts: ["port"] }] });
    put("The home port is 3000 in src/home/port.ts.", ["section:home"]);
    put("The sibling port is 4000 in src/home/port.ts.", ["section:other"]);
    const mixed = mixWriterMemory(db, { projectId: "P", query: "port src/home/port.ts", task, searchEngine: "fts5", personalBot: "", ruleMemoryIds: new Set(), chain: ["section:home"] });
    expect(mixed.text).toContain("3000");
    expect(mixed.text).not.toContain("4000");
  });
});
