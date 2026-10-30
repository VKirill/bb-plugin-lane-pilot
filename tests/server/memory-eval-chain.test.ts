import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { storeMemoryRecords } from "../../packages/memory-core/src";
import type { CorpusNote } from "../../src/rooms/memory-eval/server/corpus";
import { createRetrievers } from "../../src/rooms/memory-eval/server/retrievers";
import type { EvalQuestion } from "../../src/rooms/memory-eval/server/questions";

const limits = { projectId: "P", audience: "subagent" as const, sourceSha256: "a".repeat(64), coreBudget: 999, noteBudget: 9_999, indexBudget: 99_999 };

function corpus(id: string, content: string, sections: string[]): CorpusNote {
  return { id, projectId: "P", kind: "note", content, concepts: ["port"], createdAt: 1, status: "active", trust: "confirmed", origin: "eval", useCount: 0, acceptedCount: 0, sections, audience: "subagent", personalBot: "", synthetic: false, scope: "P" };
}

describe("eval retrieval chain", () => {
  it("does not return a sibling section's note", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const homeText = "The home port is 3000 in src/home/port.ts.";
    const siblingText = "The sibling port is 4000 in src/home/port.ts.";
    const home = storeMemoryRecords(db, { ...limits, scope: ["section:home"], entries: [{ kind: "note", content: homeText, concepts: ["port"] }] }).insertedIds[0]!;
    const sibling = storeMemoryRecords(db, { ...limits, scope: ["section:other"], entries: [{ kind: "note", content: siblingText, concepts: ["port"] }] }).insertedIds[0]!;
    const question = { scope: "P", query: "home port", paths: { owns_paths: ["src/home/port.ts"], read_first: [] }, chain: ["section:home"] } as EvalQuestion;
    const writer = createRetrievers(db, [corpus(home, homeText, ["section:home"]), corpus(sibling, siblingText, ["section:other"])]).find((item) => item.id === "writer")!;
    expect(writer.run(question, new Set()).ids).toEqual([home]);
  });
});
