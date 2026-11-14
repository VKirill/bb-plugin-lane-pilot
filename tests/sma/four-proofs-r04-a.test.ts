// Region 4 · Daemon tick — contract tests added by the four-proofs batch (docs/sma-evidence.md). Each one goes from the card's entry (the
// registered schedule, the sweep, the admission) to the effect a person or the next stage reads, never only to «a function was called».
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { createPhaseDriver } from "../phase-driver";
import { createReconcile } from "../../src/rooms/stability/server/reconcile";
import { spawnWriterAttemptWatched, START_STALL_MS } from "../../src/rooms/writer/server/spawn-watchdog";
import { createWriterStart } from "../../src/rooms/writer/server/start";
import { setConveyor } from "../../src/rooms/runs";
import { designDecision, planSignature, type PlanItem } from "../../src/rooms/phase/logic";
import { savePhase } from "../../src/rooms/phase/store";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import {
  createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt,
} from "../../src/rooms/plugin-db";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import type { Services } from "../../server";

type Registration = { cron: string; fn: (context: { signal: AbortSignal }) => unknown; options: { isolated?: boolean; timeoutMs?: number; overlap?: string } };

/** A fake host whose core has the isolated-schedule function: every registration is kept, so a test fires the schedule itself. */
function hostWithSchedules(sdk: Record<string, unknown> = {}) {
  const made = createFakePluginHost({ pluginId: "lane-pilot", sdk: sdk as never });
  const registered = new Map<string, Registration>();
  (made.bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, cron: string, fn: Registration["fn"], options: Registration["options"]) => { registered.set(name, { cron, fn, options }); };
  const fire = (name: string) => Promise.resolve(registered.get(name)!.fn({ signal: new AbortController().signal }));
  return { ...made, registered, fire };
}

describe("daemon tick, from the timer", () => {
  it("[sma:dt_timer] the plugin registers the pass isolated and a fired timer drives a phase one step: its PM gets the step", async () => {
    const sent: string[] = [];
    const { bb, harness, registered, fire } = hostWithSchedules();
    harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
    harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
    harness.sdk.stub("threads.list", async () => []);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    // A phase is opened by the same database the plugin reads; nothing but the timer moves it afterwards.
    const phases = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined } } as unknown as Services).phases;
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Tick", goal: "see the tick" });
    await plugin(bb);
    const registration = registered.get("phase-drive")!;
    expect(registration.options).toMatchObject({ isolated: true, overlap: "skip" });
    expect(sent.filter((text) => text.includes("stage 1, discussion"))).toEqual([]);
    await fire("phase-drive");
    const pokes = sent.filter((text) => text.includes(`Phase ${phase.id}`) && text.includes("stage 1, discussion"));
    expect(pokes).toHaveLength(1);
    // The next timer finds the same step already told: one wait, one message.
    await fire("phase-drive");
    expect(sent.filter((text) => text.includes(`Phase ${phase.id}`) && text.includes("stage 1, discussion"))).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
});

describe("daemon tick, the idle pass", () => {
  const item = (id: string): PlanItem => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" },
    task: { id, owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["passes"], project_cwd: "/repo" } });

  it("[sma:dt_idle] the pass says why it took nothing: no live phase, every phase waits for the PM, or every phase is at work", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.send", async () => ({}));
    harness.sdk.stub("threads.get", async () => ({ status: "busy" }));
    harness.sdk.stub("threads.list", async () => []);
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const { phases } = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined } } as unknown as Services);
    expect(await phases.tick()).toEqual({ moved: 0, idle: "no live phase" });
    const first = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Wait", goal: "wait" });
    expect(await phases.tick()).toEqual({ moved: 0, idle: "all live phases wait for the PM" });
    // A phase whose pieces are all issued and at work is the machine's own wait: nothing is asked of the PM.
    createTask(db, { id: "p1", runId: "run1", kind: "bb", contract: item("p1").task });
    createAttempt(db, { id: "att1", runId: "run1", taskId: "p1" });
    transitionAttempt(db, "att1", "spawn_requested");
    transitionAttempt(db, "att1", "running", { threadId: "tw" });
    const sha = planSignature([item("p1")], "ctx");
    savePhase(db, first.id, { stage: "execution", runId: "run1", state: "active", record: { ...first.record, plan: { items: [item("p1")], contextSha: "ctx", sha, admittedSha: sha },
      execution: { issued: { p1: "p1" }, startedAt: 1 } } as never, at: 2 });
    expect(await phases.tick()).toEqual({ moved: 0, idle: "all live phases at work" });
    await harness.lifecycle.dispose();
  });
});

