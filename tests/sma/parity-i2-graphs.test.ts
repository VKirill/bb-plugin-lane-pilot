import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { planSignature, type PlanItem } from "../../src/rooms/phase/logic";
import { savePhase } from "../../src/rooms/phase/store";
import { createRun, openDatabase, saveProjectSetting, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { localDateKey } from "../../src/rooms/docs/docs";

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
      .run("wfrun_grill", "grill-plan", 1, "s", "{}", "projA", "run1", "succeeded", "{}", JSON.stringify({ status: "open", open: ["which shard migrates first", "rollback window"] }), 20, 20);

    // Blocked: admission waits and names the open challenges and the lift.
    const held = await phases.planCheck({ phaseId: await open(), decision: "approve", by: "t", wfRunId: "wfrun_plan" });
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
