import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, createTask, openDatabase, saveProjectSetting, saveStageReceipt, searchMemoryRecords, setRunThread } from "../../src/database";
import { sweepLessons } from "../../src/server/insights";
import { createServerContext } from "../../src/server/context";

const projectId = "insights-project";
const pmThreadId = "insights-pm";
const runId = "insights-run";

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  const db = openDatabase(bb);
  createRun(db, runId, projectId);
  setRunThread(db, runId, pmThreadId);
  const call = async (name: string, params: Record<string, unknown>) =>
    JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>;
  return { bb, db, harness, call };
}

function seedWriterTask(db: ReturnType<typeof openDatabase>, input: { task: string; risk: string; provider: string; model: string; accepted: boolean; attempt?: number }) {
  createTask(db, { id: input.task, runId, kind: "bb", contract: { risk: input.risk } });
  const now = Date.now();
  saveStageReceipt(db, { runId, taskId: input.task, stageId: "writer-agent", contractVersion: 1, state: "passed", inputSha256: "a".repeat(64), outputSha256: null, attempt: 0, providerId: input.provider, model: input.model, threadId: null, result: null, reason: null, updatedAt: now });
  saveStageReceipt(db, { runId, taskId: input.task, stageId: "acceptance-receipt", contractVersion: 1, state: input.accepted ? "passed" : "failed", inputSha256: "b".repeat(64), outputSha256: null, attempt: input.attempt ?? 0, providerId: null, model: null, threadId: null, result: null, reason: input.accepted ? null : "expected_outputs missing: docs/orders.md", updatedAt: now });
}

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("insights tools", () => {
  it("reports writer acceptance per pair and a hint against the configured writer", async () => {
    const { db, harness, call } = await setup();
    dispose = () => harness.lifecycle.dispose();
    for (let i = 0; i < 5; i++) seedWriterTask(db, { task: `luna-${i}`, risk: "medium", provider: "codex", model: "gpt-6-luna", accepted: true });
    for (let i = 0; i < 5; i++) seedWriterTask(db, { task: `astra-${i}`, risk: "medium", provider: "agy", model: "gemini-6-astra", accepted: i < 2 });
    saveProjectSetting(db, projectId, "writer.provider", "agy");
    saveProjectSetting(db, projectId, "writer.model", "gemini-6-astra");

    const result = await call("lane_pilot_routing_stats", { runId, risk: "medium" });
    expect(result.current).toEqual({ providerId: "agy", model: "gemini-6-astra" });
    expect(result.stats).toHaveLength(2);
    expect(result.hints.medium).toContain("codex/gpt-6-luna reached 100%");
  });

  it("sweeps lessons into subagent memory once and scores a golden set", async () => {
    const { bb, db, harness, call } = await setup();
    dispose = () => harness.lifecycle.dispose();
    seedWriterTask(db, { task: "t1", risk: "low", provider: "codex", model: "m", accepted: false });
    saveStageReceipt(db, { runId, taskId: "t1", stageId: "night-review", contractVersion: 1, state: "passed", inputSha256: "c".repeat(64), outputSha256: null, attempt: 0, providerId: null, model: null, threadId: null,
      result: { decision: "findings", summary: "s", findings: [{ severity: "blocking", path: "apps/api/src/orders/checkout.ts", finding: "Discount applied twice on retry", suggestedFix: "Make applyDiscount idempotent" }] }, reason: null, updatedAt: Date.now() });

    const disabled = await call("lane_pilot_lessons_sweep", { runId });
    expect(disabled).toMatchObject({ state: "skipped", reason: "memory_disabled" });

    saveProjectSetting(db, projectId, "memory.enabled", "true");
    const first = await call("lane_pilot_lessons_sweep", { runId });
    expect(first).toMatchObject({ state: "stored", sources: 2, candidates: 2, stored: 2 });
    const again = await sweepLessons(createServerContext(bb, db), projectId);
    expect(again.state).toBe("nothing_new");

    const records = searchMemoryRecords(db, projectId, "discount checkout retry", 10, "fts5", "subagent");
    expect(records).toHaveLength(1);
    expect(records[0]?.concepts).toEqual(expect.arrayContaining(["lesson", "night-review", "blocking", "checkout"]));

    const golden = await call("lane_pilot_memory_golden", { runId, cases: `- discount checkout retry -> ${records[0]!.id}\n- unrelated seo query -> nope` });
    expect(golden).toMatchObject({ cases: 2, hits: 1, hitRate: 0.5, misses: [{ query: "unrelated seo query", missing: ["nope"] }] });
  });
});
