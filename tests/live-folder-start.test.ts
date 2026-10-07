import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { noOptionalPlugins } from "./optional-plugin-stubs";
import { afterEach, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/contracts";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, saveProjectSetting, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../src/database";
import { createCore } from "../src/server/core";
import type { Services } from "../src/server/services";
import { recordStage, reopenWriterStages } from "../src/server/stage-records";
import { createWriterStart } from "../src/server/writer/start";
import { LIVE_FOLDER_REASON } from "../src/live-folder";
import { RunWriterPool } from "../src/stages/run-policy";

const WORKSPACE = "/ws";

// Disjoint owns_paths: in a git folder two such tasks run side by side, in a folder without git they queue.
const contract = (id: string): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [], depends_on: [],
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
});

const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE,
  pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };

type Step = { accept?: true; providerError?: true; needsHuman?: true; diff?: string };
type Send = { threadId: string; input: Array<{ text: string }> };

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const events: string[] = [];
  const sends: Send[] = [];
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  harness.sdk.stub("threads.send", async (args: unknown) => { events.push("send"); sends.push(args as Send); return undefined; });
  harness.sdk.stub("threads.context", async () => ({ usage: null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  return { bb, harness, db, ctx, events, sends };
}

/** Services of a writer that follows `script`; `live` says whether the run's folder has no git. */
function services(env: ReturnType<typeof setup>, script: Step[], live: boolean) {
  let turn = 0;
  const acquired: Array<{ key: string; limit: number }> = [];
  const restored: Array<{ backupId: string; folder: string; owns: string[] }> = [];
  const spawned: string[] = [];
  const dirtSeen: string[] = [];
  const all = {
    activeWriterTasks: new Set<string>(),
    providerBreaker: { record: () => undefined },
    ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async (key: string, limit: number) => { acquired.push({ key, limit }); return () => undefined; } },
    stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
    maintainMemoryAfterAcceptance: () => undefined,
    maintainProjectLifeAfterAcceptance: () => undefined,
    isLiveFolder: async () => live,
    workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }),
    restoreLiveFolder: async (input: { backupId: string; folder: string; task: { owns_paths: string[] } }) => {
      env.events.push(`restore:${input.backupId}`);
      restored.push({ backupId: input.backupId, folder: input.folder, owns: input.task.owns_paths });
      return { ok: true, restored: ["x"], removed: [], failed: [] };
    },
    spawnWriterAttempt: async (input: { attemptId: string }) => {
      env.events.push(`spawn:${input.attemptId}`);
      spawned.push(input.attemptId);
      setAttemptWorkspace(env.db, input.attemptId, { path: WORKSPACE, environmentId: null,
        decision: live ? { strategy: "inherit_run", reason: LIVE_FOLDER_REASON } : { strategy: "inherit_run", reason: "below_threshold" } });
      transitionAttempt(env.db, input.attemptId, "spawn_requested");
      transitionAttempt(env.db, input.attemptId, "running", { threadId: "thr_w" });
      // Every spawn snapshots the folder again, and the folder differs from the first snapshot (a stray file stayed).
      return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [{ path: "stray.txt", sha256: `snapshot-${spawned.length}` }], workspacePath: WORKSPACE };
    },
    finishWriterAttempt: async (input: { attemptId: string; writerThreadId: string; dirtBefore: Array<{ sha256: string }> }) => {
      dirtSeen.push(input.dirtBefore[0]?.sha256 ?? "");
      const step = script[turn++] ?? { diff: `d${turn}` };
      if (step.accept) { transitionAttempt(env.db, input.attemptId, "accepted"); return { status: "accepted", produced: ["a.txt"], verification: [] }; }
      if (step.needsHuman) {
        transitionAttempt(env.db, input.attemptId, "blocked", { reason: "needs_human: which colour?" });
        return { status: "blocked", reason: "needs_human: which colour?", attemptId: input.attemptId, writerThreadId: input.writerThreadId };
      }
      if (step.providerError) {
        transitionAttempt(env.db, input.attemptId, "provider_error", { reason: "writer thread status error" });
        return { status: "provider_error", reason: "writer thread status error", attemptId: input.attemptId, writerThreadId: input.writerThreadId };
      }
      const reason = "verification failed (npm test): boom";
      transitionAttempt(env.db, input.attemptId, "validation_failed", { reason });
      return { status: "validation_failed", reason, produced: ["a.txt"], attemptId: input.attemptId, writerThreadId: input.writerThreadId,
        verification: [{ command: "npm test", exitCode: 1, stdout: "", stderr: "AssertionError: boom" }], diffKey: step.diff ?? `d${turn}` };
    },
  } as unknown as Services;
  return { all, acquired, restored, spawned, dirtSeen };
}

