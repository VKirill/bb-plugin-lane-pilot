import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { roleContextBudget, storeMemoryRecords } from "../packages/memory-core/src";
import { pmMemoryContext } from "../src/rooms/memory/server/memory-mix";
import { openDatabase } from "../src/rooms/storage/database";

const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const settings = { enabled: true, maintain: true, inject: true, audience: "subagent" as const, personalBot: "", searchEngine: "auto" as const, coreBudget: 99, noteBudget: 99, indexBudget: 99, contextBudget: 2500, maintainEvery: 3 };

// X-1: one budget per role caps every memory layer together; the project can only narrow it.
describe("role context budgets", () => {
  it("caps each role at its target budget", () => {
    expect(roleContextBudget("pm", 2500)).toBe(1600);
    expect(roleContextBudget("writer", 2500)).toBe(1600);
    expect(roleContextBudget("critic", 2500)).toBe(1200);
    expect(roleContextBudget("helper", 2500)).toBe(600);
    expect(roleContextBudget("pm", 800)).toBe(800);
  });

  it("the PM context tool stops at the PM budget even with a wider project budget", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: Array.from({ length: 30 }, (_, index) => ({ kind: "note" as const, content: `deployment fact ${index} about port and gateway`, concepts: ["deployment"] })) });
    const packed = pmMemoryContext(db, "P", settings, "deployment port gateway", []);
    expect(packed.estimatedTokens).toBeLessThanOrEqual(1600);
    const helper = pmMemoryContext(db, "P", settings, "deployment port gateway", [], "helper");
    expect(helper.estimatedTokens).toBeLessThanOrEqual(600);
  });
});
