import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { breakerKey, createProviderBreaker } from "@lane-pilot/resilience";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { describe, expect, it, vi } from "vitest";
import type { TaskV2 } from "../../src/rooms/contracts";
import type { ServerCore } from "../../src/rooms/contracts/server";
import { listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import {
  createAttempt, createRun, createTask, getAttempt, openDatabase,
  saveProjectSetting, savePrototypeConfig, setAttemptWorkspace, setRunThread, transitionAttempt,
} from "../../src/rooms/plugin-db";
import { cancelAttemptById } from "../../src/rooms/runs/server";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/services/workflow-agent";
import { OWNER_WORD_WAIT_SEC } from "../../src/rooms/writer/models/attempt-timeouts";
import { emitAttemptEvent } from "../../src/rooms/writer/server/services/attempt-events";
import { recordAndPersistBreaker, restoreProviderBreaker } from "../../src/rooms/writer/server/repositories/breaker-hold";
import { registerDispatchExecutors } from "../../src/rooms/writer/server/handlers/dispatch-workflow";
import { startDispatchRun } from "../../src/rooms/writer/server/services/dispatch-workflow-ops";
import { mountPermits } from "../../src/rooms/writer/server/handlers/permits";
import { SAFE_DEFAULT_ANSWER } from "../../src/rooms/writer/models/question-default";
import { DEFAULT_WRITER_MAX_CONCURRENT, WRITER_MAX_CONCURRENT_KEY } from "../../src/rooms/writer/settings";

function makeTask(id: string, ownsPaths: string[]): TaskV2 {
  return {
    schema_version: 2,
    id,
    title: `Task ${id}`,
    display_title: `Task ${id}`,
    kind: "fix",
    area: "writer",
    risk: "medium",
    lane: "writer",
    project_cwd: "/tmp/ws",
    read_first: [],
    interfaces: [],
    invariants: [],
    out_of_scope: [],
    expected_outputs: ownsPaths,
    owns_paths: ownsPaths,
    never_touch: [],
    depends_on: [],
    objective: `Implement ${id}`,
    acceptance: [`${id} done`],
    verify: "tests",
    verification: [{ command: "npm test", cwd: "/tmp/ws", timeout_sec: 30 }],
  };
}

function registerUpstreamStubs(engine: WorkflowEngine, opts: { extra?: Record<string, unknown> } = {}) {
  engine.register("lp.execution-packet", { reentrant: true, run: async () => ({ output: { ok: true, packetSha256: "a".repeat(64), selectedLines: 1 } }) });
  engine.register("lp.pm-read", { reentrant: true, run: async () => ({ output: { state: "skipped", summary: "ok", handoff: "ok" } }) });
  engine.register("lp.plan-critique", { reentrant: true, run: async () => ({ output: { allowed: true, handoff: "ok" } }) });
  engine.register("lp.specialist-review", { reentrant: true, run: async () => ({ output: { allowed: true, handoff: "ok" } }) });
  engine.register("lp.ownership-base", { reentrant: true, run: async () => ({ output: { ok: true, live: false } }) });
  engine.register("lp.task-folder", { reentrant: true, run: async () => ({ output: { ok: true } }) });
  engine.register("lp.baseline", { reentrant: true, run: async () => ({ output: { state: "skipped" } }) });
  engine.register("lp.qa-gate", { reentrant: true, run: async () => ({ output: { run: false, ...(opts.extra ?? {}) } }) });
}

function createGraphWorld(options: {
  maxConcurrent?: number;
  silenceMin?: number;
  ownerWords?: "off" | "on";
  autoReturn?: "on" | "off";
  onSend?: (args: Record<string, unknown>) => unknown;
  onSpawn?: (input: { attemptId: string; taskId: string }) => Promise<{ writerThreadId: string }>;
  onValidate?: (input: { attemptId: string; taskId: string }) => Promise<Record<string, unknown>>;
  threadOutput?: (threadId: string) => string;
  threadStatus?: (threadId: string) => string;
  integrateStatus?: () => { status: string; commit: string | null; conflicts: string[]; reason?: string };
} = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const projectId = "proj-attempt-graph";
  const runId = "run-attempt-graph";
  const sent: Array<Record<string, unknown>> = [];
  const stopped: string[] = [];
  const spawns: Array<{ attemptId: string; taskId: string }> = [];
  let integrateCalls = 0;
  let clockNow = Date.now();
  const initialClock = clockNow;

  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({
    id: threadId,
    projectId,
    status: options.threadStatus?.(threadId) ?? "idle",
  }));
  harness.sdk.stub("threads.listRunning", async () => []);
  harness.sdk.stub("threads.send", async (args: Record<string, unknown>) => {
    sent.push(args);
    return options.onSend?.(args) ?? {};
  });
  harness.sdk.stub("threads.stop", async ({ threadId }: { threadId: string }) => {
    stopped.push(threadId);
    return {};
  });
  harness.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({
    output: options.threadOutput?.(threadId) ?? "Done",
  }));
  harness.sdk.stub("threads.events.list", async ({ threadId }: { threadId: string }) => (
    options.threadStatus?.(threadId) === "active"
      ? [
          { type: "turn/started", threadId, seq: 1, createdAt: initialClock },
          { type: "item/completed", threadId, seq: 2, createdAt: initialClock, data: { item: { type: "agentMessage" } } },
        ]
      : []
  ));
  harness.sdk.stub("files.read", async () => { throw new Error("file does not exist"); });
  harness.sdk.stub("files.write", async () => undefined);

  createRun(db, runId, projectId, "bb", "/tmp/ws");
  setRunThread(db, runId, "thr_pm");
  const config = {
    projectId,
    hostId: "host-1",
    pmWorkspacePath: "/tmp/ws",
    writerWorkspacePath: "/tmp/ws",
    pmProviderId: "anthropic",
    pmModel: "claude-opus-4-6",
    writerProviderId: "codex",
    writerModel: "gpt-6-luna",
  };
  savePrototypeConfig(db, config);
  if (options.maxConcurrent !== undefined) {
    saveProjectSetting(db, projectId, WRITER_MAX_CONCURRENT_KEY, options.maxConcurrent);
  }
  if (options.silenceMin !== undefined) {
    saveProjectSetting(db, projectId, "writer.silence_nudge_min", options.silenceMin);
  }
  if (options.ownerWords) {
    saveProjectSetting(db, projectId, "owner.words", options.ownerWords);
  }
  saveProjectSetting(db, projectId, "writer.auto_return", options.autoReturn ?? "off");
  saveProjectSetting(db, projectId, "writer.fallback1.provider", "claude-code");
  saveProjectSetting(db, projectId, "writer.fallback1.model", "claude-sonnet-4-6");

  const providerBreaker = createProviderBreaker();
  const advanceTo = async (engine: WorkflowEngine, targetMs: number) => {
    clockNow = Math.max(clockNow, targetMs);
    await engine.poll();
    await engine.idle();
  };
  const buildServices = () => ({
    stageHelperSettings: async () => ({}),
    baseline: { preflight: async () => null },
    isLiveFolder: async () => false,
    providerBreaker,
    activeWriterTasks: new Set<string>(),
    startWriterTask: () => undefined,
    providerRetry: { abandon: async () => undefined },
    spawnWriterAttempt: async (input: { attemptId: string; taskId: string }) => {
      spawns.push({ attemptId: input.attemptId, taskId: input.taskId });
      if (options.onSpawn) return options.onSpawn(input);
      const threadId = `thr_w_${input.taskId}_${spawns.length}`;
      transitionAttempt(db, input.attemptId, "spawn_requested");
      setAttemptWorkspace(db, input.attemptId, {
        path: `/tmp/ws-wt-${input.taskId}`,
        environmentId: null,
        decision: { kind: "worktree" },
      });
      transitionAttempt(db, input.attemptId, "running", { threadId });
      return { writerThreadId: threadId };
    },
    ...(options.onValidate
      ? { validateWriterResult: options.onValidate }
      : {}),
    ...(options.integrateStatus
      ? {
          validateWriterResult: async () => ({ status: "accepted", output: "ok", produced: ["a.ts"], verification: [], warnings: [] }),
          persistWriterAcceptance: async () => ({ receipt: { ok: true } }),
          workspaceDirt: async () => ({ ok: true, snapshots: [] }),
        }
      : {}),
  });

  const makeEngine = (currentServices = buildServices()) => {
    const engine = new WorkflowEngine({
      db,
      harnessVersion: "test",
      resolveWorkflow: builtinWorkflow,
      now: () => clockNow,
      resumePolicy: (run) => ((run.workflow_id === "lp-task-pipeline") && run.status !== "waiting" ? "interrupt" : "continue"),
    });
    const ctx = {
      bb,
      db,
      host: {
        call: async (method: string) => {
          if (method === "gitIntegrate") {
            integrateCalls += 1;
            return options.integrateStatus?.() ?? { status: "merged", commit: "abc123", conflicts: [] };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      configForRun: async () => config,
      getThreadBounded: async (threadId: string) => bb.sdk.threads.get({ threadId }),
      acceptedTaskWorkspace: (_r: string, _t: string, ws: string, contract: TaskV2) => ({ path: ws, task: contract }),
      log: () => undefined,
      refreshRun: () => undefined,
      isDisposed: () => false,
      cancelQueuedAttempt: (attempt: { id: string }) => {
        transitionAttempt(db, attempt.id, "canceled", { reason: "canceled" });
        return { ok: true, state: "canceled", reason: null };
      },
    } as unknown as ServerCore;
    registerDispatchExecutors(engine, bb, { services: currentServices as never, ctx });
    registerUpstreamStubs(engine);
    return { engine, ctx, services: currentServices };
  };

  const primary = makeEngine();

  const dispatchTask = async (taskId: string, ownsPaths: string[], attemptId = `att_${taskId}`) => {
    const task = makeTask(taskId, ownsPaths);
    createTask(db, { id: taskId, runId, kind: "bb", contract: task });
    createAttempt(db, { id: attemptId, runId, taskId });
    return startDispatchRun(primary.engine, {
      ctx: primary.ctx,
      services: primary.services as never,
      threadId: "thr_pm",
      projectId,
      runId,
      taskId,
      attemptId,
      config,
      runConfig: config,
      workspacePath: "/tmp/ws",
      task,
      plan: `Plan for ${taskId}`,
      lintWarnings: [],
    });
  };

  return {
    bb, harness, db, projectId, runId, config, providerBreaker,
    sent, stopped, spawns, integrateCalls: () => integrateCalls,
    engine: primary.engine, ctx: primary.ctx, makeEngine, dispatchTask, advanceTo, now: () => clockNow,
    awaitStep: (wfRunId: string, nodeId: string) =>
      primary.engine.snapshot(wfRunId)?.steps.filter((s) => s.node_id === nodeId).at(-1),
  };
}

describe("Task 13 writer attempt lifecycle graph", () => {
  it("Row 1: writer silent past threshold nudges at most 2 visits via wait-turn deadline then stops", async () => {
    const w = createGraphWorld({
      silenceMin: 10,
      threadStatus: () => "active",
    });
    try {
      const started = await w.dispatchTask("t-silent", ["src/silent.ts"]);
      await vi.waitFor(() => expect(w.engine.get(started.runId)?.status).toBe("waiting"));

      const waitStep = w.awaitStep(started.runId, "wait-turn")!;
      expect(waitStep.state).toBe("waiting");
      const awaitData = JSON.parse(waitStep.await_json!) as { kind: string; deadline: number };
      expect(awaitData.kind).toBe(LP_EVENTS.THREAD_IDLE);
      expect(awaitData.deadline).toBeGreaterThan(Date.now());

      // Timeout 1 -> nudge visit 1 -> re-parks on wait-turn
      await w.advanceTo(w.engine, awaitData.deadline + 1_000);
      expect(w.engine.snapshot(started.runId)!.steps.filter((s) => s.node_id === "nudge")).toHaveLength(1);
      expect(w.sent).toHaveLength(1);
      expect(w.sent[0]).toMatchObject({ mode: "steer-if-active" });

      // Timeout 2 -> nudge visit 2 -> re-parks on wait-turn
      const wait2 = w.awaitStep(started.runId, "wait-turn")!;
      const d2 = (JSON.parse(wait2.await_json!) as { deadline: number }).deadline;
      await w.advanceTo(w.engine, d2 + 1_000);
      expect(w.engine.snapshot(started.runId)!.steps.filter((s) => s.node_id === "nudge")).toHaveLength(2);
      expect(w.sent).toHaveLength(2);

      // Timeout 3 -> nudge maxVisits=2 exhausted -> stop-silent stops thread & blocks attempt
      const wait3 = w.awaitStep(started.runId, "wait-turn")!;
      const d3 = (JSON.parse(wait3.await_json!) as { deadline: number }).deadline;
      await w.advanceTo(w.engine, d3 + 1_000);

      const steps = w.engine.snapshot(started.runId)!.steps;
      expect(steps.filter((s) => s.node_id === "nudge")).toHaveLength(2);
      expect(steps.some((s) => s.node_id === "stop-silent" && s.state === "succeeded")).toBe(true);
      expect(w.stopped.length).toBeGreaterThanOrEqual(1);
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });

  it("Row 2: writer question wait-answer deadline cascades safe default then owner inbox; 6h owner-word wait is a deadline", async () => {
    const w = createGraphWorld({
      autoReturn: "off",
      threadOutput: () => "ASK_PM: May I edit extra file helper.ts?",
    });
    try {
      const started = await w.dispatchTask("t-question", ["src/q.ts"]);
      await vi.waitFor(() => expect(w.engine.get(started.runId)?.status).toBe("waiting"));

      const threadId = w.spawns[0]!.attemptId;
      const attempt = getAttempt(w.db, threadId)!;
      await emitAttemptEvent({ db: w.db, engine: w.engine, name: LP_EVENTS.THREAD_IDLE, key: attempt.thread_id! });
      await w.engine.idle();

      const waitAns = w.awaitStep(started.runId, "wait-answer")!;
      expect(waitAns.state).toBe("waiting");
      const ansAwait = JSON.parse(waitAns.await_json!) as { kind: string; deadline: number };
      expect(ansAwait.kind).toBe(LP_EVENTS.WRITER_ANSWERED);
      expect(ansAwait.deadline).toBeGreaterThan(Date.now());

      // Timeout 1: safe default answers the question & reopens wait-turn
      await w.advanceTo(w.engine, ansAwait.deadline + 1_000);
      expect(w.sent.some((m) => JSON.stringify(m).includes(SAFE_DEFAULT_ANSWER.split("\n")[2]!))).toBe(true);
      expect(w.awaitStep(started.runId, "wait-turn")?.state).toBe("waiting");

      // Writer asks a second question after safe default already spent -> timeout escalates to owner inbox
      const att2 = getAttempt(w.db, "att_t-question")!;
      await emitAttemptEvent({ db: w.db, engine: w.engine, name: LP_EVENTS.THREAD_IDLE, key: att2.thread_id! });
      await w.engine.idle();

      const waitAns2 = w.awaitStep(started.runId, "wait-answer")!;
      const ansAwait2 = JSON.parse(waitAns2.await_json!) as { deadline: number };
      await w.advanceTo(w.engine, ansAwait2.deadline + 1_000);

      expect(w.engine.get(started.runId)?.status).toBe("succeeded");
      const ownerItems = listOpenOwnerItems(w.db, { projectId: w.projectId });
      expect(ownerItems.some((item) => item.kind === "question_unanswered")).toBe(true);
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });

  it("Row 2b: validate requiring owner word parks on wait-answer with 6h deadline", async () => {
    const w = createGraphWorld({ ownerWords: "on" });
    try {
      const started = await w.dispatchTask("t-word", ["src/word.ts"]);
      await vi.waitFor(() => expect(w.engine.get(started.runId)?.status).toBe("waiting"));
      const attempt = getAttempt(w.db, "att_t-word")!;
      const before = Date.now();
      await emitAttemptEvent({ db: w.db, engine: w.engine, name: LP_EVENTS.THREAD_IDLE, key: attempt.thread_id! });
      await w.engine.idle();

      const waitAns = w.awaitStep(started.runId, "wait-answer")!;
      expect(waitAns.state).toBe("waiting");
      const awaitJson = JSON.parse(waitAns.await_json!) as { kind: string; deadline: number };
      expect(awaitJson.kind).toBe(LP_EVENTS.WRITER_ANSWERED);
      expect(awaitJson.deadline - before).toBeGreaterThanOrEqual((OWNER_WORD_WAIT_SEC - 5) * 1_000);
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });

  it("Row 3 & Row 5: provider limit hold waits until wakeAt surviving hub restart, and overdue/future deadlines survive engine.resume()", async () => {
    const w = createGraphWorld();
    try {
      const now = Date.now();
      const wakeAt = now + 15 * 60_000;
      const bKey = breakerKey(w.config.writerProviderId, w.config.writerModel);
      await recordAndPersistBreaker(w.bb.storage.kv as never, w.providerBreaker, bKey, "exhausted", now, wakeAt);

      const limited = await w.dispatchTask("t-breaker", ["src/b.ts"]);
      const futureTask = await w.dispatchTask("t-future", ["src/future.ts"]);
      await vi.waitFor(() => {
        expect(w.engine.get(limited.runId)?.status).toBe("waiting");
        expect(w.engine.get(futureTask.runId)?.status).toBe("waiting");
      });

      const admWait = w.awaitStep(limited.runId, "admission-wait")!;
      expect(admWait.state).toBe("waiting");
      expect((JSON.parse(admWait.await_json!) as { deadline: number }).deadline).toBe(wakeAt);
      expect(w.spawns.some((s) => s.taskId === "t-breaker")).toBe(false);

      // Simulate full hub restart: brand-new WorkflowEngine & fresh ProviderBreaker restored from KV
      const restarted = w.makeEngine();
      await restoreProviderBreaker(w.bb.storage.kv as never, restarted.services.providerBreaker, now + 10_000);
      await restarted.engine.resume();
      await restarted.engine.idle();

      // Still before wakeAt: t-breaker remains waiting, t-future kept its future deadline intact
      await w.advanceTo(restarted.engine, wakeAt - 5_000);
      expect(w.spawns.some((s) => s.taskId === "t-breaker")).toBe(false);
      expect(restarted.engine.get(limited.runId)?.status).toBe("waiting");
      expect(restarted.engine.get(futureTask.runId)?.status).toBe("waiting");

      // Advance past wakeAt: overdue deadline fires once and restarts t-breaker into spawn
      await w.advanceTo(restarted.engine, wakeAt + 1_000);
      expect(w.spawns.filter((s) => s.taskId === "t-breaker")).toHaveLength(1);
      // Settling a second time does not double-fire
      await w.advanceTo(restarted.engine, wakeAt + 2_000);
      expect(w.spawns.filter((s) => s.taskId === "t-breaker")).toHaveLength(1);
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });

  it("Row 4: model subscription ended falls back to configured role fallback and posts one owner inbox item", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const projectId = "proj-sub-fallback";
    const runId = "run-sub";
    createRun(db, runId, projectId, "bb", "/tmp/ws");
    setRunThread(db, runId, "thr_pm");
    savePrototypeConfig(db, {
      projectId, hostId: "h1", pmWorkspacePath: "/tmp/ws", writerWorkspacePath: "/tmp/ws",
      pmProviderId: "anthropic", pmModel: "claude-opus-4-6", writerProviderId: "codex", writerModel: "gpt-6-luna",
    });
    const envId = "env-1";
    let spawnCount = 0;
    const spawnedModels: Array<{ providerId?: string; model?: string }> = [];
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId, environmentId: envId, status: "idle" }));
    harness.sdk.stub("threads.listRunning", async () => []);
    harness.sdk.stub("environments.get", async () => ({ id: envId, hostId: "h1", path: "/tmp/ws" }));
    harness.sdk.stub("threads.spawn", async (args: Record<string, unknown>) => {
      spawnCount += 1;
      spawnedModels.push({ providerId: args.providerId as string, model: args.model as string });
      if (spawnCount === 1) throw new Error("Your subscription has expired (401 unauthorized)");
      return { id: `thr_helper_${spawnCount}` };
    });
    harness.sdk.stub("threads.output", async () => ({ output: '```json\n{"summary":"done","handoff":"ok"}\n```' }));
    harness.sdk.stub("threads.events.list", async ({ threadId }: { threadId: string }) => [
      { type: "turn/started", threadId, seq: 1 },
      { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
    ]);

    try {
      const ctx = {
        bb, db, host: { call: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
        effectiveProjectSettings: () => ({ values: { "role_model.analyst": { model: "gpt-6-luna", reasoning_effort: "high" } } }),
        ownedAgents: async () => ({}),
        log: () => undefined,
        isDisposed: () => false,
      } as unknown as ServerCore;

      const rt = { ctx, bb, db, projectId, runId, pmThreadId: "thr_pm", wfRunId: "wfr_1" };
      const agents = createWorkflowAgents();
      const res = await agents.run({
        rt: rt as never,
        workflowRunId: "wfr_1",
        stepKey: "s1",
        nodeId: "analyze",
        spawnKey: "k1",
        role: "analyst",
        title: "Analyze",
        prompt: "Inspect repo",
        fields: [{ name: "summary", type: "string", required: true }, { name: "handoff", type: "string", required: true }],
        skills: [],
        plugins: [],
        mcp: [],
      } as never);

      expect(res.output).toMatchObject({ summary: "done" });
      expect(spawnedModels).toHaveLength(2);
      expect(spawnedModels[0]!.providerId).not.toBe(spawnedModels[1]!.providerId);

      // Second invocation: no extra owner inbox item posted; one owner item total for the role switch
      const res2 = await agents.run({
        rt: rt as never, workflowRunId: "wfr_2", stepKey: "s2", nodeId: "analyze", spawnKey: "k2",
        role: "analyst", title: "Analyze 2", prompt: "Inspect repo 2",
        fields: [{ name: "summary", type: "string", required: true }, { name: "handoff", type: "string", required: true }],
        skills: [], plugins: [], mcp: [],
      } as never);
      expect(res2.output).toMatchObject({ summary: "done" });

      const items = listOpenOwnerItems(db, { projectId });
      expect(items.filter((i) => i.kind === "model_unavailable")).toHaveLength(1);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("four writers queued with cap 3 (default 3) -> the fourth waits until one settles", async () => {
    expect(DEFAULT_WRITER_MAX_CONCURRENT).toBe(3);
    const w = createGraphWorld();
    try {
      const r1 = await w.dispatchTask("c1", ["src/c1.ts"]);
      const r2 = await w.dispatchTask("c2", ["src/c2.ts"]);
      const r3 = await w.dispatchTask("c3", ["src/c3.ts"]);
      const r4 = await w.dispatchTask("c4", ["src/c4.ts"]);

      await vi.waitFor(() => {
        expect(w.engine.get(r1.runId)?.status).toBe("waiting");
        expect(w.engine.get(r2.runId)?.status).toBe("waiting");
        expect(w.engine.get(r3.runId)?.status).toBe("waiting");
        expect(w.engine.get(r4.runId)?.status).toBe("waiting");
      });

      expect(w.spawns.map((s) => s.taskId).sort()).toEqual(["c1", "c2", "c3"]);
      expect(w.awaitStep(r4.runId, "admission-wait")?.state).toBe("waiting");
      expect(w.awaitStep(r4.runId, "writer")).toBeUndefined();

      // Finish c1 -> emits lp.task.settled -> c4 wakes and spawns
      const att1 = getAttempt(w.db, "att_c1")!;
      await emitAttemptEvent({ db: w.db, engine: w.engine, name: LP_EVENTS.THREAD_IDLE, key: att1.thread_id! });
      await w.engine.idle();

      await vi.waitFor(() => expect(w.spawns.some((s) => s.taskId === "c4")).toBe(true));
      expect(w.engine.get(r1.runId)?.status).toBe("succeeded");
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });

  it("two attempts on the same declared file are serialised via admission-wait", async () => {
    const w = createGraphWorld({ maxConcurrent: 3 });
    try {
      const rA = await w.dispatchTask("fA", ["src/shared.ts"]);
      const rB = await w.dispatchTask("fB", ["src/shared.ts"]);
      await vi.waitFor(() => {
        expect(w.engine.get(rA.runId)?.status).toBe("waiting");
        expect(w.engine.get(rB.runId)?.status).toBe("waiting");
      });

      expect(w.spawns.map((s) => s.taskId)).toEqual(["fA"]);
      expect(w.awaitStep(rB.runId, "admission-wait")?.state).toBe("waiting");

      const attA = getAttempt(w.db, "att_fA")!;
      await emitAttemptEvent({ db: w.db, engine: w.engine, name: LP_EVENTS.THREAD_IDLE, key: attA.thread_id! });
      await w.engine.idle();

      await vi.waitFor(() => expect(w.spawns.some((s) => s.taskId === "fB")).toBe(true));
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });

  it("Matvey two-condition stopped: process exit without hand-back posts owner item by name and never continues", async () => {
    const w = createGraphWorld();
    try {
      // 1) Direct cancelAttemptById path: confirmWriterStopped succeeds, rollback.noteStopped fails
      const task1 = makeTask("t-stop-direct", ["src/s1.ts"]);
      createTask(w.db, { id: "t-stop-direct", runId: w.runId, kind: "bb", contract: task1 });
      createAttempt(w.db, { id: "att-stop-1", runId: w.runId, taskId: "t-stop-direct" });
      transitionAttempt(w.db, "att-stop-1", "spawn_requested");
      transitionAttempt(w.db, "att-stop-1", "running", { threadId: "thr_stop_1" });

      const cancelRes = await cancelAttemptById(
        w.ctx,
        "att-stop-1",
        { noteStopped: async () => ({ recorded: false, error: "worktree unreadable" }) },
        "stopped by owner",
        "owner_cancel",
        undefined,
        async (name, key, payload) => emitAttemptEvent({ db: w.db, engine: w.engine, name: name as never, key, payload }),
      );
      expect(cancelRes.state).toBe("canceled");
      expect(cancelRes.ok).toBe(false);
      const items1 = listOpenOwnerItems(w.db, { projectId: w.projectId });
      expect(items1.some((i) => i.kind === "exit_without_handback" && i.what.includes("t-stop-direct"))).toBe(true);

      // 2) Graph path: cancel_requested -> stop-exit-wait (event arrives) -> stop-handback-wait (times out) -> stop-gap
      const started = await w.dispatchTask("t-stop-graph", ["src/s2.ts"]);
      await vi.waitFor(() => expect(w.engine.get(started.runId)?.status).toBe("waiting"));
      const att2 = getAttempt(w.db, "att_t-stop-graph")!;
      transitionAttempt(w.db, att2.id, "cancel_requested", { threadId: att2.thread_id!, reason: "owner stopped" });
      await emitAttemptEvent({ db: w.db, engine: w.engine, name: LP_EVENTS.THREAD_IDLE, key: att2.thread_id! });
      await w.engine.idle();

      expect(w.awaitStep(started.runId, "stop-exit-wait")?.state).toBe("waiting");
      await emitAttemptEvent({ db: w.db, engine: w.engine, name: LP_EVENTS.WRITER_PROCESS_EXITED, key: att2.id });
      await w.engine.idle();

      const handbackWait = w.awaitStep(started.runId, "stop-handback-wait")!;
      expect(handbackWait.state).toBe("waiting");
      const deadline = (JSON.parse(handbackWait.await_json!) as { deadline: number }).deadline;
      await w.advanceTo(w.engine, deadline + 1_000);

      expect(w.engine.get(started.runId)?.status).toBe("succeeded");
      expect(getAttempt(w.db, att2.id)?.state).toBe("canceled");
      const items2 = listOpenOwnerItems(w.db, { projectId: w.projectId });
      expect(items2.some((i) => i.kind === "exit_without_handback" && i.what.includes("t-stop-graph"))).toBe(true);
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });

  it("merge busy waits via durable merge-wait deadline then completes on retry, and permits route on lp.permit.requested", async () => {
    let calls = 0;
    const w = createGraphWorld({
      integrateStatus: () => {
        calls += 1;
        return calls === 1
          ? { status: "busy", commit: null, conflicts: [], reason: "checkout busy" }
          : { status: "merged", commit: "deadbeef", conflicts: [] };
      },
    });
    try {
      const started = await w.dispatchTask("t-merge-busy", ["src/m.ts"]);
      await vi.waitFor(() => expect(w.engine.get(started.runId)?.status).toBe("waiting"));
      const att = getAttempt(w.db, "att_t-merge-busy")!;
      await emitAttemptEvent({ db: w.db, engine: w.engine, name: LP_EVENTS.THREAD_IDLE, key: att.thread_id! });
      await w.engine.idle();

      const mergeWait = w.awaitStep(started.runId, "merge-wait")!;
      expect(mergeWait.state).toBe("waiting");
      const d = (JSON.parse(mergeWait.await_json!) as { deadline: number }).deadline;
      await w.advanceTo(w.engine, d + 1_000);

      expect(w.engine.get(started.runId)?.status).toBe("succeeded");
      expect(getAttempt(w.db, att.id)?.state).toBe("accepted");
      expect(w.integrateCalls()).toBe(2);

      // Permit event routing without sweep cron
      const listeners = new Map<string, (p: unknown) => unknown>();
      const permitSends: unknown[] = [];
      const permitBb = {
        ...w.bb,
        agents: { registerTool: () => undefined },
        events: { on: (name: string, fn: (p: unknown) => unknown) => { listeners.set(name, fn); } },
        sdk: { ...w.bb.sdk, threads: { send: async (args: unknown) => { permitSends.push(args); return {}; } } },
      };
      createAttempt(w.db, { id: "att-perm", runId: w.runId, taskId: "t-merge-busy" });
      transitionAttempt(w.db, "att-perm", "spawn_requested");
      transitionAttempt(w.db, "att-perm", "running", { threadId: "thr_perm" });
      w.db.prepare("UPDATE lane_pilot_run SET writer_host_id='host-p', pm_thread_id='thr_pm' WHERE id=?").run(w.runId);
      w.db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/perm/ws' WHERE id='att-perm'").run();

      mountPermits({ bb: permitBb, db: w.db, isDisposed: () => false } as never);
      listeners.get(LP_EVENTS.PERMIT_REQUESTED)?.({
        hostId: "host-p",
        session: "sess-1",
        ticket: "0123456789abcdef",
        category: "delete_for_good",
        command: "rm old.txt",
        cwd: "/perm/ws",
        at: Date.now(),
      });
      await vi.waitFor(() => expect(permitSends).toHaveLength(1));
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });
});