function start(env: ReturnType<typeof setup>, svc: Services, taskId = "T1") {
  const task = contract(taskId);
  createTask(env.db, { id: taskId, runId: "run1", kind: "bb", contract: task });
  saveTaskPlan(env.db, taskId, `Plan for ${taskId}`);
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
    recordStage(env.db, { runId: "run1", taskId, stageId, state: "pending", input: `Plan for ${taskId}` });
  }
  createAttempt(env.db, { id: `${taskId}-a1`, runId: "run1", taskId });
  Object.assign(svc, createWriterStart(env.ctx, svc));
  svc.startWriterTask({ projectId: "proj1", runId: "run1", taskId, firstAttemptId: `${taskId}-a1`, pmThreadId: "thr_pm", config, task, plan: `Plan for ${taskId}` });
}

const writerStage = (db: ReturnType<typeof openDatabase>, taskId = "T1") => listStageReceipts(db, "run1", taskId).find((row) => row.stageId === "writer-agent")!;

afterEach(() => { vi.useRealTimers(); });

function busyFolder(env: ReturnType<typeof setup>) {
  createTask(env.db, { id: "B1", runId: "run1", kind: "bb", contract: contract("B1") });
  createAttempt(env.db, { id: "b1-a", runId: "run1", taskId: "B1" });
  transitionAttempt(env.db, "b1-a", "spawn_requested");
  transitionAttempt(env.db, "b1-a", "running", { threadId: "thr_b" });
}

it("queues a task behind the one running in the same folder without git, even when their owns_paths are disjoint", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const env = setup();
  busyFolder(env);
  const { all, spawned, acquired } = services(env, [{ accept: true }], true);
  start(env, all);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(spawned).toEqual([]);
  expect(writerStage(env.db)).toMatchObject({ state: "pending", reason: expect.stringContaining("waiting for B1") });
  expect(writerStage(env.db).reason).toContain("one writer at a time in a folder without git");
  transitionAttempt(env.db, "b1-a", "accepted");
  await vi.advanceTimersByTimeAsync(10_000);
  vi.useRealTimers();
  await vi.waitFor(() => expect(spawned).toEqual(["T1-a1"]));
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  // The writer slot is the folder's, with room for one.
  expect(acquired).toEqual([{ key: "live-folder:h1:/ws", limit: 1 }]);
  await env.harness.lifecycle.dispose();
});

it("lets disjoint tasks of a git folder run side by side, as before", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const env = setup();
  busyFolder(env);
  const { all, spawned, acquired } = services(env, [{ accept: true }], false);
  start(env, all);
  await vi.advanceTimersByTimeAsync(50);
  vi.useRealTimers();
  await vi.waitFor(() => expect(spawned).toEqual(["T1-a1"]));
  expect(acquired[0]?.key).toBe("run1");
  await env.harness.lifecycle.dispose();
});

it("keeps the live files across feedback turns and rolls the owned files back once, when the session ends without an accept", async () => {
  const env = setup();
  const { all, restored } = services(env, Array.from({ length: 8 }, (_, index) => ({ diff: `d${index}` })), true);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("failed"));
  // Feedback turns (sends) go to the same thread on the live files; the rollback comes after the last of them, once.
  expect(env.events.filter((event) => event === "send").length).toBeGreaterThan(1);
  expect(env.events.at(-1)).toBe("restore:T1-a1");
  expect(env.events.filter((event) => event.startsWith("restore"))).toEqual(["restore:T1-a1"]);
  expect(restored).toEqual([{ backupId: "T1-a1", folder: WORKSPACE, owns: ["T1/**"] }]);
  await env.harness.lifecycle.dispose();
});

it("rolls back before another writer starts, and backs up again for it", async () => {
  const env = setup();
  const { all, restored, spawned } = services(env, [{ providerError: true }, { accept: true }], true);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(spawned).toHaveLength(2);
  expect(env.events).toEqual([`spawn:T1-a1`, "restore:T1-a1", `spawn:${spawned[1]}`]);
  expect(restored).toHaveLength(1);
  await env.harness.lifecycle.dispose();
});

it("rolls nothing back after an accepted attempt, and records the mode in the receipt", async () => {
  const env = setup();
  const { all, restored } = services(env, [{ diff: "d1" }, { accept: true }], true);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(restored).toEqual([]);
  expect(env.events).not.toContain("restore:T1-a1");
  expect(writerStage(env.db).result).toMatchObject({ status: "accepted", workspace: { path: WORKSPACE, mode: "live-folder", decision: { reason: LIVE_FOLDER_REASON } } });
  await env.harness.lifecycle.dispose();
});

it("never asks for a rollback in a git folder", async () => {
  const env = setup();
  const { all, restored } = services(env, Array.from({ length: 8 }, (_, index) => ({ diff: `d${index}` })), false);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("failed"));
  expect(restored).toEqual([]);
  await env.harness.lifecycle.dispose();
});

