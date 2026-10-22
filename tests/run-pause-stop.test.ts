import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { cancelAttemptById } from "../src/rooms/runs/server/cancel";
import { isRunHalted, isRunPaused, setRunHalted, setRunPaused } from "../src/rooms/runs/server/runs-halt";
import { pauseRun, waitWhileRunPaused } from "../src/rooms/runs/server/runs-pause";
import { confirmWriterStopped } from "../src/rooms/runs/server/writer-stop";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, transitionAttempt } from "../src/rooms/storage/database";

const task: TaskV2 = {
  schema_version: 2, id: "t1", title: "Write", risk: "low", lane: "writer", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [], depends_on: [], objective: "write", acceptance: ["file exists"], verify: "none", verification: [],
};

function memoryKv() {
  const store = new Map<string, unknown>();
  return { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); }, store };
}

describe("pause a run at a safe boundary (P2-8)", () => {
  it("is a flag apart from the halt flag, set and cleared on its own", async () => {
    const kv = memoryKv();
    expect(await isRunPaused(kv, "r1")).toBe(false);
    await setRunPaused(kv, "r1", true);
    expect(await isRunPaused(kv, "r1")).toBe(true);
    expect(await isRunHalted(kv, "r1")).toBe(false);
    await setRunHalted(kv, "r2", true);
    expect(await isRunPaused(kv, "r2")).toBe(false);
    await setRunPaused(kv, "r1", false);
    expect(await isRunPaused(kv, "r1")).toBe(false);
  });

  it("holds the caller while paused and lets it go on resume; a reload ends the wait without a go-ahead", async () => {
    const kv = memoryKv();
    await setRunPaused(kv, "r1", true);
    let began = 0;
    const held = waitWhileRunPaused(kv, "r1", { isDisposed: () => false, pollMs: 5, onFirstWait: () => { began += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    let done = false;
    void held.then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    await setRunPaused(kv, "r1", false);
    expect(await held).toBe(true);
    expect(began).toBe(1);
    // not paused: no wait, no call
    expect(await waitWhileRunPaused(kv, "r1", { isDisposed: () => false, onFirstWait: () => { began += 1; } })).toBe(true);
    expect(began).toBe(1);
    await setRunPaused(kv, "r1", true);
    let disposed = false;
    const reloaded = waitWhileRunPaused(kv, "r1", { isDisposed: () => disposed, pollMs: 5 });
    disposed = true;
    expect(await reloaded).toBe(false);
  });

  it("pause / resume report what runs and what waits, cancel nothing, and survive being asked twice", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr_w" });
    createTask(db, { id: "t2", runId: "run", kind: "bb", contract: { ...task, id: "t2" } });
    createAttempt(db, { id: "a2", runId: "run", taskId: "t2" });
    const ctx = { bb, db } as never;
    const paused = await pauseRun(ctx, "run", "pause");
    expect(paused).toMatchObject({ paused: true, changed: true, running: [{ attemptId: "a1", taskId: "t1", state: "running" }], waiting: [{ attemptId: "a2", taskId: "t2" }] });
    expect(paused.since).toMatch(/^\d{4}-/);
    expect(getAttempt(db, "a1")?.state).toBe("running");
    expect(await pauseRun(ctx, "run", "pause")).toMatchObject({ paused: true, changed: false });
    expect(await pauseRun(ctx, "run", "status")).toMatchObject({ paused: true });
    expect(await pauseRun(ctx, "run", "resume")).toMatchObject({ paused: false, since: null, changed: true });
    await expect(pauseRun(ctx, "nope", "pause")).rejects.toThrow(/does not exist/);
  });
});

describe("stop = confirmed exit AND work returned (rule 9)", () => {
  const botWith = (statuses: string[]) => {
    let reads = 0;
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      stop: async () => ({}) as never,
      get: async () => ({ status: statuses[Math.min(reads++, statuses.length - 1)] }) as never,
      listRunning: async () => [],
    } } });
    return { bb, reads: () => reads };
  };

  it("waits, bounded, for a writer that is still winding down", async () => {
    const w = botWith(["running", "running", "idle"]);
    const confirmed = await confirmWriterStopped(w.bb, "thr_w", { waitMs: 2_000, pollMs: 5 });
    expect(confirmed).toMatchObject({ stopped: true, status: "idle" });
    expect(w.reads()).toBe(3);
  });

  it("gives up at the bound and says the writer is still running", async () => {
    const w = botWith(["running"]);
    const confirmed = await confirmWriterStopped(w.bb, "thr_w", { waitMs: 40, pollMs: 10 });
    expect(confirmed).toMatchObject({ stopped: false, status: "running" });
  });

  it("a cancel records the worktree before it marks the attempt canceled", async () => {
    const order: string[] = [];
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      stop: async () => ({}) as never,
      get: async () => ({ status: "idle" }) as never,
      listRunning: async () => [],
    } } });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr_w" });
    const rollback = { noteStopped: async (attemptId: string) => { order.push(`recorded:${getAttempt(db, attemptId)?.state}`); } };
    const result = await cancelAttemptById({ bb, db, cancelQueuedAttempt: () => ({ ok: false, state: "x", reason: null }) } as never, "a1", rollback);
    expect(result).toMatchObject({ ok: true, state: "canceled" });
    // the work was recorded while the attempt was still cancel_requested: before anything could be cleaned up
    expect(order).toEqual(["recorded:cancel_requested"]);
    expect(getAttempt(db, "a1")?.state).toBe("canceled");
  });
});
