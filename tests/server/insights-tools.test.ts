import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { acceptedRules } from "@lane-pilot/run-insights";
import { createRun, createTask, openDatabase, saveProjectSetting, saveStageReceipt, searchMemoryRecords, setRunThread } from "../../src/database";
import { sweepLessons } from "../../src/server/insights";
import { createCore } from "../../src/server/core";

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

    const viaRpc = await harness.behavior.callRpc("get_routing_hint", { projectId }) as { current: unknown; hints: Array<{ risk: string; hint: string }> };
    expect(viaRpc.current).toEqual({ providerId: "agy", model: "gemini-6-astra" });
    expect(viaRpc.hints).toEqual([{ risk: "medium", hint: expect.stringContaining("codex/gpt-6-luna reached 100%") }]);

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
    const again = await sweepLessons(createCore(bb, db), projectId);
    expect(again.state).toBe("nothing_new");

    const records = searchMemoryRecords(db, projectId, "discount checkout retry", 10, "fts5", "subagent");
    expect(records).toHaveLength(1);
    expect(records[0]?.concepts).toEqual(expect.arrayContaining(["lesson", "night-review", "blocking", "checkout"]));

    const golden = await call("lane_pilot_memory_golden", { runId, cases: `- discount checkout retry -> ${records[0]!.id}\n- unrelated seo query -> nope` });
    expect(golden).toMatchObject({ cases: 2, hits: 1, hitRate: 0.5, misses: [{ query: "unrelated seo query", missing: ["nope"] }] });
  });

  it("turns a repeated failure into a rule the owner accepts, rewords and revokes", async () => {
    const { db, harness, call } = await setup();
    dispose = () => harness.lifecycle.dispose();
    const now = Date.now();
    ["t1", "t2", "t3"].forEach((task, index) => {
      createTask(db, { id: task, runId, kind: "bb", contract: { risk: "low" } });
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(`a-${task}`, runId, task, "validation_failed", `verification failed (curl -fsS https://site${index}.example/p): curl: (6) Could not resolve host: site${index}.example`, now, now, 1, "[]");
    });

    const listed = await harness.behavior.callRpc("list_rule_proposals", { projectId }) as { proposals: Array<Record<string, any>>; memory: { enabled: boolean } };
    expect(listed.memory.enabled).toBe(false);
    expect(listed.proposals).toHaveLength(1);
    const proposal = listed.proposals[0]!;
    expect(proposal).toMatchObject({ state: "proposed", author: "sweep", occurrences: 3, taskCount: 3 });

    saveProjectSetting(db, projectId, "memory.enabled", "true");
    const swept = await call("lane_pilot_lessons_sweep", { runId });
    expect(swept.ruleProposals).toEqual([expect.objectContaining({ id: proposal.id, occurrences: 3 })]);
    const reworded = await call("lane_pilot_rule_propose", { runId, proposalId: proposal.id, rule: "Verification commands must not reach the network." });
    expect(reworded).toMatchObject({ revised: true, proposal: { author: "pm" } });

    const accepted = await harness.behavior.callRpc("decide_rule_proposal", { projectId, id: proposal.id, action: "accept", rule: "Never use curl or other network calls in verification commands." }) as { proposal: Record<string, any> };
    expect(accepted.proposal).toMatchObject({ state: "accepted", author: "owner", rule: "Never use curl or other network calls in verification commands." });
    expect(acceptedRules(db, projectId)).toEqual([expect.objectContaining({ rule: "Never use curl or other network calls in verification commands." })]);
    const stored = db.prepare("SELECT kind, audience FROM lane_pilot_memory WHERE project_id=? AND content LIKE 'Never use curl%'").all(projectId);
    expect(stored).toEqual([{ kind: "core", audience: "subagent" }]);
    await expect(harness.behavior.callRpc("decide_rule_proposal", { projectId, id: proposal.id, action: "reject" })).rejects.toThrow(/not waiting/);

    const revoked = await harness.behavior.callRpc("decide_rule_proposal", { projectId, id: proposal.id, action: "revoke" }) as { proposal: Record<string, any> };
    expect(revoked.proposal.state).toBe("revoked");
    expect(acceptedRules(db, projectId)).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE project_id=? AND content LIKE 'Never use curl%'").get(projectId)).toEqual({ n: 0 });
  });
});
