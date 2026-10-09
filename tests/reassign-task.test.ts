import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noOptionalPlugins } from "./optional-plugin-stubs";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { classifyFailure } from "../src/rooms/runs/failure-class";
import { countChargedAttempts, createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan,
  setAttemptDirtBefore, setAttemptWorkspace, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { createWriterStart } from "../src/rooms/writer/server/start";
import { createWriterReassign, reassignedReason, takeReassignRequest } from "../src/rooms/writer/server/reassign";
import { loadArea } from "../src/rooms/writer/server/sticky";

const WORKSPACE = "/ws";
const WORKTREE = "/wt/T1-a1";
const BASELINE = [{ path: "stray.txt", sha256: "baseline" }];

const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE,
  pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };

const contract = (id: string, area?: string): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [], depends_on: [],
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
  ...(area ? { area } : {}),
});

/** A host with a run, a task and one attempt of it; `stops` records the writer threads the reassignment stopped. */
function setup(taskArea?: string) {
  const { bb, harness: fake } = createFakePluginHost({ pluginId: "lane-pilot" });
  const stops: string[] = [];
  fake.sdk.stub("threads.stop", async (args: { threadId: string }) => { stops.push(args.threadId); return {}; });
  fake.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  fake.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: contract("T1", taskArea) });
  return { bb, db, stops, fake };
}

/** Attempt T1-a1 running in thr_w, the way the writer loop leaves it once its writer is started. */
function runningAttempt(db: ReturnType<typeof setup>["db"], id = "T1-a1", threadId = "thr_w") {
  createAttempt(db, { id, runId: "run1", taskId: "T1" });
  transitionAttempt(db, id, "spawn_requested");
  transitionAttempt(db, id, "running", { threadId });
}

/** A new attempt the writer loop would start after the old writer stopped; it is what the reassignment waits for. */
const startNextAttempt = (db: ReturnType<typeof setup>["db"]) => async () => {
  createAttempt(db, { id: "T1-a2", runId: "run1", taskId: "T1" });
  transitionAttempt(db, "T1-a2", "spawn_requested");
  transitionAttempt(db, "T1-a2", "running", { threadId: "thr_new" });
};

const reassigner = (env: ReturnType<typeof setup>, sleep: () => Promise<void> = async () => undefined) =>
  createWriterReassign({ bb: env.bb, db: env.db } as never, { timeoutMs: 50, sleep });

describe("a reassigned attempt is free", () => {
  it("classifies the stopped writer of a reassignment as free and leaves it out of the charged attempts", () => {
    expect(classifyFailure("canceled", reassignedReason("model moved to m2")).cls).toBe("reassign");
    const env = setup();
    runningAttempt(env.db);
    transitionAttempt(env.db, "T1-a1", "validation_failed", { reason: "verification failed (npm test): boom" });
    expect(countChargedAttempts(env.db, "run1", "T1")).toBe(1);
    createAttempt(env.db, { id: "T1-a2", runId: "run1", taskId: "T1" });
    transitionAttempt(env.db, "T1-a2", "spawn_requested");
    transitionAttempt(env.db, "T1-a2", "running", { threadId: "thr_new" });
    transitionAttempt(env.db, "T1-a2", "cancel_requested");
    transitionAttempt(env.db, "T1-a2", "canceled", { reason: reassignedReason("moved") });
    expect(countChargedAttempts(env.db, "run1", "T1")).toBe(1);
    // The same stop without the reassignment reason is a charged attempt of the task.
    transitionAttempt(env.db, "T1-a2", "canceled", { reason: "writer stop observed before validation" });
    expect(countChargedAttempts(env.db, "run1", "T1")).toBe(2);
  });
});

