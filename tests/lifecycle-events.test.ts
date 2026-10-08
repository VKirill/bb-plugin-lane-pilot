import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { threadSignalHub, waitThreadIdle } from "@lane-pilot/thread-observe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";
import { createAttempt, createRun, createTask, getRun, openDatabase, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { loadBlockedBy } from "../src/rooms/runs/server/blocked-by";
import { mountLifecycleEvents } from "../src/rooms/core/server/lifecycle-events";
import { followUpCancelled, saveFollowUp } from "../src/rooms/writer/server/sticky";

beforeEach(() => { process.env.LANE_PILOT_THREAD_SIGNALS = "1"; });
afterEach(() => { process.env.LANE_PILOT_THREAD_SIGNALS = "0"; });

type Handler = (payload: unknown) => unknown;

/** The lifecycle module on a fake host, with an events object the test drives itself (the fake host knows only the events of its SDK). */
function setup(options: { threads?: Record<string, unknown>; unknownEvents?: string[] } = {}) {
  const sent: Array<{ threadId: string; text: string }> = [];
  const threads = options.threads ?? {};
  const { bb: host, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
    get: async ({ threadId }: { threadId: string }) => { if (!(threadId in threads)) throw new Error("HTTP 404: thread not found"); return threads[threadId]; },
    send: async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return { delivery: "sent", ok: true }; },
  } } } as never);
  const db = openDatabase(host);
  const handlers = new Map<string, Handler>();
  const bb = Object.assign(Object.create(host), { pluginId: "lane-pilot", events: { on: (name: string, handler: Handler) => {
    if (options.unknownEvents?.includes(name)) throw new Error(`unknown event "${name}"`);
    handlers.set(name, handler);
  } } });
  const forgotten: string[] = [];
  const ctx = { bb, db, isDisposed: () => false, nativeInstaller: { forget: async (hostId: string) => { forgotten.push(hostId); } } };
  mountLifecycleEvents(ctx as never);
  const emit = async (name: string, payload: unknown) => { await handlers.get(name)?.(payload); };
  return { bb, db, host, harness, sent, handlers, emit, forgotten };
}

function runningAttempt(db: ReturnType<typeof openDatabase>, runId: string, pmThreadId: string, writerThreadId: string) {
  createRun(db, runId, "P", "cli");
  setRunThread(db, runId, pmThreadId);
  createTask(db, { id: `task_${runId}`, runId, kind: "bb", contract: {} });
  createAttempt(db, { id: `attempt_${runId}`, runId, taskId: `task_${runId}` });
  transitionAttempt(db, `attempt_${runId}`, "spawn_requested");
  transitionAttempt(db, `attempt_${runId}`, "running", { threadId: writerThreadId });
  return `attempt_${runId}`;
}

describe("PM chat archived or deleted", () => {
  it("closes the run at once, leaves a run with an open attempt and other chats alone", async () => {
    const t = setup({ threads: { thr_pm1: { id: "thr_pm1", status: "idle", archivedAt: 5 }, thr_pm2: { id: "thr_pm2", status: "idle", archivedAt: 5 } } });
    createRun(t.db, "run_a", "P", "cli");
    setRunThread(t.db, "run_a", "thr_pm1");
    runningAttempt(t.db, "run_busy", "thr_pm2", "thr_w2");
    createRun(t.db, "run_other", "P", "cli");
    setRunThread(t.db, "run_other", "thr_alive");
    await t.emit("thread.archived", { thread: makeThreadResponse({ id: "thr_pm1" }) });
    expect(getRun(t.db, "run_a")?.state).toBe("closed");
    await t.emit("thread.archived", { thread: makeThreadResponse({ id: "thr_pm2" }) });
    expect(getRun(t.db, "run_busy")?.closed_at).toBeNull();
    await t.emit("thread.deleted", { thread: makeThreadResponse({ id: "thr_unrelated" }) });
    expect(getRun(t.db, "run_other")?.closed_at).toBeNull();
  });

  it("a deleted PM chat closes its run too", async () => {
    const t = setup();
    createRun(t.db, "run_d", "P", "cli");
    setRunThread(t.db, "run_d", "thr_gone");
    await t.emit("thread.deleted", { thread: makeThreadResponse({ id: "thr_gone" }) });
    expect(getRun(t.db, "run_d")?.state).toBe("closed");
  });
});

