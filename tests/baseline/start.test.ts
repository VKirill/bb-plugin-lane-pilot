import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createWriterStart } from "../../src/rooms/writer/server/start";

// D1-3: the baseline runs before the first writer of a task; in stop mode the writer is never asked.
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

function services(env: ReturnType<typeof setup>, preflight: ((input: unknown) => Promise<unknown>) | null, extra: Record<string, unknown> = {}) {
  const spawned: string[] = [];
  const all = {
    activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
    maintainMemoryAfterAcceptance: () => undefined, maintainProjectLifeAfterAcceptance: () => undefined,
    workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
    ...(preflight ? { baseline: { preflight } } : {}), ...extra,
    spawnWriterAttempt: async (input: { attemptId: string }) => {
      spawned.push(input.attemptId);
      setAttemptWorkspace(env.db, input.attemptId, { path: WORKTREE, environmentId: null, decision: {} });
      transitionAttempt(env.db, input.attemptId, "spawn_requested");
      transitionAttempt(env.db, input.attemptId, "running", { threadId: "thr_w" });
      return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [], workspacePath: WORKTREE };
    },
    finishWriterAttempt: async (input: { attemptId: string }) => {
      transitionAttempt(env.db, input.attemptId, "accepted");
      return { status: "accepted", produced: ["a.txt"], verification: [] };
    },
  } as unknown as Services;
  return { all, spawned };
}

function start(env: ReturnType<typeof setup>, svc: Services, taskId = "T1") {
  const task = contract(taskId);
  createTask(env.db, { id: taskId, runId: "run1", kind: "bb", contract: task });
  saveTaskPlan(env.db, taskId, `Plan for ${taskId}`);
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(env.db, { runId: "run1", taskId, stageId, state: "pending", input: `Plan for ${taskId}` });
  createAttempt(env.db, { id: `${taskId}-a1`, runId: "run1", taskId });
  Object.assign(svc, createWriterStart(env.ctx, svc));
  svc.startWriterTask({ projectId: "proj1", runId: "run1", taskId, firstAttemptId: `${taskId}-a1`, pmThreadId: "thr_pm", config, task, plan: `Plan for ${taskId}` });
}

const writerStage = (db: ReturnType<typeof openDatabase>, taskId = "T1") => listStageReceipts(db, "run1", taskId).find((row) => row.stageId === "writer-agent")!;

it("in stop mode the attempt ends blocked with the baseline's reason and no writer is spawned", async () => {
  const env = setup();
  const preflight = vi.fn(async (_input: unknown) => ({ stop: "verdict_block: baseline already_built: all 1 check(s) already pass on base abc" as string | null, record: null }));
  const { all, spawned } = services(env, preflight);
  start(env, all);
  await vi.waitFor(() => expect(getAttempt(env.db, "T1-a1")?.state).toBe("blocked"));
  expect(getAttempt(env.db, "T1-a1")?.reason).toContain("baseline already_built");
  expect(writerStage(env.db).state).toBe("failed");
  expect(spawned).toEqual([]);
  expect(preflight).toHaveBeenCalledTimes(1);
  expect(preflight.mock.calls[0]![0]).toMatchObject({ projectId: "proj1", runId: "run1", taskId: "T1", attemptId: "T1-a1", pmThreadId: "thr_pm" });
  await env.harness.lifecycle.dispose();
});

it("in notify mode the baseline says nothing to the start: the writer is spawned as before", async () => {
  const env = setup();
  const preflight = vi.fn(async () => ({ stop: null, record: null }));
  const { all, spawned } = services(env, preflight);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(spawned).toEqual(["T1-a1"]);
  expect(preflight).toHaveBeenCalledTimes(1);
  await env.harness.lifecycle.dispose();
});

it("a mainfix (its own preflight) and a folder without git take no baseline", async () => {
  const env = setup();
  const preflight = vi.fn(async () => ({ stop: "verdict_block: x", record: null }));
  const { all, spawned } = services(env, preflight, { runVerification: async () => [{ command: "npm test", exitCode: 1, stdout: "", stderr: "red" }] });
  start(env, all, "T1-mainfix");
  await vi.waitFor(() => expect(spawned).toEqual(["T1-mainfix-a1"]));
  expect(preflight).not.toHaveBeenCalled();
  await env.harness.lifecycle.dispose();

  const live = setup();
  const second = vi.fn(async () => ({ stop: "verdict_block: x", record: null }));
  const folder = services(live, second, { isLiveFolder: async () => true, restoreLiveFolder: async () => ({ ok: true, restored: [], removed: [], failed: [] }) });
  start(live, folder.all);
  await vi.waitFor(() => expect(folder.spawned).toEqual(["T1-a1"]));
  expect(second).not.toHaveBeenCalled();
  await live.harness.lifecycle.dispose();
});

it("a services bag without a baseline (an older wiring) starts the writer", async () => {
  const env = setup();
  const { all, spawned } = services(env, null);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(spawned).toEqual(["T1-a1"]);
  await env.harness.lifecycle.dispose();
});