describe("daemon tick, reconciling an attempt after a restart", () => {
  const config: PrototypeConfig = { projectId: "projR", hostId: "h1", pmWorkspacePath: "/pm", writerWorkspacePath: "/ws", pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" };

  it("[sma:dt_reconcile] after a restart an attempt with no thread is matched to BB's thread by its run, task and attempt; a queued one is left to the queue", async () => {
    const triple = { lanePilotRunId: "runR", lanePilotTaskId: "taskR", attemptId: "attR" };
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.list", async () => [{ id: "writer-found" }]);
    harness.sdk.stub("threads.getPluginMetadata", async () => triple);
    harness.sdk.stub("threads.get", async () => ({ id: "writer-found", status: "active" }));
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "runR", "projR");
    setRunThread(db, "runR", "thr_pm");
    createTask(db, { id: "taskR", runId: "runR", kind: "bb", contract: {} });
    createAttempt(db, { id: "attR", runId: "runR", taskId: "taskR" });
    transitionAttempt(db, "attR", "spawn_requested");
    transitionAttempt(db, "attR", "spawn_unknown", { reason: "the plugin restarted while the spawn answer was lost" });
    createTask(db, { id: "taskQ", runId: "runR", kind: "bb", contract: {} });
    createAttempt(db, { id: "attQ", runId: "runR", taskId: "taskQ" });
    transitionAttempt(db, "attQ", "queued");
    expect(getAttempt(db, "attR")?.thread_id).toBeNull();
    const reconcile = createReconcile(createCore(bb, db), { startWriterTask: () => undefined, resumeDispatch: async () => ({ resumed: false, why: "n/a" }), rollback: {} } as never);
    const done = await reconcile.resumeOrphans("projR");
    expect(getAttempt(db, "attR")).toMatchObject({ thread_id: "writer-found", state: "running" });
    expect(getAttempt(db, "attQ")).toMatchObject({ thread_id: null, state: "queued" });
    expect(done.resumed).toContain("attR");
    // A stop the owner asked for before the restart stays a stop: the thread is found, the attempt does not turn back into running.
    createTask(db, { id: "taskC", runId: "runR", kind: "bb", contract: {} });
    createAttempt(db, { id: "attC", runId: "runR", taskId: "taskC" });
    transitionAttempt(db, "attC", "spawn_requested");
    transitionAttempt(db, "attC", "cancel_requested", { reason: "canceled while its writer was starting" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ ...triple, lanePilotTaskId: "taskC", attemptId: "attC" }));
    await reconcile.reconcileAttemptThread("projR", getAttempt(db, "attC")!);
    expect(getAttempt(db, "attC")?.state).toBe("cancel_requested");
    await harness.lifecycle.dispose();
  });
});

describe("daemon tick, the writer's start", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("[sma:dt_lease] an attempt that has no process yet stays open and holds its copy for 14 minutes, and the stall at 15 ends it writer_start_stalled", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    const logs: string[] = [];
    let settled: Awaited<ReturnType<typeof spawnWriterAttemptWatched>> | null = null;
    // The start never answers: only the watchdog can end it.
    const watched = spawnWriterAttemptWatched({ db, log: (line) => logs.push(line) }, { attemptId: "a1" } as never, () => new Promise(() => undefined));
    void watched.then((result) => { settled = result; });
    await vi.advanceTimersByTimeAsync(START_STALL_MS - 60_000);
    expect(settled).toBeNull();
    expect(getAttempt(db, "a1")?.state).toBe("spawn_requested");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(settled).toMatchObject({ ok: false, status: "spawn_rejected", attemptId: "a1" });
    expect(getAttempt(db, "a1")?.state).toBe("spawn_rejected");
    expect(getAttempt(db, "a1")?.reason).toContain("writer_start_stalled");
  });
});

