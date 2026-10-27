import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../../src/rooms/storage/database";
import { createSelfRepair, pointsAtEngine } from "../../src/rooms/self-repair/server/self-repair";
import { SELF_REPAIR, builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { maybeNotifyWorkflowRun } from "../../src/rooms/workflow/server/pm-notice";
import type { ServerCore } from "../../src/rooms/core/server/core";

const turn = (seq: number, type: string, data: Record<string, unknown> = {}) => ({ seq, type, createdAt: 1_000 + seq, threadId: "thr_repair1", data });
const finished = [turn(3, "turn/completed", { status: "completed" }), turn(2, "turn/started"), turn(1, "client/turn/requested")];
const settle = async (ready: () => boolean | Promise<boolean>) => { for (let tick = 0; tick < 300 && !(await ready()); tick++) await new Promise((done) => setTimeout(done, 10)); };

/** The watcher with a real workflow engine and the graph's executors, over a fake host: one repair kind in the state, ready to be started. */
function setup(options: { status?: Record<string, string>; outputs?: Record<string, string>; spawnError?: Error; reason?: string } = {}) {
  const status = options.status ?? {};
  const spawns: Array<Record<string, any>> = [];
  const hostCalls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let next = 0;
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_mac", path: "/repo/lane-pilot" }) as never },
      plugins: { callRpc: async () => ({ ok: true }) },
      threads: {
        output: async ({ threadId }: { threadId: string }) => ({ output: options.outputs?.[threadId] ?? "" }) as never,
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: status[threadId] ?? "idle" }) as never,
        events: { list: async () => (status.thr_repair1 === "active" ? finished.slice(1) : finished) as never },
        spawn: async (input: Record<string, any>) => {
          if (options.spawnError) throw options.spawnError;
          spawns.push(input);
          return { id: `thr_repair${++next}` } as never;
        },
      },
    } as never,
  });
  const db = openDatabase(bb);
  const host = {
    call: async (method: string, input: Record<string, unknown>) => {
      hostCalls.push({ method, input });
      if (method === "gitCreateWorktree") return { status: "ready", path: `/wt/${String(input.name)}/lane-pilot`, branch: `lane/${String(input.name)}`, reason: null };
      if (method === "gitIntegrate") return { status: "merged", commit: "abcdef1234567890abcdef1234567890abcdef12", conflicts: [], reason: null };
      return { ok: true };
    },
  };
  const state = { disposed: false };
  const logs: string[] = [];
  const ctx = { bb, db, host, log: (message: string) => logs.push(message), isDisposed: () => state.disposed } as unknown as ServerCore;
  const engine = new WorkflowEngine({ db, harnessVersion: "t", isDisposed: () => state.disposed });
  const repair = createSelfRepair(ctx, () => engine);
  repair.registerGraph(engine);
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_run (id,project_id,pm_thread_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("lprun_a", "proj_real", "thr_pm", "running", now, now);
  const reason = options.reason ?? "cannot read writer-workspace git diff: host plugin calls are unavailable";
  db.prepare("INSERT INTO lane_pilot_attempt (id,run_id,task_id,thread_id,state,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("lpattempt_1", "lprun_a", "task-1", "thr_w_1", "validation_failed", reason, now, now);
  db.prepare(`INSERT INTO lane_pilot_failure_triage (project_id,attempt_id,run_id,task_id,reason_sha256,reason,origin,status,failed_at,triaged_at)
    VALUES (?,?,?,?,?,?,?,'ok',?,?)`).run("proj_real", "lpattempt_1", "lprun_a", "task-1", "x", reason, "orchestrator", now, now);
  const runs = () => db.prepare("SELECT * FROM lane_pilot_wf_run WHERE workflow_id=?").all(SELF_REPAIR) as Array<Record<string, any>>;
  return { ctx, db, bb, engine, repair, spawns, hostCalls, logs, runs, state, status };
}

describe("self-repair as a graph", () => {
  it("is a starter graph of the watcher: worktree, repair thread, verdict", () => {
    const workflow = builtinWorkflow(SELF_REPAIR)!;
    expect(workflow).toMatchObject({ id: "lp.self-repair", startedBy: "self-repair", status: "published" });
    expect(workflow.nodes.map((node) => node.id)).toEqual(["worktree", "repair", "verdict", "done"]);
    expect(workflow.nodes.find((node) => node.id === "repair")).toMatchObject({ type: "agent", role: "repairer", uses: "lp.repair" });
  });

  it("a repair is a run: the watcher starts it, the repair thread is a step tagged with the run, and the fixed branch is merged by the verdict step", async () => {
    const t = setup({ outputs: { thr_repair1: "Cause found.\nSELF-REPAIR-VERDICT: fixed" } });
    const result = await t.repair.tick({ since: 0 });
    expect(result).toMatchObject({ spawned: "thr_repair1", reason: "started" });
    expect(t.spawns[0]).toMatchObject({
      projectId: "proj_ejbam66722", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", permissionMode: "full",
      environment: { type: "host", hostId: "host_mac", workspace: { type: "unmanaged", path: expect.stringMatching(/^\/wt\/self-repair-[0-9a-f]{8}-[a-z0-9]+\/lane-pilot$/) } },
    });
    const [run] = t.runs();
    expect(t.spawns[0]!.pluginMetadata).toMatchObject({ role: "self-repair", lanePilotWorkflowRunId: run!.id, lanePilotWorkflowNode: "repair" });
    await Promise.race([t.engine.idle(), new Promise((done) => setTimeout(done, 3000))]);
    const finishedRun = t.runs()[0]!;
    expect(finishedRun).toMatchObject({ status: "succeeded", link_run_id: null });
    expect(JSON.parse(finishedRun.output_json)).toMatchObject({ verdict: "fixed", thread_id: "thr_repair1" });
    expect(t.hostCalls.filter((call) => call.method === "gitIntegrate")).toHaveLength(1);
    expect(t.hostCalls.find((call) => call.method === "gitIntegrate")?.input).toMatchObject({ basePath: "/repo/lane-pilot", removeWorktree: true, message: expect.stringContaining("self-repair:") });
    // The watcher's state is what it has always been: the verdict, the merge outcome, no worktree left, the thread in the day's list.
    const stored = await t.repair.state();
    const [record] = Object.values(stored.signatures);
    expect(record).toMatchObject({ threadId: "thr_repair1", verdict: "fixed", worktree: null, pending: null, outcome: expect.stringMatching(/^merged /), mergedCommit: "abcdef1234567890abcdef1234567890abcdef12" });
    expect(stored.spawned).toEqual([expect.objectContaining({ threadId: "thr_repair1" })]);
    // A second pass over the same kind starts nothing and settles nothing again.
    expect((await t.repair.tick({ since: 0 })).spawned).toBeNull();
    expect(t.hostCalls.filter((call) => call.method === "gitIntegrate")).toHaveLength(1);
  });

  it("while the run is going the watcher's passes leave its thread alone, and the run settles it when the thread ends", async () => {
    const t = setup({ status: { thr_repair1: "active" }, outputs: { thr_repair1: "SELF-REPAIR-VERDICT: not-lane-pilot" } });
    expect((await t.repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    expect((await t.repair.tick({ since: 0 })).spawned).toBeNull();
    expect(t.runs()).toHaveLength(1);
    expect(t.runs()[0]!.status).toBe("running");
    expect(Object.values((await t.repair.state()).signatures)[0]).toMatchObject({ verdict: null, runId: t.runs()[0]!.id });
    t.status.thr_repair1 = "idle";
    await settle(() => t.runs()[0]!.status === "succeeded");
    expect(JSON.parse(t.runs()[0]!.output_json)).toMatchObject({ verdict: "not-lane-pilot" });
    // Any verdict but fixed: nothing merged, the worktree saved as a patch and released.
    expect(t.hostCalls.some((call) => call.method === "gitIntegrate")).toBe(false);
    expect(t.hostCalls.map((call) => call.method)).toEqual(expect.arrayContaining(["gitWorktreeSnapshot", "gitRemoveWorktree"]));
    expect(Object.values((await t.repair.state()).signatures)[0]).toMatchObject({ verdict: "not-lane-pilot", worktree: null, outcome: "released: not-lane-pilot" });
  });

  it("a reload in the middle of a repair loses nothing: the next instance resumes the run on the same thread, spawns nothing again and settles the verdict", async () => {
    const t = setup({ status: { thr_repair1: "active" }, outputs: { thr_repair1: "SELF-REPAIR-VERDICT: fixed" } });
    expect((await t.repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    // The plugin stops: the step holds instead of failing, the engine gives its runs back.
    t.state.disposed = true;
    t.engine.dispose();
    await new Promise((done) => setTimeout(done, 1_300));
    expect(t.runs()[0]!.status).toBe("running");
    // The next instance: its own engine over the same database, its own context.
    const ctx2 = { ...t.ctx, isDisposed: () => false } as unknown as ServerCore;
    const engine2 = new WorkflowEngine({ db: t.db, harnessVersion: "t" });
    createSelfRepair(ctx2, () => engine2).registerGraph(engine2);
    t.status.thr_repair1 = "idle";
    await engine2.resume();
    await settle(() => t.runs()[0]!.status === "succeeded");
    expect(t.spawns).toHaveLength(1);
    expect(JSON.parse(t.runs()[0]!.output_json)).toMatchObject({ verdict: "fixed", thread_id: "thr_repair1" });
    expect(t.hostCalls.filter((call) => call.method === "gitIntegrate")).toHaveLength(1);
    expect(Object.values((await createSelfRepair(ctx2).state()).signatures)[0]).toMatchObject({ verdict: "fixed", outcome: expect.stringMatching(/^merged /) });
  });

  it("a spawn that fails fails the run quietly and gives the worktree back", async () => {
    const t = setup({ spawnError: new Error("provider unavailable") });
    const result = await t.repair.tick({ since: 0 });
    expect(result.spawned).toBeNull();
    expect(result.reason).toMatch(/^spawn failed: /);
    await t.engine.idle();
    expect(t.runs()[0]).toMatchObject({ status: "failed" });
    expect(t.hostCalls.map((call) => call.method)).toEqual(expect.arrayContaining(["gitCreateWorktree", "gitWorktreeSnapshot", "gitRemoveWorktree"]));
    expect(Object.values((await t.repair.state()).signatures)[0]).toMatchObject({ threadId: null, pending: null });
    expect(Object.values((await t.repair.state()).signatures)[0]!.worktree ?? null).toBeNull();
    // No notice, to the PM chat or to the owner's list, for the machine's own repair.
    const sent: unknown[] = [];
    expect(await maybeNotifyWorkflowRun({ bb: { sdk: { threads: { send: async (request: never) => { sent.push(request); } } }, storage: t.bb.storage as never }, log: () => undefined, run: { ...t.runs()[0], status: "failed" } as never, pmThreadId: "thr_pm", startedBySchedule: false })).toBe(false);
    expect(sent).toEqual([]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item WHERE source='workflow'").get()).toEqual({ n: 0 });
  });

  it("a kind of failure whose class is the workflow engine keeps the direct spawn: no run, the thread starts as before", async () => {
    const t = setup({ reason: "internal_error: packages/workflow-engine/src/engine.ts: the journal refused step wfrun_1" });
    const result = await t.repair.tick({ since: 0 });
    expect(result).toMatchObject({ spawned: "thr_repair1", reason: "started" });
    expect(t.runs()).toEqual([]);
    expect(t.spawns[0]!.pluginMetadata).not.toHaveProperty("lanePilotWorkflowRunId");
    expect(t.spawns[0]!.pluginMetadata).toMatchObject({ role: "self-repair" });
  });

  it("tells the engine's own failures from the rest by a fault in its code, its tables or its availability", () => {
    // An error in the engine's code (a stack frame or a site), a database error on its tables, the engine reported down or its drive crashed.
    expect(pointsAtEngine("triage:x:y", [{ reason: "TypeError at packages/workflow-engine/src/journal.ts:12" }])).toBe(true);
    expect(pointsAtEngine("triage:x:y", [{ reason: "TypeError: x is undefined\n    at Engine.drive (/srv/lane-pilot/packages/workflow-engine/src/engine.ts:905:12)" }])).toBe(true);
    expect(pointsAtEngine("triage:x:y", [{ reason: "internal_error: packages/workflow-engine/src/engine.ts: the journal refused step wfrun_1" }])).toBe(true);
    expect(pointsAtEngine("triage:x:y", [{ reason: "no such column in lane_pilot_wf_step" }])).toBe(true);
    expect(pointsAtEngine("triage:x:y", [{ reason: "SqliteError: SQLITE_CONSTRAINT: UNIQUE constraint failed: lane_pilot_wf_run.idem_key" }])).toBe(true);
    expect(pointsAtEngine("night:x:y", [], "SITE: src/rooms/workflow/server/workflow-executors.ts:40")).toBe(true);
    expect(pointsAtEngine("log:x:y", [{ reason: "Lane Pilot workflow run wfrun_1 (code-review) stopped with an error: x is not a function" }])).toBe(true);
    expect(pointsAtEngine("triage:x:y", [{ reason: "the workflow engine is not up yet" }])).toBe(true);
    expect(pointsAtEngine("triage:x:y", [{ reason: "engine_unavailable: the workflow engine is not running; the task was not changed" }])).toBe(true);
  });

  it("does not take for an engine fault what only names the engine: a path, a table, a phrase or a log prefix with no fault in it", () => {
    for (const reason of [
      "merge_failed: another writer holds the base",
      "step_failed:verify in the docs graph",
      // a task that touches the engine's files is not the engine failing
      "ownership: the writer edited src/rooms/workflow/server/workflow-router-model.ts outside owns_paths",
      "expected_outputs missing: packages/workflow-engine/src/schema.ts was not produced",
      "validation_failed: owns_paths src/rooms/workflow/ and packages/workflow-engine/ overlap with a running task",
      // a check or a test that reads the engine's tables or fails in a test file of the engine's folder
      "tests/workflow/router.test.ts failed: expected 2 rows in lane_pilot_wf_run, got 3",
      "FAIL packages/workflow-engine/src/engine.test.ts:40 AssertionError: expected succeeded",
      "the verification query SELECT count(*) FROM lane_pilot_wf_step ran in 3 s and returned 40",
      // the phrases and prefixes a healthy engine's runs carry
      "the docs graph run in the workflow engine failed at verify: the docs were not updated",
      "Lane Pilot workflow: run wfrun_1 stopped",
      "Lane Pilot workflow run wfrun_1 (code-review) failed: writer attempt blocked",
      "wfe-1 harness_version 0.1.300 run blocked: unmet goals",
      "WorkflowEngine run wfrun_9 is waiting for the owner's answer",
    ]) {
      expect(pointsAtEngine("triage:x:y", [{ reason }]), reason).toBe(false);
      expect(pointsAtEngine("night:x:y", [], reason), reason).toBe(false);
    }
  });
});
