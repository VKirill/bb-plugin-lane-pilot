import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { acceptedRules } from "@lane-pilot/run-insights";
import { createRun, createTask, openDatabase, saveProjectSetting, savePrototypeConfig, saveStageReceipt, searchMemoryRecords, setRunThread } from "../../src/database";
import { adoptRuleProposal, sweepLessons } from "../../src/server/insights";
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
    // A text-grouping draft left from the fallback is dropped once Jev answers; a decided one stays.
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at)
      VALUES ('rule_old','${projectId}','x','Repeated in 40 tasks: .agents noise','sweep','proposed',40,40,'[]',1,1,1), ('rule_kept','${projectId}','y','Decided long ago','sweep','rejected',3,3,'[]',1,1,1)`).run();
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
    expect(first.proposals.map((row: { id: string }) => row.id)).not.toContain("rule_old");
    expect(first.proposals.map((row: { id: string }) => row.id)).toContain("rule_kept");
    // The system adopts the analyzer's rule on its own: in force on trial, stored where writers read it.
    const proposal = first.proposals.find((row: { author: string }) => row.author === "model");
    expect(first.scan).toMatchObject({ adopted: 1 });
    expect(proposal).toMatchObject({ author: "model", state: "accepted", decidedBy: "auto", trialState: "trial", revision: 1, rule: "Создай каждый файл из expected_outputs до ответа и проверь его ls.", taskCount: 3, scope: [], scopeLabel: "" });
    expect(proposal.trial).toEqual({ applied: 0, appliedAccepted: 0, recurrences: 0 });
    expect(proposal.evidence.map((row: { taskId: string }) => row.taskId).sort()).toEqual(["w1", "w2", "w3"]);
    expect(acceptedRules(db, projectId).map((row) => row.id)).toEqual([proposal.id]);
    expect(first.events).toEqual([expect.objectContaining({ ruleId: proposal.id, action: "adopted" })]);

    await harness.behavior.callRpc("start_rule_scan", { projectId, locale: "ru" });
    const second = await scanDone();
    expect(second.scan).toMatchObject({ state: "done", triaged: 0, groups: 0, adopted: 0 });
    // The two bookkeeping-only rejections are decided in code; Jev is asked about the three others, once.
    expect(judged).toHaveLength(3);
    expect(judged.some((reason) => reason.includes(".agents/"))).toBe(false);
    expect(spawned).toHaveLength(1);

    // The owner path still works next to the system's: the PM rewords a proposal, the owner accepts it.
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at)
      VALUES ('rule_manual','${projectId}','manual','A draft waiting for the owner','sweep','proposed',3,3,'[]',1,1,1)`).run();
    saveProjectSetting(db, projectId, "memory.enabled", "true");
    const swept = await call("lane_pilot_lessons_sweep", { runId });
    expect(swept.ruleProposals).toEqual([expect.objectContaining({ id: "rule_manual" })]);
    expect(await call("lane_pilot_rule_propose", { runId, proposalId: "rule_manual", rule: "Before answering, create every expected output file." })).toMatchObject({ revised: true, proposal: { author: "pm" } });
    const accepted = await harness.behavior.callRpc("decide_rule_proposal", { projectId, id: "rule_manual", action: "accept", rule: "Создавай все файлы из expected_outputs до ответа." }) as { proposal: Record<string, any> };
    expect(accepted.proposal).toMatchObject({ state: "accepted", author: "owner", decidedBy: "owner", trialState: null });
    await expect(harness.behavior.callRpc("decide_rule_proposal", { projectId, id: "rule_manual", action: "reject" })).rejects.toThrow(/not waiting/);

    // The owner can take back what the system adopted; its memory record goes with it.
    const revoked = await harness.behavior.callRpc("decide_rule_proposal", { projectId, id: proposal.id, action: "revoke" }) as { proposal: Record<string, any> };
    expect(revoked.proposal).toMatchObject({ state: "revoked", decidedBy: "owner", retiredReason: "owner" });
    expect(acceptedRules(db, projectId).map((row) => row.id)).toEqual(["rule_manual"]);
    const journal = ((await list()).events as Array<{ ruleId: string; action: string }>).map((row) => `${row.ruleId}:${row.action}`);
    expect(journal).toEqual([`${proposal.id}:owner_revoked`, "rule_manual:owner_accepted", `${proposal.id}:adopted`]);

    await harness.behavior.callRpc("save_rules_analyzer", { projectId, analyzer: { providerId: "claude-code", model: "opus", reasoningLevel: "max", serviceTier: null } });
    expect((await list()).analyzer).toMatchObject({ providerId: "claude-code", model: "opus" });
  });

  it("decides in code when the gate rejected the task's own files, and reports a scan cut off by a restart", async () => {
    const judged: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host-1", path: "/tmp/rules-ws", isDefault: true }] }) as never, list: async () => [] as never } },
      experimental_callHostRpc: (call) => { judged.push(String((call.input as { state: string }).state)); return { hostId: "host-1", status: "ok", reason: null, answers: { origin: "writer", category: "outside_scope" }, confidence: { origin: 0.9 } }; },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: "/tmp/rules-ws", writerWorkspacePath: "/tmp/rules-ws", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    createRun(db, runId, projectId);
    const now = Date.now();
    createTask(db, { id: "own", runId, kind: "bb", contract: { owns_paths: ["apps/api/**"], never_touch: [] } });
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("a-own", runId, "own", "validation_failed", "writer changed paths outside owns_paths or inside never_touch: apps/api/routes.ts", now, now, 1, "[]");
    await harness.behavior.callRpc("start_rule_scan", { projectId, locale: "en" });
    let listed: Record<string, any> = {};
    for (let i = 0; i < 100; i++) {
      listed = await harness.behavior.callRpc("list_rule_proposals", { projectId }) as Record<string, any>;
      if (listed.scan.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(judged).toEqual([]);
    expect(listed.triage.byOrigin).toEqual({ orchestrator: 1 });
    expect(db.prepare("SELECT detail FROM lane_pilot_failure_triage").all()).toEqual([{ detail: "code:gate_rejected_owned_paths" }]);

    await bb.storage.kv.set(`rules-scan:${projectId}`, { state: "running", startedAt: 1, finishedAt: null, triaged: 0, groups: 0, proposals: 0, reason: null });
    expect(((await harness.behavior.callRpc("list_rule_proposals", { projectId })) as Record<string, any>).scan).toMatchObject({ state: "failed", reason: "interrupted_by_restart" });
    expect(await harness.behavior.callRpc("start_rule_scan", { projectId, locale: "en" })).toMatchObject({ started: true });
  });

  it("judges adopted rules on trial: rewrites one its writers keep breaking, retires it after the last wording, confirms a clean one", async () => {
    const spawned: Array<Record<string, any>> = [];
    let rewrites = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async () => ({}),
          spawn: async (args) => { spawned.push(args as Record<string, any>); return { id: `analyzer-${spawned.length}` }; },
          get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId }),
          events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
          output: async ({ threadId }) => ({ output: threadId.startsWith("analyzer-") ? JSON.stringify({ rules: [{ rule: `Run ls on every expected output before answering (v${++rewrites + 1}).`, evidence: [] }] }) : "writer tail" }),
          stop: async () => ({ ok: true }) as never,
          list: async () => [] as never,
        },
        projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host-1", path: "/tmp/rules-ws", isDefault: true }] }) as never, list: async () => [] as never },
      },
      experimental_callHostRpc: (call) => {
        const questions = (call.input as { questions: Record<string, unknown> }).questions;
        return { hostId: "host-1", status: "ok", reason: null, answers: { origin: "writer", category: "missing_output", ...(questions.same_rule ? { same_rule: "r1" } : {}) }, confidence: { origin: 0.9 } };
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: "/tmp/rules-ws", writerWorkspacePath: "/tmp/rules-ws", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    saveProjectSetting(db, projectId, "memory.enabled", "true");
    createRun(db, runId, projectId);
    const t0 = Date.now() - 60_000;
    const adopt = (id: string, rule: string) => {
      db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at)
        VALUES (?,?,?,?,'model','proposed',3,3,'[]',1,1,1)`).run(id, projectId, id, rule);
      return adoptRuleProposal(db, projectId, id, t0);
    };
    expect(adopt("rule-broken", "Check expected outputs.")).toMatchObject({ state: "accepted", decidedBy: "auto", trialState: "trial" });
    expect(adopt("rule-clean", "Quote the passing test line.")).toMatchObject({ trialState: "trial" });
    let n = 0;
    const give = (rule: string, state: string, reason: string | null, at: number) => {
      const task = `task-${++n}`;
      createTask(db, { id: task, runId, kind: "bb", contract: { risk: "low" } });
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(`att-${n}`, runId, task, state, reason, at, at, 1, "[]");
      db.prepare("INSERT INTO lane_pilot_attempt_reasoning(attempt_id,trace_json) VALUES(?,?)").run(`att-${n}`, JSON.stringify({ attemptId: `att-${n}`, dispatchContext: { rulesPicked: { total: 2, picked: [rule] } } }));
    };
    for (let i = 0; i < 5; i++) give("rule-clean", "accepted", null, t0 + 1_000 + i);
    give("rule-broken", "validation_failed", "missing expected_outputs: a.md", t0 + 2_000);
    give("rule-broken", "validation_failed", "missing expected_outputs: b.md", t0 + 3_000);
    const scan = async () => {
      await harness.behavior.callRpc("start_rule_scan", { projectId, locale: "en" });
      for (let i = 0; i < 100; i++) {
        const listed = await harness.behavior.callRpc("list_rule_proposals", { projectId }) as Record<string, any>;
        if (listed.scan.state !== "running") return listed;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("scan did not finish");
    };
    const first = await scan();
    expect(first.scan).toMatchObject({ state: "done", confirmed: 1, revised: 1, retired: 0 });
    const broken = first.proposals.find((row: { id: string }) => row.id === "rule-broken");
    expect(broken).toMatchObject({ state: "accepted", revision: 2, trialState: "trial", rule: "Run ls on every expected output before answering (v2)." });
    expect(spawned[0]!.prompt).toContain("Check expected outputs.");
    expect(spawned[0]!.prompt).toContain("missing expected_outputs: a.md");
    expect(first.proposals.find((row: { id: string }) => row.id === "rule-clean")).toMatchObject({ trialState: "confirmed", trial: { applied: 5, recurrences: 0 } });
    expect(searchMemoryRecords(db, projectId, "expected outputs before answering", 10, "fts5", "subagent").map((row) => row.content)).toEqual(["Run ls on every expected output before answering (v2)."]);

    // The new wording starts its own count; two more writers given it repeat the mistake and it leaves.
    const later = Date.now() + 1_000;
    give("rule-broken", "validation_failed", "missing expected_outputs: c.md", later);
    give("rule-broken", "validation_failed", "missing expected_outputs: d.md", later + 1);
    const second = await scan();
    expect(second.scan).toMatchObject({ retired: 1, revised: 0 });
    expect(second.proposals.find((row: { id: string }) => row.id === "rule-broken")).toMatchObject({ state: "revoked", retiredReason: "kept_recurring after 2 wordings" });
    expect(acceptedRules(db, projectId).map((row) => row.id)).toEqual(["rule-clean"]);
    const journal = (second.events as Array<{ ruleId: string; action: string }>).map((row) => `${row.ruleId}:${row.action}`);
    expect(journal[0]).toBe("rule-broken:retired");
    expect([...journal].sort()).toEqual(["rule-broken:adopted", "rule-broken:retired", "rule-broken:revised", "rule-clean:adopted", "rule-clean:confirmed"]);
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
