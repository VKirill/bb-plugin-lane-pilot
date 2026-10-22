import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { noOptionalPlugins } from "./optional-plugin-stubs";
import { expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { setRunPaused } from "../src/rooms/runs/server/runs-halt";
import { setConveyor } from "../src/rooms/runs/server/conveyor";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { createWriterStart } from "../src/rooms/writer/server/start";

// P2-8: a paused run lets nothing new start, and a running attempt finishes its stage and then waits for the resume.
const WORKSPACE = "/ws";
const WORKTREE = "/ws/wt";
const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const contract = (id: string): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: ["a.txt"], owns_paths: [`${id}/**`, "a.txt"], never_touch: [], depends_on: [],
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
});

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  harness.sdk.stub("threads.send", async () => undefined);
  harness.sdk.stub("threads.context", async () => ({ usage: null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  return { bb, harness, db, ctx };
}

/** A writer whose first turn fails its checks and whose second is accepted; `afterTurn(n)` runs when turn n has finished. */
function services(env: ReturnType<typeof setup>, afterTurn: (turn: number) => Promise<void> | void = () => undefined) {
  let turn = 0;
  const spawned: string[] = [];
  const finished: number[] = [];
  const all = {
    activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
    maintainMemoryAfterAcceptance: () => undefined, maintainProjectLifeAfterAcceptance: () => undefined,
    workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
    spawnWriterAttempt: async (input: { attemptId: string }) => {
      spawned.push(input.attemptId);
      setAttemptWorkspace(env.db, input.attemptId, { path: WORKTREE, environmentId: null, decision: {} });
      transitionAttempt(env.db, input.attemptId, "spawn_requested");
      transitionAttempt(env.db, input.attemptId, "running", { threadId: "thr_w" });
      return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [], workspacePath: WORKTREE };
    },
    finishWriterAttempt: async (input: { attemptId: string; writerThreadId: string }) => {
      turn += 1;
      finished.push(turn);
      await afterTurn(turn);
      if (turn >= 2) { transitionAttempt(env.db, input.attemptId, "accepted"); return { status: "accepted", produced: ["a.txt"], verification: [] }; }
      const reason = "verification failed (npm test): boom";
      transitionAttempt(env.db, input.attemptId, "validation_failed", { reason });
      return { status: "validation_failed", reason, produced: ["a.txt"], attemptId: input.attemptId, writerThreadId: input.writerThreadId,
        verification: [{ command: "npm test", exitCode: 1, stdout: "", stderr: "boom" }], diffKey: `d${turn}` };
    },
  } as unknown as Services;
  return { all, spawned, finished };
}

function start(env: ReturnType<typeof setup>, svc: Services, extra: Partial<TaskV2> = {}) {
  const task = { ...contract("T1"), ...extra };
  createTask(env.db, { id: "T1", runId: "run1", kind: "bb", contract: task });
  saveTaskPlan(env.db, "T1", "Plan for T1");
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(env.db, { runId: "run1", taskId: "T1", stageId, state: "pending", input: "Plan for T1" });
  createAttempt(env.db, { id: "T1-a1", runId: "run1", taskId: "T1" });
  Object.assign(svc, createWriterStart(env.ctx, svc));
  svc.startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "T1-a1", pmThreadId: "thr_pm", config, task, plan: "Plan for T1" });
}

const writerStage = (db: ReturnType<typeof openDatabase>) => listStageReceipts(db, "run1", "T1").find((row) => row.stageId === "writer-agent")!;

it("a task sent to a paused run waits before its writer starts, says so, and starts by itself on resume", async () => {
  const env = setup();
  await setRunPaused(env.bb.storage.kv as never, "run1", true);
  const { all, spawned } = services(env);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).reason ?? "").toContain("paused"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(spawned).toEqual([]);
  expect(getAttempt(env.db, "T1-a1")?.state).toBe("queued");
  await setRunPaused(env.bb.storage.kv as never, "run1", false);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(spawned).toEqual(["T1-a1"]);
  await env.harness.lifecycle.dispose();
});

it("a running attempt finishes its current stage, then waits at the boundary before its next turn", async () => {
  const env = setup();
  const kv = env.bb.storage.kv as never;
  // The pause arrives while turn 1 is being checked: that stage completes, the next turn does not begin.
  const { all, finished } = services(env, async (turn) => { if (turn === 1) await setRunPaused(kv, "run1", true); });
  start(env, all);
  await vi.waitFor(() => expect(finished).toEqual([1]));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(finished).toEqual([1]);
  expect(getAttempt(env.db, "T1-a1")?.state).toBe("validation_failed");
  expect(writerStage(env.db).state).not.toBe("failed");
  await setRunPaused(kv, "run1", false);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(finished).toEqual([1, 2]);
  await env.harness.lifecycle.dispose();
});

it("a run that is not paused is not slowed", async () => {
  const env = setup();
  const { all, finished } = services(env);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(finished).toEqual([1, 2]);
  await env.harness.lifecycle.dispose();
});

it("the conveyor switch off holds a new task exactly like a pause, and on lets it start", async () => {
  const env = setup();
  await setConveyor(env.bb.storage.kv as never, false, "maintenance");
  const { all, spawned } = services(env);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).reason ?? "").toContain("paused"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(spawned).toEqual([]);
  await setConveyor(env.bb.storage.kv as never, true);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  await env.harness.lifecycle.dispose();
});

it("a sibling of an area with three tasks of one kind waits for the pilot, the first of them, and starts once it is accepted", async () => {
  const env = setup();
  const sibling = (id: string) => ({ ...contract(id), area: "page:/cards", kind: "feature" as const });
  createTask(env.db, { id: "T0", runId: "run1", kind: "bb", contract: sibling("T0") });
  createAttempt(env.db, { id: "T0-a1", runId: "run1", taskId: "T0" });
  transitionAttempt(env.db, "T0-a1", "spawn_requested");
  transitionAttempt(env.db, "T0-a1", "running", { threadId: "thr_pilot" });
  createTask(env.db, { id: "T2", runId: "run1", kind: "bb", contract: sibling("T2") });
  const { all, spawned } = services(env);
  start(env, all, { area: "page:/cards", kind: "feature" });
  await vi.waitFor(() => expect(writerStage(env.db).reason ?? "").toContain("T0 is the pilot of its area"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(spawned).toEqual([]);
  transitionAttempt(env.db, "T0-a1", "accepted");
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"), { timeout: 15_000 });
  expect(spawned).toEqual(["T1-a1"]);
  await env.harness.lifecycle.dispose();
});