describe("lane_pilot_reassign_task", () => {
  it("stops the running writer, saves the requested model for the next writer, and returns the new thread", async () => {
    const env = setup();
    runningAttempt(env.db);
    const result = await reassigner(env, startNextAttempt(env.db)).reassignTask({
      projectId: "proj1", runId: "run1", taskId: "T1", model: "m2", providerId: "p2", reasoningEffort: "high",
    });
    expect(result).toEqual({ ok: true, taskId: "T1", oldThreadId: "thr_w", newThreadId: "thr_new", providerId: "p2", model: "m2" });
    expect(env.stops).toEqual(["thr_w"]);
    expect(getAttempt(env.db, "T1-a1")?.state).toBe("cancel_requested");
    expect(await takeReassignRequest(env.bb.storage.kv as never, "T1-a1")).toEqual({
      reason: "reassigned by the PM", selection: { providerId: "p2", model: "m2", reasoningLevel: "high" },
    });
  });

  it("with no model it keeps the current writer settings and asks for no particular model", async () => {
    const env = setup();
    runningAttempt(env.db);
    const result = await reassigner(env, startNextAttempt(env.db)).reassignTask({ projectId: "proj1", runId: "run1", taskId: "T1", reason: "stuck" });
    expect(result).toMatchObject({ ok: true, providerId: "p", model: "wm", newThreadId: "thr_new" });
    expect(await takeReassignRequest(env.bb.storage.kv as never, "T1-a1")).toEqual({ reason: "stuck", selection: null });
  });

  it("returns newThreadId null when the next writer has not started before the wait ends", async () => {
    const env = setup();
    runningAttempt(env.db);
    const result = await reassigner(env).reassignTask({ projectId: "proj1", runId: "run1", taskId: "T1" });
    expect(result).toMatchObject({ ok: true, oldThreadId: "thr_w", newThreadId: null });
  });

  it("refuses a finished task as not_reassignable with its state, and stops nothing", async () => {
    const env = setup();
    runningAttempt(env.db);
    transitionAttempt(env.db, "T1-a1", "accepted");
    const result = await reassigner(env).reassignTask({ projectId: "proj1", runId: "run1", taskId: "T1", model: "m2" });
    expect(result).toMatchObject({ ok: false, error: "not_reassignable", state: "accepted" });
    expect(env.stops).toEqual([]);
  });

  it("refuses a queued task: it has no writer yet", async () => {
    const env = setup();
    createAttempt(env.db, { id: "T1-a1", runId: "run1", taskId: "T1" });
    const result = await reassigner(env).reassignTask({ projectId: "proj1", runId: "run1", taskId: "T1", model: "m2" });
    expect(result).toMatchObject({ ok: false, error: "not_reassignable", state: "queued" });
    expect(env.stops).toEqual([]);
  });

  it("refuses a task with no attempt in the run", async () => {
    const env = setup();
    const result = await reassigner(env).reassignTask({ projectId: "proj1", runId: "run1", taskId: "T1" });
    expect(result).toMatchObject({ ok: false, error: "not_reassignable", state: "missing" });
  });

  it("stops the area's sticky writer from pointing at the old thread", async () => {
    const env = setup("page:/shop");
    runningAttempt(env.db);
    const record = { area: "page:/shop", runId: "run1", threadId: "thr_w", attemptId: "T0-a1", acceptedAt: 1, tasks: [], files: [] };
    await env.bb.storage.kv.set("area:proj1:page:/shop", record as never);
    await reassigner(env, startNextAttempt(env.db)).reassignTask({ projectId: "proj1", runId: "run1", taskId: "T1", model: "m2" });
    expect(await loadArea(env.bb.storage.kv as never, "proj1", "page:/shop")).toBeNull();
  });
});

// The writer loop end to end: the reassigned writer continues the old worktree on the requested model, spends no attempt.
type Spawn = { attemptId: string; emergency?: { providerId: string; model: string; reason: string; reasoningLevel?: string };
  continuation?: { workspacePath: string; environmentId: string | null; dirtBefore: unknown; fromThreadId: string; brief: string } };