it("treats a writer's question as a pause: no rollback, and the answered attempt rolls back under the backup it began with", async () => {
  const env = setup();
  const { all, restored } = services(env, [{ needsHuman: true }, ...Array.from({ length: 8 }, (_, index) => ({ diff: `d${index}` }))], true);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("failed"));
  expect(restored).toEqual([]);
  expect(await env.bb.storage.kv.get("live-backup:T1-a1")).toBe("T1-a1");
  // The PM answers: the same attempt reopens in the same thread and goes on, here to a session that ends unaccepted.
  await vi.waitFor(() => expect(all.activeWriterTasks.size).toBe(0));
  transitionAttempt(env.db, "T1-a1", "running", { threadId: "thr_w" });
  reopenWriterStages(env.db, "run1", "T1", "reopened: the PM answered the writer's question");
  all.startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "T1-a1", pmThreadId: "thr_pm", config,
    task: contract("T1"), plan: "Plan for T1", writerThreadId: "thr_w" });
  await vi.waitFor(() => expect(restored.map((row) => row.backupId)).toEqual(["T1-a1"]));
  await env.harness.lifecycle.dispose();
});

it("measures every attempt of a task against the folder as the first one found it, so a stray file an earlier attempt left still counts", async () => {
  const live = setup();
  const liveRun = services(live, [{ providerError: true }, { accept: true }], true);
  start(live, liveRun.all);
  await vi.waitFor(() => expect(writerStage(live.db).state).toBe("passed"));
  expect(liveRun.dirtSeen).toEqual(["snapshot-1", "snapshot-1"]);
  await live.harness.lifecycle.dispose();
  const git = setup();
  const gitRun = services(git, [{ providerError: true }, { accept: true }], false);
  start(git, gitRun.all);
  await vi.waitFor(() => expect(writerStage(git.db).state).toBe("passed"));
  expect(gitRun.dirtSeen).toEqual(["snapshot-1", "snapshot-2"]);
  await git.harness.lifecycle.dispose();
});

it("keeps the folder without git locked while a writer's question is unanswered: other tasks queue, the PM is told", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const env = setup();
  // T1's writer asked a question and its attempt ended blocked, as it does when the writer answers with NEEDS_HUMAN.
  const t1 = services(env, [{ needsHuman: true }], true);
  start(env, t1.all);
  await vi.advanceTimersByTimeAsync(50);
  vi.useRealTimers();
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("failed"));
  await vi.waitFor(() => expect(t1.all.activeWriterTasks.size).toBe(0));
  expect(env.sends.map((send) => send.input[0]!.text).join("\n")).toContain("the folder stays locked: other tasks for it queue until this question is answered");

  // T2's files are disjoint from T1's, yet it may not start in the folder T1's writer left half-edited.
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const t2 = services(env, [{ accept: true }], true);
  start(env, t2.all, "T2");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t2.spawned).toEqual([]);
  expect(writerStage(env.db, "T2")).toMatchObject({ state: "pending", reason: expect.stringContaining("waiting for T1") });
  expect(writerStage(env.db, "T2").reason).toContain("its writer's question is unanswered and the folder has no git");

  // The PM answers: T1's attempt goes on (here it is accepted), the lock is gone and T2 starts.
  transitionAttempt(env.db, "T1-a1", "running", { threadId: "thr_w" });
  transitionAttempt(env.db, "T1-a1", "accepted");
  await vi.advanceTimersByTimeAsync(10_000);
  vi.useRealTimers();
  await vi.waitFor(() => expect(t2.spawned).toEqual(["T2-a1"]));
  await env.harness.lifecycle.dispose();
});

it("a git folder is not held by a writer's question", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const env = setup();
  const t1 = services(env, [{ needsHuman: true }], false);
  start(env, t1.all);
  await vi.advanceTimersByTimeAsync(50);
  vi.useRealTimers();
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("failed"));
  await vi.waitFor(() => expect(t1.all.activeWriterTasks.size).toBe(0));
  expect(env.sends.map((send) => send.input[0]!.text).join("\n")).not.toContain("folder stays locked");
  const t2 = services(env, [{ accept: true }], false);
  start(env, t2.all, "T2");
  await vi.waitFor(() => expect(t2.spawned).toEqual(["T2-a1"]));
  await env.harness.lifecycle.dispose();
});

it("holds a task in the queue while its provider is at its cap (ops.provider_pool), and starts it once a slot frees", async () => {
  const env = setup();
  saveProjectSetting(env.db, "proj1", "ops.provider_pool", "p=1, other=3");
  const { all, spawned } = services(env, [{ accept: true }], false);
  const pool = new RunWriterPool();
  (all as unknown as { runWriterPool: RunWriterPool }).runWriterPool = pool;
  const busy = await pool.acquire("provider-pool:p", 1);
  start(env, all);
  await new Promise((wake) => setTimeout(wake, 150));
  expect(spawned).toEqual([]);
  expect(writerStage(env.db).state).not.toBe("failed");
  busy();
  await vi.waitFor(() => expect(spawned).toEqual(["T1-a1"]));
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  await env.harness.lifecycle.dispose();
});

it("takes no provider slot when ops.provider_pool lists another provider or is unset", async () => {
  const env = setup();
  saveProjectSetting(env.db, "proj1", "ops.provider_pool", "other=1");
  const { all, acquired, spawned } = services(env, [{ accept: true }], false);
  start(env, all);
  await vi.waitFor(() => expect(spawned).toEqual(["T1-a1"]));
  expect(acquired.map((row) => row.key)).toEqual(["run1"]);
  await env.harness.lifecycle.dispose();
});
