import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { noOptionalPlugins } from "./optional-plugin-stubs";
import { expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../src/rooms/plugin-db";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../server";
import { setRunPaused } from "../src/rooms/runs/server/runs-halt";
import { setConveyor } from "../src/rooms/conveyor";
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

/** A writer whose first turns fail its checks and whose `acceptAtTurn`-th is accepted; `afterTurn(n)` runs when turn n has finished. */
function services(env: ReturnType<typeof setup>, afterTurn: (turn: number) => Promise<void> | void = () => undefined, acceptAtTurn = 2) {
  let turn = 0;
  const spawned: string[] = [];
  const finished: number[] = [];
  const all = {
    activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
    startAfterAcceptance: () => undefined,
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
      if (turn >= acceptAtTurn) { transitionAttempt(env.db, input.attemptId, "accepted"); return { status: "accepted", produced: ["a.txt"], verification: [] }; }
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

import { waitWhileRunPaused } from "../src/rooms/runs/server/runs-pause";
import { sweepWriterWakes } from "../src/rooms/writer/server/writer-wake";

it("a pause-state read that keeps failing is never 'resumed': the caller's bound decides", async () => {
  const kv = { get: async () => { throw new Error("kv down"); }, set: async () => undefined };
  const errors: string[] = [];
  // onReadBound says "the caller took over" → the wait stops with false, not a resume.
  const taken = await waitWhileRunPaused(kv, "run1", { isDisposed: () => false, pollMs: 1, maxReadErrors: 3, onError: (message) => errors.push(message), onReadBound: () => false });
  expect(taken).toBe(false);
  expect(errors.some((message) => message.includes("the caller took over"))).toBe(true);
  // No bound callback → keeps waiting past the error bound; only dispose or a clean read ends it.
  let disposed = false;
  const pending = waitWhileRunPaused(kv, "run1", { isDisposed: () => disposed, pollMs: 1, maxReadErrors: 3, onError: () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(disposed).toBe(false);
  disposed = true;
  expect(await pending).toBe(false);
});

it("a single pause-state read failure keeps waiting, and the next clean read resumes", async () => {
  let calls = 0;
  const kv = { get: async () => { calls += 1; if (calls === 1) throw new Error("blip"); return undefined; }, set: async () => undefined };
  const errors: string[] = [];
  const held = await waitWhileRunPaused(kv, "run1", { isDisposed: () => false, pollMs: 1, maxReadErrors: 5, onError: (message) => errors.push(message) });
  expect(held).toBe(true);
  expect(errors.some((message) => message.includes("staying held"))).toBe(true);
});

const PAUSE_READ_KEYS = new Set(["run-paused:run1", "run-halted:run1", "conveyor:off"]);

it("a plugin-store read failure before spawn parks the attempt for a retry instead of blocking it", async () => {
  const env = setup();
  const kv = env.bb.storage.kv as unknown as { get: (key: string) => Promise<unknown> };
  const realGet = kv.get.bind(kv);
  let failed = false;
  kv.get = async (key: string) => {
    if (!failed && !PAUSE_READ_KEYS.has(key)) { failed = true; throw new Error("store blink"); }
    return realGet(key);
  };
  const { all, spawned } = services(env);
  start(env, all);
  await vi.waitFor(() => expect(getAttempt(env.db, "T1-a1")?.reason ?? "").toContain("store_read:"));
  const parked = getAttempt(env.db, "T1-a1")!;
  expect(parked.state).toBe("queued");
  expect(spawned).toEqual([]);
  env.db.prepare("UPDATE lane_pilot_attempt SET wake_at=0 WHERE id='T1-a1'").run();
  await sweepWriterWakes(env.ctx, all as never);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"), { timeout: 15_000 });
  expect(spawned).toEqual(["T1-a1"]);
  await env.harness.lifecycle.dispose();
});

it("a plugin store that stays unreadable blocks the attempt after the park bound and posts one owner item", async () => {
  const env = setup();
  const kv = env.bb.storage.kv as unknown as { get: (key: string) => Promise<unknown> };
  const realGet = kv.get.bind(kv);
  kv.get = async (key: string) => {
    if (!PAUSE_READ_KEYS.has(key)) throw new Error("store down");
    return realGet(key);
  };
  const { all, spawned } = services(env);
  start(env, all);
  await vi.waitFor(() => expect(getAttempt(env.db, "T1-a1")?.reason ?? "").toContain("store_read:"));
  for (let i = 0; i < 8 && getAttempt(env.db, "T1-a1")?.state !== "blocked"; i += 1) {
    env.db.prepare("UPDATE lane_pilot_attempt SET wake_at=0 WHERE id='T1-a1' AND state='queued'").run();
    await sweepWriterWakes(env.ctx, all as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const attempt = getAttempt(env.db, "T1-a1")!;
  expect(attempt.state).toBe("blocked");
  expect(attempt.reason).toContain("store_read:");
  expect(spawned).toEqual([]);
  const items = () => env.db.prepare("SELECT key, state, closed_by FROM lane_pilot_owner_item WHERE key LIKE 'store-read:T1-a1:%' ORDER BY key").all() as Array<{ key: string; state: string; closed_by: string | null }>;
  expect(items()).toEqual([expect.objectContaining({ key: "store-read:T1-a1:1", state: "open" })]);
  // The attempt leaves blocked (requeue) → the item closes; a later block posts under a fresh sequence key.
  transitionAttempt(env.db, "T1-a1", "queued", { reason: "retry after store read" });
  expect(items()).toEqual([expect.objectContaining({ key: "store-read:T1-a1:1", state: "closed" })]);
  for (let i = 0; i < 8 && getAttempt(env.db, "T1-a1")?.state !== "blocked"; i += 1) {
    env.db.prepare("UPDATE lane_pilot_attempt SET wake_at=0 WHERE id='T1-a1' AND state='queued'").run();
    await sweepWriterWakes(env.ctx, all as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(getAttempt(env.db, "T1-a1")?.state).toBe("blocked");
  expect(items()).toEqual([
    expect.objectContaining({ key: "store-read:T1-a1:1", state: "closed" }),
    expect.objectContaining({ key: "store-read:T1-a1:2", state: "open" }),
  ]);
  await env.harness.lifecycle.dispose();
});

it("a clean read after store_read parks resets the streak: the next failure parks, not blocks", async () => {
  const env = setup();
  const kv = env.bb.storage.kv as unknown as { get: (key: string) => Promise<unknown> };
  const realGet = kv.get.bind(kv);
  let down = true;
  kv.get = async (key: string) => {
    if (down && !PAUSE_READ_KEYS.has(key)) throw new Error("store down");
    return realGet(key);
  };
  const { all, spawned } = services(env);
  // The clean-read-then-reload window: prepareRun succeeds but the spawn never lands, so the attempt stays
  // queued and the journal still ends in the store_read parks — only the clean-admission marker resets them.
  let hangSpawn = false;
  const realSpawn = all.spawnWriterAttempt;
  all.spawnWriterAttempt = ((input: Parameters<typeof realSpawn>[0]) => hangSpawn ? new Promise<never>(() => {}) : realSpawn(input)) as typeof all.spawnWriterAttempt;
  start(env, all);
  await vi.waitFor(() => expect(getAttempt(env.db, "T1-a1")?.reason ?? "").toContain("store_read:"));
  for (let i = 0; i < 3; i += 1) {
    env.db.prepare("UPDATE lane_pilot_attempt SET wake_at=0 WHERE id='T1-a1' AND state='queued'").run();
    await sweepWriterWakes(env.ctx, all as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(getAttempt(env.db, "T1-a1")?.state).toBe("queued"); // 4 parks, still under the bound
  down = false; hangSpawn = true;
  env.db.prepare("UPDATE lane_pilot_attempt SET wake_at=0 WHERE id='T1-a1' AND state='queued'").run();
  await sweepWriterWakes(env.ctx, all as never);
  await new Promise((resolve) => setTimeout(resolve, 100)); // the clean prepareRun finishes; the spawn hangs
  down = true; hangSpawn = false;
  // "Reload": the first pipeline is still hung in spawn, so free the dedup slot the way a restart would.
  all.activeWriterTasks.delete("run1:T1");
  all.startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "T1-a1", pmThreadId: "thr_pm", config, task: contract("T1"), plan: "Plan for T1" });
  const parkRows = () => (env.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt_transition WHERE attempt_id='T1-a1' AND to_state='queued' AND substr(reason,1,11)='store_read:'").get() as { n: number }).n;
  await vi.waitFor(() => expect(parkRows()).toBe(5), { timeout: 5_000 }); // the fifth park after the clean read
  const attempt = getAttempt(env.db, "T1-a1")!;
  expect(attempt.state).toBe("queued"); // one failure after the clean read parks — without the reset it would block here
  expect(spawned).toEqual([]);
  await env.harness.lifecycle.dispose();
});

it("a paused run whose pause flag is unreadable parks the attempt at admission instead of spawning", async () => {
  const env = setup();
  await setRunPaused(env.bb.storage.kv as never, "run1", true);
  const kv = env.bb.storage.kv as unknown as { get: (key: string) => Promise<unknown> };
  const realGet = kv.get.bind(kv);
  kv.get = async (key: string) => {
    if (PAUSE_READ_KEYS.has(key)) throw new Error("pause store down");
    return realGet(key);
  };
  const scale = process.env.LANE_PILOT_POLL_SCALE;
  process.env.LANE_PILOT_POLL_SCALE = "0.01";
  try {
    const { all, spawned } = services(env);
    start(env, all);
    await vi.waitFor(() => expect(getAttempt(env.db, "T1-a1")?.reason ?? "").toContain("store_read:"), { timeout: 10_000 });
    const attempt = getAttempt(env.db, "T1-a1")!;
    expect(attempt.state).toBe("queued"); // unreadable is not resumed: parked through the store_read path, no spawn
    expect(spawned).toEqual([]);
  } finally {
    if (scale === undefined) delete process.env.LANE_PILOT_POLL_SCALE; else process.env.LANE_PILOT_POLL_SCALE = scale;
  }
  await env.harness.lifecycle.dispose();
});

it("a running attempt whose pause flag turns unreadable waits at the boundary, posts one owner item, and never starts the next turn", async () => {
  const env = setup();
  const kv = env.bb.storage.kv as unknown as { get: (key: string) => Promise<unknown> };
  const realGet = kv.get.bind(kv);
  let pauseDown = false;
  kv.get = async (key: string) => {
    if (pauseDown && PAUSE_READ_KEYS.has(key)) throw new Error("pause store down");
    return realGet(key);
  };
  const scale = process.env.LANE_PILOT_POLL_SCALE;
  process.env.LANE_PILOT_POLL_SCALE = "0.01";
  try {
    const { all, finished } = services(env, async (turn) => { if (turn === 1) pauseDown = true; });
    start(env, all);
    await vi.waitFor(() => expect(finished).toEqual([1]));
    const itemRows = () => env.db.prepare("SELECT key, state FROM lane_pilot_owner_item WHERE key LIKE 'pause-read:%'").all() as Array<{ key: string; state: string }>;
    await vi.waitFor(() => expect(itemRows().filter((row) => row.state === "open")).toHaveLength(1), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(finished).toEqual([1]); // still waiting — unreadable is not resumed
    pauseDown = false;
    await vi.waitFor(() => expect(finished).toEqual([1, 2]), { timeout: 15_000 });
    expect(itemRows().filter((row) => row.state === "open")).toHaveLength(0); // the item closes once a clean read lets the wait end
  } finally {
    if (scale === undefined) delete process.env.LANE_PILOT_POLL_SCALE; else process.env.LANE_PILOT_POLL_SCALE = scale;
  }
  await env.harness.lifecycle.dispose();
});

it("a second pause-read blip posts a fresh owner item — a closed row does not swallow the next episode", async () => {
  const env = setup();
  const kv = env.bb.storage.kv as unknown as { get: (key: string) => Promise<unknown> };
  const realGet = kv.get.bind(kv);
  let pauseDown = false;
  kv.get = async (key: string) => {
    if (pauseDown && PAUSE_READ_KEYS.has(key)) throw new Error("pause store down");
    return realGet(key);
  };
  const scale = process.env.LANE_PILOT_POLL_SCALE;
  process.env.LANE_PILOT_POLL_SCALE = "0.01";
  try {
    // Three turns: the wait at each stage boundary can hit the unreadable flag twice.
    const { all, finished } = services(env, async (turn) => { if (turn === 1 || turn === 2) pauseDown = true; }, 3);
    start(env, all);
    await vi.waitFor(() => expect(finished).toEqual([1]));
    const itemRows = () => env.db.prepare("SELECT key, state FROM lane_pilot_owner_item WHERE key LIKE 'pause-read:%' ORDER BY key").all() as Array<{ key: string; state: string }>;
    await vi.waitFor(() => expect(itemRows().filter((row) => row.state === "open")).toHaveLength(1), { timeout: 10_000 });
    expect(itemRows()[0]!.key.endsWith(":0")).toBe(true);
    pauseDown = false; // first blip over: the wait ends, the row closes, turn 2 runs and turns the flag unreadable again
    await vi.waitFor(() => expect(finished).toEqual([1, 2]), { timeout: 15_000 });
    await vi.waitFor(() => expect(itemRows()).toHaveLength(2), { timeout: 10_000 });
    // A fresh open row exists after the first closed — with a reused key postOwnerItem would leave it closed.
    // (The two episodes run under different continuation attempt ids, so key order says nothing about time.)
    expect(itemRows().filter((row) => row.state === "open")).toHaveLength(1);
    expect(itemRows().filter((row) => row.state === "closed")).toHaveLength(1);
    expect(new Set(itemRows().map((row) => row.key)).size).toBe(2);
    pauseDown = false;
    await vi.waitFor(() => expect(finished).toEqual([1, 2, 3]), { timeout: 15_000 });
    expect(itemRows().filter((row) => row.state === "open")).toHaveLength(0);
  } finally {
    if (scale === undefined) delete process.env.LANE_PILOT_POLL_SCALE; else process.env.LANE_PILOT_POLL_SCALE = scale;
  }
  await env.harness.lifecycle.dispose();
});

it("a cancel lands while the pause flag is unreadable: the wait stops, the item closes, and no next turn starts", async () => {
  const env = setup();
  const kv = env.bb.storage.kv as unknown as { get: (key: string) => Promise<unknown> };
  const realGet = kv.get.bind(kv);
  let pauseDown = false;
  kv.get = async (key: string) => {
    if (pauseDown && PAUSE_READ_KEYS.has(key)) throw new Error("pause store down");
    return realGet(key);
  };
  const scale = process.env.LANE_PILOT_POLL_SCALE;
  process.env.LANE_PILOT_POLL_SCALE = "0.01";
  try {
    const { all, finished } = services(env, async (turn) => { if (turn === 1) pauseDown = true; });
    start(env, all);
    await vi.waitFor(() => expect(finished).toEqual([1]));
    const openItems = () => (env.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item WHERE key LIKE 'pause-read:%' AND state='open'").get() as { n: number }).n;
    await vi.waitFor(() => expect(openItems()).toBe(1), { timeout: 10_000 });
    // The cancel reaches the attempt the wait belongs to (the continuation attempt, not firstAttemptId) while
    // the flag still cannot be read.
    const waitingAttempt = (env.db.prepare("SELECT key FROM lane_pilot_owner_item WHERE key LIKE 'pause-read:%' AND state='open'").get() as { key: string }).key.split(":").slice(1, -1).join(":");
    env.db.prepare("UPDATE lane_pilot_attempt SET state='cancel_requested' WHERE id=?").run(waitingAttempt);
    await vi.waitFor(() => expect(openItems()).toBe(0), { timeout: 10_000 }); // the wait returned and closed its item
    pauseDown = false; // even with clean reads the canceled attempt gets no next turn
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toEqual([1]);
  } finally {
    if (scale === undefined) delete process.env.LANE_PILOT_POLL_SCALE; else process.env.LANE_PILOT_POLL_SCALE = scale;
  }
  await env.harness.lifecycle.dispose();
});

it("a pause-read blip that survives a redispatch posts under a new sequence — the closed row does not swallow it", async () => {
  const env = setup();
  const kv = env.bb.storage.kv as unknown as { get: (key: string) => Promise<unknown> };
  const realGet = kv.get.bind(kv);
  // The admission wait reads the pause keys twice; from the third read on (the stage-boundary wait) they fail.
  let pauseGets = 0, armAt: number | null = null, pauseDown = false;
  kv.get = async (key: string) => {
    if (PAUSE_READ_KEYS.has(key)) {
      pauseGets += 1;
      if (armAt !== null && pauseGets === armAt) pauseDown = true;
      if (pauseDown) throw new Error("pause store down");
    }
    return realGet(key);
  };
  const scale = process.env.LANE_POLL_SCALE ?? process.env.LANE_PILOT_POLL_SCALE;
  process.env.LANE_PILOT_POLL_SCALE = "0.01";
  try {
    const { all } = services(env);
    const task = contract("T1");
    createTask(env.db, { id: "T1", runId: "run1", kind: "bb", contract: task });
    saveTaskPlan(env.db, "T1", "Plan for T1");
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(env.db, { runId: "run1", taskId: "T1", stageId, state: "pending", input: "Plan for T1" });
    createAttempt(env.db, { id: "T1-a1", runId: "run1", taskId: "T1" });
    Object.assign(all, createWriterStart(env.ctx, all));
    let hangSpawn = true;
    const realSpawn = all.spawnWriterAttempt;
    all.spawnWriterAttempt = ((input: Parameters<typeof realSpawn>[0]) => hangSpawn ? new Promise<never>(() => {}) : realSpawn(input)) as typeof all.spawnWriterAttempt;
    const itemRows = () => env.db.prepare("SELECT key, state FROM lane_pilot_owner_item WHERE key LIKE 'pause-read:T1-a1%' ORDER BY key").all() as Array<{ key: string; state: string }>;
    const dispatch = () => {
      pauseGets = 0; armAt = 3; pauseDown = false;
      all.startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "T1-a1", pmThreadId: "thr_pm", config, task, plan: "Plan for T1" });
    };
    dispatch(); // first dispatch: admission reads pass, the stage-boundary wait hits the unreadable flag
    await vi.waitFor(() => expect(itemRows().filter((row) => row.state === "open")).toHaveLength(1), { timeout: 10_000 });
    expect(itemRows()[0]!.key).toBe("pause-read:T1-a1:0");
    pauseDown = false; // the flag reads clean again: the wait ends, its row closes, the spawn hangs like a reload mid-dispatch
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(itemRows()).toEqual([expect.objectContaining({ key: "pause-read:T1-a1:0", state: "closed" })]);
    all.activeWriterTasks.delete("run1:T1"); // "reload": the hung pipeline frees the dedup slot, the attempt is dispatched again
    dispatch();
    await vi.waitFor(() => expect(itemRows()).toHaveLength(2), { timeout: 10_000 });
    // The second episode is a fresh row: with a reused key postOwnerItem would have left the closed row closed.
    expect(itemRows()).toEqual([
      expect.objectContaining({ key: "pause-read:T1-a1:0", state: "closed" }),
      expect.objectContaining({ key: "pause-read:T1-a1:1", state: "open" }),
    ]);
  } finally {
    if (scale === undefined) delete process.env.LANE_PILOT_POLL_SCALE; else process.env.LANE_PILOT_POLL_SCALE = scale;
  }
  await env.harness.lifecycle.dispose();
});
