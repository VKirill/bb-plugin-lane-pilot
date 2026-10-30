import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, createTask, openDatabase, saveReasoningTrace, transitionAttempt } from "../../src/rooms/storage/database";
import { storeMemoryRecords } from "../../packages/memory-core/src";
import { enrichMemoryContext } from "../../src/rooms/memory-tiers/server";

const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 999, noteBudget: 9_999, indexBudget: 99_999 };
const claim = "The share button always posts to the public feed without a login";
const other = "Billing exports run at midnight and never touch the share path";

describe("a failed check refutes only the note it quotes", () => {
  it("expires a brief note when the check failure quotes it, and leaves the other note", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const ids = storeMemoryRecords(db, { projectId: "P", ...limits, entries: [
      { kind: "note", content: claim, concepts: ["share"] },
      { kind: "note", content: other, concepts: ["billing"] },
    ] }).insertedIds;
    createRun(db, "run", "P", "bb", "/w");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: { id: "t1" } as never });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    saveReasoningTrace(db, { attemptId: "a1", runId: "run", threadId: "thr", providerId: "p", model: "m", effectiveReasoningLevel: "high", serviceTier: null,
      dispatchContext: { memoryText: claim, memoryPicked: ids, executionPacket: "", executionPacketSha256: "", pmReadContext: "", agent: "w", helperMode: "inherit", helperRequired: false } } as never);
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr" });
    transitionAttempt(db, "a1", "validation_failed", { reason: `verification failed (npm test): ${claim}` });
    const row = (content: string) => db.prepare("SELECT status, expired_reason FROM lane_pilot_memory WHERE content=?").get(content);
    expect(row(claim)).toEqual({ status: "expired", expired_reason: "refuted" });
    expect(row(other)).toEqual({ status: "active", expired_reason: null });
    expect(enrichMemoryContext(db, { projectId: "P", query: "share button public feed", activeCount: 0 }).text).not.toContain("public feed");
  });

  it("does not refute a brief note when the check failed without quoting it", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const [id] = storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: claim, concepts: ["share"] }] }).insertedIds;
    createRun(db, "run", "P", "bb", "/w");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: { id: "t1" } as never });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    saveReasoningTrace(db, { attemptId: "a1", runId: "run", threadId: "thr", providerId: "p", model: "m", effectiveReasoningLevel: "high", serviceTier: null,
      dispatchContext: { memoryText: claim, memoryPicked: [id!], executionPacket: "", executionPacketSha256: "", pmReadContext: "", agent: "w", helperMode: "inherit", helperRequired: false } } as never);
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr" });
    transitionAttempt(db, "a1", "validation_failed", { reason: "verification failed (npm test): exit 1" });
    expect(db.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(id)).toEqual({ status: "active" });
  });
});
