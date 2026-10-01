import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { acceptedRules } from "@lane-pilot/run-insights";
import { createRun, createTask, openDatabase, saveProjectSetting, savePrototypeConfig, saveStageReceipt, searchMemoryRecords, setRunThread } from "../../src/database";
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

  it("Jev sorts failures, the analyzer writes a rule with evidence, a rescan pays nothing, the owner accepts and revokes", async () => {
    const judged: string[] = [];
    const spawned: Array<Record<string, any>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : {},
          spawn: async (args) => { spawned.push(args as Record<string, any>); return { id: `analyzer-${spawned.length}` }; },
          get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId }),
          events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
          output: async ({ threadId }) => ({ output: threadId.startsWith("analyzer-")
            ? 'Here: {"rules":[{"rule":"Создай каждый файл из expected_outputs до ответа и проверь его ls.","evidence":["w1","w2"],"also_seen":["w3"]}],"not_writer":[]}'
            : `writer ${threadId}: done, wrote the code but not docs` }),
          stop: async () => ({ ok: true }) as never,
          list: async () => [] as never,
        },
        projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host-1", path: "/tmp/rules-ws", isDefault: true }] }) as never, list: async () => [] as never },
      },
      experimental_callHostRpc: (call) => {
        if (call.method !== "councilJudge") throw new Error(`unexpected host method ${call.method}`);
        const state = JSON.parse((call.input as { state: string }).state) as { failure_reason: string };
        judged.push(state.failure_reason);
        const bookkeeping = state.failure_reason.includes(".agents/");
        return { hostId: "host-1", status: "ok", reason: null,
          answers: { origin: bookkeeping ? "orchestrator" : "writer", category: "missing_output" }, confidence: { origin: 0.9, category: 0.95 } };
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: "/tmp/rules-ws", writerWorkspacePath: "/tmp/rules-ws", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    const call = async (name: string, params: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>;
    const now = Date.now();
    const seed = (task: string, reason: string) => {
      createTask(db, { id: task, runId, kind: "bb", contract: { risk: "low", title: `task ${task}`, expected_outputs: [`docs/${task}.md`] } });
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json,thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(`a-${task}`, runId, task, "validation_failed", reason, now, now, 1, "[]", `thr-${task}`);
    };
    for (const task of ["w1", "w2", "w3"]) seed(task, `missing expected_outputs: docs/${task}.md`);
    for (const task of ["o1", "o2"]) seed(task, "owns_paths rejected .agents/PROGRESS.md");
    const list = async () => await harness.behavior.callRpc("list_rule_proposals", { projectId }) as Record<string, any>;
    const scanDone = async () => {
      for (let i = 0; i < 100; i++) {
        const listed = await list();
        if (listed.scan.state !== "running") return listed;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("scan did not finish");
    };

    expect((await list()).analyzer).toEqual({ providerId: "codex", model: "m", reasoningLevel: "high", serviceTier: null });
    expect(await harness.behavior.callRpc("start_rule_scan", { projectId, locale: "ru" })).toMatchObject({ started: true });
    const first = await scanDone();
    expect(first.scan).toMatchObject({ state: "done", triaged: 5, groups: 1, proposals: 1 });
    expect(first.triage).toMatchObject({ total: 5, byOrigin: { writer: 3, orchestrator: 2 }, errors: 0, pendingGroups: 0 });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ projectId, visibility: "hidden", providerId: "codex", model: "m", pluginMetadata: { role: "rules-analyzer", category: "missing_output" } });
    expect(spawned[0]!.prompt).toContain("Write the rules in Russian");
    expect(spawned[0]!.prompt).toContain("writer thr-w1: done, wrote the code but not docs");
    expect(spawned[0]!.prompt).not.toContain(".agents/PROGRESS.md");
    const proposal = first.proposals[0];
    expect(proposal).toMatchObject({ author: "model", state: "proposed", rule: "Создай каждый файл из expected_outputs до ответа и проверь его ls.", taskCount: 3 });
    expect(proposal.evidence.map((row: { taskId: string }) => row.taskId).sort()).toEqual(["w1", "w2", "w3"]);

    await harness.behavior.callRpc("start_rule_scan", { projectId, locale: "ru" });
    const second = await scanDone();
    expect(second.scan).toMatchObject({ state: "done", triaged: 0, groups: 0 });
    expect(judged).toHaveLength(5);
    expect(spawned).toHaveLength(1);

    saveProjectSetting(db, projectId, "memory.enabled", "true");
    const swept = await call("lane_pilot_lessons_sweep", { runId });
    expect(swept.ruleProposals).toEqual([expect.objectContaining({ id: proposal.id, taskCount: 3 })]);
    const reworded = await call("lane_pilot_rule_propose", { runId, proposalId: proposal.id, rule: "Before answering, create every expected output file." });
    expect(reworded).toMatchObject({ revised: true, proposal: { author: "pm" } });

    const accepted = await harness.behavior.callRpc("decide_rule_proposal", { projectId, id: proposal.id, action: "accept", rule: "Создавай все файлы из expected_outputs до ответа." }) as { proposal: Record<string, any> };
    expect(accepted.proposal).toMatchObject({ state: "accepted", author: "owner" });
    expect(acceptedRules(db, projectId)).toEqual([expect.objectContaining({ rule: "Создавай все файлы из expected_outputs до ответа." })]);
    expect(db.prepare("SELECT kind, audience FROM lane_pilot_memory WHERE project_id=? AND content LIKE 'Создавай%'").all(projectId)).toEqual([{ kind: "core", audience: "subagent" }]);
    await expect(harness.behavior.callRpc("decide_rule_proposal", { projectId, id: proposal.id, action: "reject" })).rejects.toThrow(/not waiting/);

    const revoked = await harness.behavior.callRpc("decide_rule_proposal", { projectId, id: proposal.id, action: "revoke" }) as { proposal: Record<string, any> };
    expect(revoked.proposal.state).toBe("revoked");
    expect(acceptedRules(db, projectId)).toEqual([]);

    await harness.behavior.callRpc("save_rules_analyzer", { projectId, analyzer: { providerId: "claude-code", model: "opus", reasoningLevel: "max", serviceTier: null } });
    expect((await list()).analyzer).toMatchObject({ providerId: "claude-code", model: "opus" });
  });

  it("falls back to masked-text grouping when the project's machine has no Jev key", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host-1", path: "/tmp/rules-ws", isDefault: true }] }) as never, list: async () => [] as never } },
      experimental_callHostRpc: () => ({ hostId: "host-1", status: "disabled", answers: {}, reason: "missing_typesafe_api_key" }),
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: "/tmp/rules-ws", writerWorkspacePath: "/tmp/rules-ws", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    createRun(db, runId, projectId);
    const now = Date.now();
    for (const [index, task] of ["t1", "t2", "t3"].entries()) {
      createTask(db, { id: task, runId, kind: "bb", contract: { risk: "low" } });
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(`a-${task}`, runId, task, "validation_failed", `curl: (6) Could not resolve host: site${index}.example`, now, now, 1, "[]");
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(`b-${task}`, runId, task, "validation_failed", "owns_paths rejected .agents/memory/episodes/1.md", now, now, 2, "[]");
    }
    await harness.behavior.callRpc("start_rule_scan", { projectId, locale: "en" });
    let listed: Record<string, any> = {};
    for (let i = 0; i < 100; i++) {
      listed = await harness.behavior.callRpc("list_rule_proposals", { projectId }) as Record<string, any>;
      if (listed.scan.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(listed.scan).toMatchObject({ state: "done", reason: "jev_unavailable:missing_typesafe_api_key", proposals: 1 });
    expect(listed.proposals).toEqual([expect.objectContaining({ author: "sweep", rule: expect.stringContaining("Could not resolve host") })]);
  });
});