function loopHarness() {
  const { bb, harness: fake } = createFakePluginHost({ pluginId: "lane-pilot" });
  const stops: string[] = [];
  fake.sdk.stub("threads.stop", async (args: { threadId: string }) => { stops.push(args.threadId); return {}; });
  fake.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  fake.sdk.stub("threads.send", async () => undefined);
  fake.sdk.stub("threads.context", async () => ({ usage: null }));
  fake.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  fake.sdk.stub("threads.events.list", async (query: { types?: unknown }) => query.types ? [] : [
    { data: { item: { type: "agentMessage", text: "Parser half done" } } },
  ]);
  fake.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const hostCalls: Array<{ method: string; args: unknown }> = [];
  const callHost = ctx.host.call.bind(ctx.host);
  (ctx.host as { call: unknown }).call = async (method: string, args: unknown, options: unknown) => {
    hostCalls.push({ method, args });
    if (method === "runCommand") return { exitCode: 0, stdout: " M parser.ts\n", stderr: "" };
    if (method === "gitRemoveWorktree") return { status: "removed" };
    return callHost(method as never, args as never, options as never);
  };
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  const spawns: Spawn[] = [];
  const reassign = createWriterReassign({ bb, db } as never, { timeoutMs: 2000, sleep: async () => new Promise((resolve) => setTimeout(resolve, 5)) });
  let waiting: Promise<string | null> | null = null;
  let turn = 0;
  const services = {
    activeWriterTasks: new Set<string>(),
    providerBreaker: { record: () => undefined },
    ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
    maintainMemoryAfterAcceptance: () => undefined,
    maintainProjectLifeAfterAcceptance: () => undefined,
    isLiveFolder: async () => false,
    workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }),
    spawnWriterAttempt: async (input: Spawn) => {
      spawns.push({ attemptId: input.attemptId, emergency: input.emergency, continuation: input.continuation });
      const threadId = spawns.length === 1 ? "thr_w" : `thr_r${spawns.length - 1}`;
      const dirtBefore = input.continuation ? input.continuation.dirtBefore : BASELINE;
      const workspacePath = input.continuation ? input.continuation.workspacePath : WORKTREE;
      setAttemptWorkspace(db, input.attemptId, { path: workspacePath, environmentId: null,
        decision: { strategy: "provision_attempt_worktree", reason: "explicit_worktree" } });
      setAttemptDirtBefore(db, input.attemptId, dirtBefore as never);
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId });
      return { ok: true, threadId, providerId: input.emergency?.providerId ?? "p", model: input.emergency?.model ?? "wm", dirtBefore, workspacePath };
    },
    finishWriterAttempt: async (input: { attemptId: string; writerThreadId: string }) => {
      const step = turn++;
      if (step === 0) {
        // The PM reassigns the running task while its writer works: the request is stored and the old writer stopped, then the
        // stop ends the attempt; the next writer is started by the loop, which the reassignment waits for.
        const requested = await reassign.requestReassign({ projectId: "proj1", runId: "run1", taskId: "T1", providerId: "p2", model: "m2", reason: "owner wants m2" });
        if (!requested.ok) throw new Error(requested.reason);
        waiting = reassign.awaitReassignedThread("run1", "T1", requested.oldAttemptNo);
        transitionAttempt(db, input.attemptId, "canceled", { threadId: input.writerThreadId, reason: "writer stop observed after: stopped" });
        return { status: "canceled", attemptId: input.attemptId, writerThreadId: input.writerThreadId };
      }
      transitionAttempt(db, input.attemptId, "accepted");
      return { status: "accepted", produced: ["a.txt"], verification: [], attemptId: input.attemptId };
    },
  } as unknown as Services;
  return { db, bb, ctx, stops, spawns, hostCalls, services, harness: fake, newThread: () => waiting };
}

type LoopEnv = ReturnType<typeof loopHarness>;
const task = () => contract("T1");

function startLoop(env: LoopEnv) {
  createTask(env.db, { id: "T1", runId: "run1", kind: "bb", contract: task() });
  saveTaskPlan(env.db, "T1", "Plan for T1");
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
    recordStage(env.db, { runId: "run1", taskId: "T1", stageId, state: "pending", input: "Plan for T1" });
  }
  createAttempt(env.db, { id: "T1-a1", runId: "run1", taskId: "T1" });
  Object.assign(env.services, createWriterStart(env.ctx, env.services));
  env.services.startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "T1-a1", pmThreadId: "thr_pm", config: config, task: task(), plan: "Plan for T1" });
}

describe("the writer loop continues a reassigned task", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("starts the next writer in the old worktree on the requested model, and no attempt is charged", async () => {
    const env = loopHarness();
    startLoop(env);
    await vi.waitFor(() => expect(listStageReceipts(env.db, "run1", "T1").find((row) => row.stageId === "writer-agent")?.state).toBe("passed"));
    expect(await env.newThread()).toBe("thr_r1");
    expect(env.stops).toEqual(["thr_w"]);
    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[0]!.continuation).toBeUndefined();
    expect(env.spawns[1]!.emergency).toEqual({ providerId: "p2", model: "m2", reason: "reassigned by the PM" });
    expect(env.spawns[1]!.continuation).toMatchObject({ workspacePath: WORKTREE, environmentId: null, fromThreadId: "thr_w", dirtBefore: BASELINE });
    expect(env.spawns[1]!.continuation!.brief).toContain("Stop reason: reassigned by the PM: owner wants m2");
    expect(env.spawns[1]!.continuation!.brief).toContain(" M parser.ts");
    // The stopped attempt is free: only the accepted one of the continued writer is charged.
    expect(getAttempt(env.db, "T1-a1")).toMatchObject({ state: "canceled" });
    expect(getAttempt(env.db, "T1-a1")?.reason).toMatch(/^reassigned: owner wants m2/);
    expect(countChargedAttempts(env.db, "run1", "T1")).toBe(1);
    expect(env.hostCalls.filter((call) => call.method === "gitRemoveWorktree")).toEqual([]);
    await env.harness.lifecycle.dispose();
  });
});
