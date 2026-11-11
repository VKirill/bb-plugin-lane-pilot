import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { planSignature, type PlanItem } from "../../src/rooms/phase/logic";
import { savePhase } from "../../src/rooms/phase/store";
import { createRun, openDatabase, saveProjectSetting, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { localDateKey } from "../../src/rooms/docs/docs";
import { createCapabilities, receiptFingerprint } from "../../src/rooms/capability/server";
import { runCapabilityCli } from "../../src/rooms/capability/server/cli";
import { DOCUMENTARY_CELLS, receiptKey } from "../../src/rooms/capability";
import { documentaryGateOf } from "../../src/rooms/platform/server/pm-spawn";
import { listReceipts } from "../../src/rooms/capability/store";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const ev = (seq: number, type: string, data: Record<string, unknown> = {}, createdAt = 1_000) => ({ seq, type, createdAt, threadId: "thr_docs", data });
const idleEvents = [ev(1, "client/turn/requested", {}, 1_000), ev(2, "turn/started", {}, 1_100), ev(3, "turn/completed", { status: "completed" }, 2_000)].reverse();

describe("stream i2 graphs", () => {
  it("[sma:k_ag_docwriter] bb lane-pilot docs-nightly --assignment hands the masked, bounded text to the docs-maintainer's run as data", async () => {
    const projectId = "proj_docs_assign";
    const spawned: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        files: { read: async () => { throw new Error("no such file"); } } as never,
        projects: { get: async () => ({ id: projectId, name: "P", sources: [{ hostId: "ovh", path: "/work/p", isDefault: true }] }) as never, list: async () => [{ id: projectId }] as never },
        providers: {
          list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }] as never,
          models: async () => ({ models: [{ id: "gpt-6-luna", model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }) as never,
        } as never,
        threads: {
          spawn: async (args: Record<string, unknown>) => { spawned.push(args); return { id: "thr_docs" } as never; },
          get: async () => ({ id: "thr_docs", status: "idle" }) as never,
          events: { list: async () => idleEvents as never },
        } as never,
      },
      experimental_callHostRpc: (call) => {
        const input = call.input as Record<string, unknown>;
        if (call.method === "gitDocsScope") return { hostId: "ovh", status: "ready", isRepoRoot: true, hasDocs: true, changed: ["src/a.ts"], dirty: ["docs/overview.md"], base: null, workspaces: [], localDate: localDateKey(new Date()), localHour: 4, reason: null };
        if (call.method === "gitCreateWorktree") return { hostId: "ovh", status: "failed", path: null, branch: null, reason: "no worktree in the test" };
        if (call.method === "listDocsPages") return { hostId: "ovh", pages: [], oversized: [] };
        if (call.method === "docsFlows") return { hostId: "ovh", briefPath: "/tmp/flows.md", jev: "disabled", routes: 0, flows: [] };
        if (call.method === "docsAnchors") return { hostId: "ovh", briefPath: "/tmp/brief.md", anchors: 0, jev: "disabled", tables: [], deploy: false, core: [], productFiles: [] };
        if (call.method === "docsLineCounts") return { hostId: "ovh", counts: {} };
        if (call.method === "writeDocsPages") return { hostId: "ovh", previewSha256: "a".repeat(64), status: "applied", writes: [], reason: null };
        if (call.method === "gitCommitDocs") return { hostId: "ovh", status: "committed", commit: "abc123", reason: null };
        throw new Error(`stop at ${call.method}`);
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "ovh", pmWorkspacePath: "/work/p", writerWorkspacePath: "/work/p", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    saveProjectSetting(db, projectId, "docs.enabled", true);
    const assignment = `update docs/overview.md for token sk-${"x".repeat(30)} ${" pad".repeat(600)}`;
    const result = await harness.behavior.runCli(["docs-nightly", projectId, "--assignment", assignment]) as { stdout: string };
    expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ projectId, state: "passed" })]);
    // The run's stored input is the masked text, bounded at 2000 chars; the maintainer reads it as an assignment, not as instructions.
    const run = db.prepare("SELECT inputs_json FROM lane_pilot_wf_run WHERE workflow_id='lp.docs-night'").get() as { inputs_json: string };
    const stored = String(JSON.parse(run.inputs_json).assignment);
    expect(stored.length).toBeLessThanOrEqual(2000);
    expect(stored).not.toContain("sk-");
    expect(spawned).toHaveLength(1);
    expect(String(spawned[0]!.prompt)).toContain("update docs/overview.md");
    expect(String(spawned[0]!.prompt)).not.toContain("sk-");
    // A bare --assignment without a value is a usage error, not a silent pass.
    const bad = await harness.behavior.runCli(["docs-nightly", projectId, "--assignment"]) as { exitCode: number; stderr?: string };
    expect(bad.exitCode).toBe(1);
  });

  it("[sma:k_v_grill] a plan grilled with open challenges waits at admission naming them and their lift; the owner's word or a new plan lifts it, and the admitted plan states its budget read", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    harness.sdk.stub("threads.send", async () => ({}));
    harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
    harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
    bb.hosts.experimental_client = (() => ({ call: async () => ({}) })) as never;
    const db = openDatabase(bb);
    createRun(db, "run1", "projA", "bb", "/repo");
    db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', pm_thread_id='thr_pm' WHERE id='run1'").run();
    const services = {
      runBudgets: { get: () => undefined },
      dispatchWriter: async () => ({}),
      regression: { run: async () => ({}) },
      runGoal: { check: async () => ({}) },
      readWriterWorkspaceFile: async () => null,
      money: { status: () => ({ capSet: false, cap: null, left: null, monthUsd: 0 }) },
    } as unknown as Services;
    const phases = createPhaseDriver(createCore(bb, db), services).phases;
    const piece: PlanItem = { id: "p1", title: "P1", wave: 1, promise: { given: "g", when: "w", then: "t" },
      task: { id: "p1", project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test", cwd: "/repo" }], acceptance: ["the goal is met"] } };
    const sha = planSignature([piece], "ctx");
    const open = async (grillGate = true) => {
      const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "T", goal: "g" });
      savePhase(db, phase.id, { stage: "planning", runId: "run1", record: { ...phase.record, ...(grillGate ? {} : { grillGate: false }),
        context: { docs: [], sha: "ctx", signedAt: 1 },
        plan: { items: [piece], contextSha: "ctx", sha, submittedAt: 1, objective: "o", premortem: ["a", "b", "c"],
          critique: { decision: "approve", by: "t", independence: { ok: true, wfRunId: "wfrun_plan" } } } } as never, at: 2 });
      return phase.id;
    };
    // The journal rows the real chain leaves: the lp.plan run whose critic approved this plan, and a grill that ended open.
    db.prepare(`INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("wfrun_plan", "lp.plan", 1, "s", JSON.stringify({ nodes: [{ id: "critic", role: "plan-critic" }] }), "projA", "run1", "succeeded", JSON.stringify({ plan_sha: sha }), JSON.stringify({ plan_verdict: "pass", status: "ok" }), 10, 10);
    db.prepare(`INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,input_json,started_at,ended_at,updated_at,receipt_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run("wfrun_plan", "wfrun_plan:critic", "edge", "critic", 1, "succeeded", "{}", 10, 11, 11, JSON.stringify({ threadId: "thr_critic" }));
    db.prepare(`INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("wfrun_grill", "grill-plan", 1, "s", "{}", "projA", "run1", "succeeded", JSON.stringify({ plan_sha: sha, phase_id: "any" }), JSON.stringify({ status: "open", open: ["which shard migrates first", "rollback window"] }), 20, 20);

    // Blocked: admission waits and names the open challenges and the lift.
    const heldId = await open();
    const refusal = await phases.planCheck({ phaseId: heldId, decision: "approve", by: "t", wfRunId: "wfrun_plan" }).catch((cause: unknown) => cause as Error & { why?: string[] });
    expect(refusal).toBeInstanceOf(Error);
    const held = (await phases.status(heldId)).phase;
    expect(held.stage).toBe("planning");
    expect(held.record.plan!.admittedSha).toBeUndefined();
    const book = (await phases.status(held.id)).book;
    expect(book).toContain("wfrun_grill");
    expect(book).toContain("which shard migrates first");
    expect(book).toContain("phase.grill_gate=off");

    // The owner's word on this plan lifts the hold; the admitted plan states the budget it read.
    const lifted = await phases.word({ phaseId: held.id, turn: "planning", decision: "yes", text: "yes", by: "owner" });
    expect(lifted.stage).not.toBe("planning");
    expect(lifted.record.plan!.admittedSha).toBe(sha);
    expect(lifted.record.plan!.budget).toContain("run tokens left: no cap");
    expect(lifted.record.plan!.budget).toContain("no monthly cap");

    // The opt-out admits over an open grill; a never-grilled plan is never blocked.
    const off = await phases.planCheck({ phaseId: await open(false), decision: "approve", by: "t", wfRunId: "wfrun_plan" });
    expect(off.stage).not.toBe("planning");
    db.prepare("DELETE FROM lane_pilot_wf_run WHERE id='wfrun_grill'").run();
    const clean = await phases.planCheck({ phaseId: await open(), decision: "approve", by: "t", wfRunId: "wfrun_plan" });
    expect(clean.stage).not.toBe("planning");
    expect(clean.record.plan!.admittedSha).toBe(sha);
  });
});


describe("stream i2 graphs: the documentary gate never holds on a probe that could not run", () => {
  type Answer = { ok: boolean; answered?: boolean; reason: string | null };
  const KEY = receiptKey({ version: "0.1.0", model: "gpt-6-luna", settings: [], hooks: receiptFingerprint() });
  const rig = (options: { sandboxRun?: boolean } = {}) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }]);
    harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }]);
    harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", status: "idle", archivedAt: null }));
    if (options.sandboxRun !== false) { createRun(db, "run_s", "proj_3tb652jpsi", "bb", "/s"); db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run_s'").run(); }
    const probes: string[] = [];
    const logs: string[] = [];
    const state: { answer: Answer; hang: boolean; throws: boolean } = { answer: { ok: true, reason: null }, hang: false, throws: false };
    const caps = createCapabilities({ db, bb, log: (line: string) => logs.push(line), isDisposed: () => false } as never,
      { providerBreaker: { record: () => undefined },
        startHelperProbe: (_p: string, _r: string, provider: string, _m: string, cell: string) => { probes.push(`${provider}:${cell}`); return state.hang ? new Promise(() => undefined) : state.throws ? Promise.reject(new Error("socket hang up")) : Promise.resolve(state.answer); } } as never);
    return { bb, db, probes, logs, state, gate: documentaryGateOf(bb)!, api: caps.capabilities };
  };
  const receipts = (db: ReturnType<typeof openDatabase>) => listReceipts(db as never).filter((row) => row.providerId === "codex");

  it("[sma:ap_caps] a rate-limited probe and a timed-out probe write no receipt and the stage is observed, not held", async () => {
    for (const reason of ["429 rate limit exceeded, retry later", "helper_probe_timeout: the thread never went idle", "helper_probe_provider_unavailable:codex", "helper_probe_output_empty"]) {
      const { db, state, gate, logs } = rig();
      state.answer = { ok: false, reason };
      expect(await gate.deny("codex", "m", "proj")).toBeNull();
      expect(receipts(db)).toEqual([]);
      expect(logs.join("\n")).toMatch(/has no proof yet \(the probe could not run/);
      await dispose?.(); dispose = null;
    }
    // A probe that throws is also «could not run».
    const { db, gate, state } = rig();
    state.throws = true;
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(receipts(db)).toEqual([]);
  });

  /** The second gate call for the same cell, past the ten-minute pause a first wrong answer leaves. */
  const againLater = async (gate: { deny: (providerId: string, model: string, projectId: string) => Promise<string | null> }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try { vi.setSystemTime(Date.now() + 11 * 60_000); return await gate.deny("codex", "m", "proj"); } finally { vi.useRealTimers(); }
  };

  it("[sma:ap_caps_held] one wrong answer writes no receipt and holds nothing; the second in a row is the red receipt and the hold", async () => {
    const { db, state, gate, logs } = rig();
    state.answer = { ok: false, answered: true, reason: "helper_probe_documentary.nested_unexpected: the answer lacks what the probe asks for" };
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(receipts(db)).toEqual([]);
    expect(logs.join("\n")).toMatch(/answered wrong once/);
    const held = await againLater(gate);
    expect(held).toMatch(/^capability_unproven:codex:documentary\.nested /);
    expect(held).toContain("bb lane-pilot capabilities --probe");
    expect(held).toContain("capability.documentary_gate=observe");
    expect(receipts(db)).toEqual([expect.objectContaining({ capability: "documentary.nested", state: "not_supported", version: KEY })]);
    // The hold is a receipt: it stays until the cell is re-probed.
    expect(await gate.deny("codex", "m", "proj")).toBe(held);
  });

  it("[sma:ap_caps_held] a right answer between two wrong ones clears the first: the cell is proven, not red", async () => {
    const { db, state, gate } = rig();
    state.answer = { ok: false, answered: true, reason: "helper_probe_documentary.nested_unexpected: wrong" };
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    state.answer = { ok: true, reason: null };
    expect(await againLater(gate)).toBeNull();
    expect(receipts(db).find((row) => row.capability === "documentary.nested")).toMatchObject({ state: "supported" });
  });

  it("[sma:ap_caps_held] the hourly sweep follows the same rule: one wrong documentary answer leaves no receipt", async () => {
    const { db, state, api } = rig();
    state.answer = { ok: false, answered: true, reason: "helper_probe_documentary.nested_unexpected: wrong" };
    await api.sweep();
    expect(receipts(db).filter((row) => DOCUMENTARY_CELLS.includes(row.capability as never))).toEqual([]);
  });

  it("[sma:ap_caps_held] capabilities --probe re-probes a red documentary cell, replaces the receipt, and lifts the hold", async () => {
    const { db, state, gate, api, probes } = rig();
    state.answer = { ok: false, answered: true, reason: "helper_probe_documentary.nested_unexpected: wrong" };
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(await againLater(gate)).not.toBeNull();
    probes.length = 0;
    state.answer = { ok: true, reason: null };
    // The hourly sweep leaves a red cell alone; the CLI's --probe does not.
    await api.sweep();
    expect(probes).not.toContain("codex:documentary.nested");
    const result = await runCapabilityCli(api, ["--probe"]);
    expect(probes).toContain("codex:documentary.nested");
    expect(JSON.parse(result.stdout!).probed.length).toBeGreaterThan(0);
    expect(receipts(db).find((row) => row.capability === "documentary.nested")).toMatchObject({ state: "supported" });
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    // A re-probe that could not run leaves the red receipt as it was.
    state.answer = { ok: false, answered: true, reason: "helper_probe_documentary.role_unexpected: wrong" };
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
  });

  it("[sma:ap_caps] with no sandbox run to probe in, the stage runs observed and one log line says why", async () => {
    const { db, probes, gate, logs } = rig({ sandboxRun: false });
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(probes).toEqual([]);
    expect(receipts(db)).toEqual([]);
    expect(logs.filter((line) => line.includes("no sandbox run"))).toHaveLength(1);
  });

  it("[sma:ap_caps] a «could not run» outcome is remembered for ten minutes: the next gate call starts no probe", async () => {
    const { state, gate, probes } = rig();
    state.answer = { ok: false, reason: "429 rate limit" };
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(probes).toEqual(["codex:documentary.nested"]);
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    // The cache is per cell: the next unproven cell is tried once, and then it is remembered too.
    expect(probes).toEqual(["codex:documentary.nested", "codex:documentary.role"]);
    for (let n = 0; n < 4; n++) await gate.deny("codex", "m", "proj");
    expect(probes).toHaveLength(4);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await gate.deny("codex", "m", "proj");
      expect(probes).toHaveLength(5);
    } finally { vi.useRealTimers(); }
  });

  it("[sma:ap_caps] at most one cell is probed per gate call, and a probe that never finishes is observed after 60 s", async () => {
    const { state, gate, probes, db } = rig();
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(probes).toEqual(["codex:documentary.nested"]);
    state.hang = true;
    vi.useFakeTimers();
    try {
      const pending = gate.deny("codex", "m", "proj");
      await vi.advanceTimersByTimeAsync(59_000);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toBeNull();
    } finally { vi.useRealTimers(); }
    expect(receipts(db).map((row) => row.capability)).toEqual(["documentary.nested"]);
  });

  it("[sma:ap_caps] the offer a pick is drawn from (proved) reads receipts only and starts no probe", async () => {
    const { gate, probes, db } = rig();
    expect(await gate.proved("proj")).toBeNull();
    expect(probes).toEqual([]);
    db.prepare("INSERT INTO lane_pilot_capability(provider_id,version,capability,state,model,detail,at) VALUES (?,?,?,?,?,?,?)").run("codex", KEY, "documentary.hooks", "not_supported", "m", null, 1);
    const offer = (await gate.proved("proj"))!;
    expect(offer.has("codex")).toBe(false);
    expect(probes).toEqual([]);
  });
});

describe("stream i2 graphs: the grill gate matches this plan and tells the caller", () => {
  const rigPhase = async (grill: { inputs: Record<string, unknown>; output: Record<string, unknown> }) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    harness.sdk.stub("threads.send", async () => ({}));
    harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
    harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
    bb.hosts.experimental_client = (() => ({ call: async () => ({}) })) as never;
    const db = openDatabase(bb);
    createRun(db, "run1", "projA", "bb", "/repo");
    db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', pm_thread_id='thr_pm' WHERE id='run1'").run();
    const services = { runBudgets: { get: () => undefined }, dispatchWriter: async () => ({}), regression: { run: async () => ({}) }, runGoal: { check: async () => ({}) },
      readWriterWorkspaceFile: async () => null, money: { status: () => ({ capSet: false, cap: null, left: null, monthUsd: 0 }) } } as unknown as Services;
    const phases = createPhaseDriver(createCore(bb, db), services).phases;
    const piece: PlanItem = { id: "p1", title: "P1", wave: 1, promise: { given: "g", when: "w", then: "t" },
      task: { id: "p1", project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test", cwd: "/repo" }], acceptance: ["the goal is met"] } };
    const sha = planSignature([piece], "ctx");
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "T", goal: "g" });
    savePhase(db, phase.id, { stage: "planning", runId: "run1", record: { ...phase.record, context: { docs: [], sha: "ctx", signedAt: 1 },
      plan: { items: [piece], contextSha: "ctx", sha, submittedAt: 1, objective: "o", premortem: ["a", "b", "c"], critique: { decision: "approve", by: "t", independence: { ok: true, wfRunId: "wfrun_plan" } } } } as never, at: 2 });
    db.prepare(`INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("wfrun_plan", "lp.plan", 1, "s", JSON.stringify({ nodes: [{ id: "critic", role: "plan-critic" }] }), "projA", "run1", "succeeded", JSON.stringify({ plan_sha: sha }), JSON.stringify({ plan_verdict: "pass", status: "ok" }), 10, 10);
    db.prepare(`INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,input_json,started_at,ended_at,updated_at,receipt_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run("wfrun_plan", "wfrun_plan:critic", "edge", "critic", 1, "succeeded", "{}", 10, 11, 11, JSON.stringify({ threadId: "thr_critic" }));
    const inputs = JSON.parse(JSON.stringify(grill.inputs).replace("$SHA", sha));
    db.prepare(`INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("wfrun_grill", "grill-plan", 1, "s", "{}", "projA", "run1", "succeeded", JSON.stringify(inputs), JSON.stringify(grill.output), 20, 20);
    return { phases, phaseId: phase.id };
  };
  const check = (rig: Awaited<ReturnType<typeof rigPhase>>) => rig.phases.planCheck({ phaseId: rig.phaseId, decision: "approve", by: "t", wfRunId: "wfrun_plan" });
  const open = { status: "open", open: ["which shard migrates first"] };

  it("[sma:k_v_grill] an open grill of THIS plan refuses the plan-check caller with the reason and the two ways out", async () => {
    const rig = await rigPhase({ inputs: { plan_sha: "$SHA", phase_id: "x" }, output: open });
    const refusal = await check(rig).then(() => null, (cause: unknown) => cause as Error & { why: string[] });
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain("wfrun_grill");
    expect(refusal!.why.join("\n")).toContain("which shard migrates first");
    expect(refusal!.why.join("\n")).toMatch(/resubmit the plan/);
    expect(refusal!.why.join("\n")).toContain("phase.grill_gate=off");
  });

  it("[sma:k_v_grill] a grill of another plan's sha does not hold", async () => {
    const rig = await rigPhase({ inputs: { plan_sha: "0".repeat(64), phase_id: "x" }, output: open });
    expect((await check(rig)).stage).not.toBe("planning");
  });

  it("[sma:k_v_grill] a grill that ended `done` does not hold, even with a non-empty open list; an older grill with no plan sha never holds", async () => {
    const done = await rigPhase({ inputs: { plan_sha: "$SHA" }, output: { status: "done", open: ["left over"] } });
    expect((await check(done)).stage).not.toBe("planning");
    await dispose?.(); dispose = null;
    const older = await rigPhase({ inputs: {}, output: open });
    expect((await check(older)).stage).not.toBe("planning");
  });
});

describe("stream i2 graphs: docs-nightly checks who calls it", () => {
  const caller = async (thread: { projectId: string; role: string }) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
      threads: { get: async () => ({ id: "thr_x", projectId: thread.projectId }), getPluginMetadata: async () => ({ role: thread.role }) } as never,
      projects: { get: async () => { throw new Error("stop: past the caller check"); }, list: async () => [] } as never,
    } });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    return harness;
  };

  it("[sma:k_ag_docwriter] refused from a thread of another project and from a non-PM thread, each naming the reason", async () => {
    const foreign = await caller({ projectId: "proj_other", role: "pm" });
    const a = await foreign.behavior.runCli(["docs-nightly", "proj_docs", "--assignment", "x"], { threadId: "thr_x" } as never) as { exitCode: number; stderr?: string };
    expect(a.exitCode).toBe(1);
    expect(a.stderr).toMatch(/refused: docs-nightly from a thread reaches only that thread's own project \(proj_other\), not proj_docs/);
    await dispose?.(); dispose = null;
    const writer = await caller({ projectId: "proj_docs", role: "writer" });
    const b = await writer.behavior.runCli(["docs-nightly", "proj_docs"], { threadId: "thr_x" } as never) as { exitCode: number; stderr?: string };
    expect(b.exitCode).toBe(1);
    expect(b.stderr).toMatch(/refused: docs-nightly is not for a writer thread; ask the PM or the owner/);
  });

  it("[sma:k_ag_docwriter] the project's own PM thread passes the check, and no thread at all is unrestricted (the first test above)", async () => {
    const pm = await caller({ projectId: "proj_docs", role: "pm" });
    const result = await pm.behavior.runCli(["docs-nightly", "proj_docs"], { threadId: "thr_x" } as never) as { exitCode: number; stderr?: string };
    expect(result.stderr ?? "").not.toMatch(/^refused: docs-nightly/);
  });
});