describe("daemon tick, the conveyor in front of the claim", () => {
  const WS = "/ws";
  const config: PrototypeConfig = { projectId: "proj1", hostId: "host_test", pmWorkspacePath: WS, writerWorkspacePath: WS, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
  const task: TaskV2 = {
    schema_version: 2, id: "belt", title: "Task belt", risk: "low", lane: "writer", project_cwd: WS, read_first: [], interfaces: [], invariants: [],
    out_of_scope: [], expected_outputs: ["src/belt.ts"], owns_paths: ["src/"], never_touch: [], depends_on: [],
    objective: "do it", acceptance: ["done"], verify: "tests", verification: [{ command: "true", cwd: WS }],
  } as never;
  let scale: string | undefined;
  beforeEach(() => { scale = process.env.LANE_PILOT_POLL_SCALE; process.env.LANE_PILOT_POLL_SCALE = "0.0005"; });
  afterEach(() => { process.env.LANE_PILOT_POLL_SCALE = scale; });

  it("[sma:dt_switch] with the conveyor off a queued task takes no writer and says it waits; switched on it starts by itself", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
    harness.sdk.stub("threads.send", async () => undefined);
    harness.sdk.stub("threads.context", async () => ({ usage: null }));
    harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
    harness.sdk.stub("threads.events.list", async () => []);
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "proj1", "bb", WS);
    setRunThread(db, "run1", "thr_pm");
    savePrototypeConfig(db, config);
    await setConveyor(bb.storage.kv as never, false, "owner stopped the line");
    const spawned: string[] = [];
    const services = {
      activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
      runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
      runWriterPool: { acquire: async () => () => undefined },
      stability: { breakerHolds: () => null, onTaskFailed: async () => false, loadParked: async () => [], diskHolds: async () => null },
      startAfterAcceptance: () => undefined,
      workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
      spawnWriterAttempt: async (input: { attemptId: string }) => {
        spawned.push(input.attemptId);
        setAttemptWorkspace(db, input.attemptId, { path: "/ws/wt", environmentId: null, decision: {} });
        transitionAttempt(db, input.attemptId, "spawn_requested");
        transitionAttempt(db, input.attemptId, "running", { threadId: "thr_w" });
        return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [], workspacePath: "/ws/wt" };
      },
      finishWriterAttempt: async (input: { attemptId: string }) => { transitionAttempt(db, input.attemptId, "accepted"); return { status: "accepted", produced: task.expected_outputs, verification: [] }; },
    } as unknown as Services;
    createTask(db, { id: task.id, runId: "run1", kind: "bb", contract: task });
    saveTaskPlan(db, task.id, "Plan");
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run1", taskId: task.id, stageId, state: "pending", input: "Plan" });
    createAttempt(db, { id: "a1", runId: "run1", taskId: task.id });
    createWriterStart(ctx, services).startWriterTask({ projectId: "proj1", runId: "run1", taskId: task.id, firstAttemptId: "a1", pmThreadId: "thr_pm", config, task, plan: "Plan" });
    await vi.waitFor(() => expect(listStageReceipts(db, "run1", task.id).find((row) => row.stageId === "writer-agent")?.reason ?? "").toMatch(/waiting/), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spawned).toEqual([]);
    expect(getAttempt(db, "a1")?.state).toBe("queued");
    await setConveyor(bb.storage.kv as never, true);
    await vi.waitFor(() => expect(spawned).toEqual(["a1"]), { timeout: 10_000 });
    await harness.lifecycle.dispose();
  });
});

describe("daemon tick, the draftsman for a batch", () => {
  it("[sma:dt_assign_design] a plan whose piece changes screens is decided «a drawing is needed», one that does not is not", () => {
    const piece = (id: string, owns: string[]): PlanItem => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id, owns_paths: owns, verification: [{ command: "npm test" }], acceptance: ["x"], project_cwd: "/repo" } });
    const screens = designDecision([piece("api", ["src/api/**"]), piece("hud", ["src/ui/hud.tsx"])]);
    expect(screens.decision).toBe("needed");
    expect(screens.why).toContain("hud");
    expect(screens.why).not.toContain("api");
    expect(designDecision([piece("api", ["src/api/**"])]).decision).toBe("not_needed");
  });
});