describe("a writer stopped on an interaction", () => {
  const interaction = (id: string) => ({ id, threadId: "thr_w", status: "pending", payload: { kind: "approval", reason: "run rm -rf build" } });

  it("tells the PM once and records why on the attempt's blockedBy", async () => {
    const t = setup();
    const attemptId = runningAttempt(t.db, "run_i", "thr_pm", "thr_w");
    await t.emit("interaction.pending", { thread: makeThreadResponse({ id: "thr_w" }), interaction: interaction("int_1") });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ threadId: "thr_pm" });
    expect(t.sent[0]!.text).toContain("task_run_i");
    expect(t.sent[0]!.text).toContain("run rm -rf build");
    const blockedBy = await loadBlockedBy(t.bb.storage.kv, attemptId);
    expect(blockedBy).toMatchObject({ kind: "human", holderThreadId: "thr_w", holderAttemptId: attemptId });
    expect(blockedBy?.detail).toContain("int_1");
    // The same interaction again (a re-announcement) is not sent twice; a new one is.
    await t.emit("interaction.pending", { thread: makeThreadResponse({ id: "thr_w" }), interaction: interaction("int_1") });
    expect(t.sent).toHaveLength(1);
    await t.emit("interaction.pending", { thread: makeThreadResponse({ id: "thr_w" }), interaction: interaction("int_2") });
    expect(t.sent).toHaveLength(2);
    expect(getRun(t.db, "run_i")?.closed_at).toBeNull();
  });

  it("ignores a thread that is no writer of an open attempt", async () => {
    const t = setup();
    runningAttempt(t.db, "run_j", "thr_pm", "thr_w");
    await t.emit("interaction.pending", { thread: makeThreadResponse({ id: "thr_helper" }), interaction: interaction("int_9") });
    expect(t.sent).toHaveLength(0);
  });
});

describe("a queued row deleted by the owner", () => {
  it("ends the wait of the attempt whose follow-up it was, and lets the waiting loop stop", async () => {
    const t = setup();
    const attemptId = runningAttempt(t.db, "run_q", "thr_pm", "thr_w");
    const since = Date.now();
    await saveFollowUp(t.bb.storage.kv, attemptId, since);
    const entry = makeQueueEntry({ threadId: "thr_w", originPluginId: "lane-pilot", createdAt: since } as never);
    await t.emit("message.cancelled", { entry });
    expect(followUpCancelled(t.bb, attemptId)).toBe(true);
    // The wait that was looking for the follow-up's turn stops with the reason, instead of running for ever.
    const bb = { sdk: { threads: { get: async () => ({ id: "thr_w", status: "idle" }), events: { list: async () => [] } } } } as never;
    await expect(waitThreadIdle(bb, "thr_w", "writer_follow_up", undefined, since, () => followUpCancelled(t.bb, attemptId) ? "deleted" : null))
      .rejects.toThrow("writer_follow_up:deleted");
  });

  it("leaves rows of other plugins, other threads and old turns alone", async () => {
    const t = setup();
    const attemptId = runningAttempt(t.db, "run_r", "thr_pm", "thr_w");
    const since = Date.now();
    await saveFollowUp(t.bb.storage.kv, attemptId, since);
    await t.emit("message.cancelled", { entry: makeQueueEntry({ threadId: "thr_w", originPluginId: "other-plugin", createdAt: since } as never) });
    await t.emit("message.cancelled", { entry: makeQueueEntry({ threadId: "thr_elsewhere", originPluginId: "lane-pilot", createdAt: since } as never) });
    await t.emit("message.cancelled", { entry: makeQueueEntry({ threadId: "thr_w", originPluginId: "lane-pilot", createdAt: since - 60_000 } as never) });
    expect(followUpCancelled(t.bb, attemptId)).toBe(false);
  });
});

describe("a machine removed", () => {
  it("forgets its install record and its host jobs, and no other machine's", async () => {
    const t = setup();
    await t.bb.storage.kv.set("host-job:gateRun:host_a:abc", { jobId: "j1" });
    await t.bb.storage.kv.set("host-job:gateRun:host_b:abc", { jobId: "j2" });
    await t.emit("experimental_host.deleted", { host: { id: "host_a" } });
    expect(t.forgotten).toEqual(["host_a"]);
    expect(await t.bb.storage.kv.list("host-job:")).toEqual(["host-job:gateRun:host_b:abc"]);
  });

  it("an older BB that does not know the event only costs that listener", () => {
    const t = setup({ unknownEvents: ["experimental_host.deleted"] });
    expect(t.handlers.has("experimental_host.deleted")).toBe(false);
    expect(t.handlers.has("thread.archived")).toBe(true);
  });
});

describe("kill switch", () => {
  it("LANE_PILOT_THREAD_SIGNALS=0 registers no lifecycle handler", () => {
    process.env.LANE_PILOT_THREAD_SIGNALS = "0";
    expect(setup().handlers.size).toBe(0);
  });
});

describe("through the plugin factory", () => {
  it("registers the thread signal hub and the lifecycle handlers on BB's real events", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { list: async () => [], get: async () => ({ id: "thr_x", status: "idle", archivedAt: 5 }) } }, hostCall: async () => ({}) } as never);
    await plugin(bb);
    const hub = threadSignalHub(bb)!;
    expect(hub).not.toBeNull();
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_x" }), lastAssistantText: null });
    expect(hub.stats.signals).toBe(1);
    const counts = harness.registrations.threadEventHandlers;
    expect(counts["thread.archived"]).toBeGreaterThanOrEqual(2);
    expect(counts["interaction.pending"]).toBe(1);
    expect(counts["message.cancelled"]).toBe(1);
    await harness.lifecycle.dispose();
    vi.restoreAllMocks();
  });
});
