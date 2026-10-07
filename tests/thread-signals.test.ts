import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadSignalHub, installThreadSignals, observeStageChild, threadSignalHub, waitThreadIdle } from "@lane-pilot/thread-observe";

type Handler = (payload: unknown) => void;

/** A BB handle with the three things the watchers use: events.on, threads.get and threads.events.list. */
function fakeBb(options: { withEvents: boolean }) {
  const handlers = new Map<string, Handler[]>();
  const disposers: Array<() => void> = [];
  const state = { status: "active", done: false, gets: 0, lists: 0 };
  const turnEvents = () => state.done
    ? [{ type: "turn/started", threadId: "w1", seq: 1 }, { type: "turn/completed", threadId: "w1", seq: 2, data: { status: "completed" } }]
    : [{ type: "turn/started", threadId: "w1", seq: 1 }];
  const bb = {
    sdk: { threads: {
      get: async () => { state.gets++; return { id: "w1", status: state.status }; },
      events: { list: async () => { state.lists++; return turnEvents(); } },
    } },
    onDispose: (fn: () => void) => { disposers.push(fn); },
    ...(options.withEvents ? { events: { on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } } : {}),
  };
  const emit = (name: string, payload: unknown) => { for (const handler of handlers.get(name) ?? []) handler(payload); };
  const finish = () => { state.status = "idle"; state.done = true; emit("thread.idle", { thread: { id: "w1", status: "idle" }, lastAssistantText: "ok" }); };
  return { bb: bb as never, state, emit, finish, handlers, dispose: () => disposers.forEach((fn) => fn()) };
}

beforeEach(() => { vi.useFakeTimers(); process.env.LANE_PILOT_THREAD_SIGNALS = "1"; });
afterEach(() => { vi.useRealTimers(); process.env.LANE_PILOT_THREAD_SIGNALS = "0"; });

describe("thread signal hub", () => {
  it("a signal between the mark and the wait is not lost", async () => {
    const hub = createThreadSignalHub(20_000);
    const mark = hub.mark();
    hub.notify("t1", "thread.idle");
    await expect(hub.wait("t1", mark)).resolves.toBe("signal");
  });

  it("wakes only the thread that was signalled, and falls back to a timeout", async () => {
    const hub = createThreadSignalHub(5_000);
    const mark = hub.mark();
    const other = hub.wait("t2", mark);
    const mine = hub.wait("t1", mark);
    hub.notify("t1", "thread.idle");
    await expect(mine).resolves.toBe("signal");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(other).resolves.toBe("timeout");
    expect(hub.stats).toMatchObject({ signals: 1, wakes: 1, timeouts: 1 });
  });

  it("an abort and a dispose wake the sleepers", async () => {
    const hub = createThreadSignalHub(20_000);
    const controller = new AbortController();
    const aborted = hub.wait("t1", hub.mark(), 20_000, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toBe("aborted");
    const sleeping = hub.wait("t1", hub.mark());
    hub.dispose();
    await expect(sleeping).resolves.toBe("signal");
    // After a dispose a sleep is short, so a loop that is still running notices the reload.
    const late = hub.wait("t1", hub.mark(), 20_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(late).resolves.toBe("timeout");
  });
});

describe("installThreadSignals", () => {
  it("listens to the idle, failed, archived, deleted and thread-events events", () => {
    const { bb, handlers } = fakeBb({ withEvents: true });
    expect(installThreadSignals(bb)).not.toBeNull();
    expect([...handlers.keys()].sort()).toEqual(["experimental_thread.events", "thread.archived", "thread.deleted", "thread.failed", "thread.idle"]);
    expect(installThreadSignals(bb)).toBe(threadSignalHub(bb));
  });

  it("is off without bb.events and with LANE_PILOT_THREAD_SIGNALS=0", () => {
    const { bb } = fakeBb({ withEvents: false });
    expect(installThreadSignals(bb)).toBeNull();
    process.env.LANE_PILOT_THREAD_SIGNALS = "0";
    expect(installThreadSignals(fakeBb({ withEvents: true }).bb)).toBeNull();
  });

  it("the thread-events event wakes a watcher only while the thread is not active", () => {
    const { bb, emit } = fakeBb({ withEvents: true });
    const hub = installThreadSignals(bb)!;
    emit("experimental_thread.events", { thread: { id: "w1", status: "active" }, sequence: 5 });
    expect(hub.stats.signals).toBe(0);
    emit("experimental_thread.events", { thread: { id: "w1", status: "idle" }, sequence: 6 });
    expect(hub.stats.signals).toBe(1);
  });

  it("a reload wakes the sleeping watchers", async () => {
    const { bb, dispose } = fakeBb({ withEvents: true });
    const hub = installThreadSignals(bb)!;
    const sleeping = hub.wait("w1", hub.mark());
    dispose();
    await expect(sleeping).resolves.toBe("signal");
  });
});

describe("waiting for a thread: reads per minute", () => {
  /** A writer that works for 45 s, watched for 70 s of fake time. Returns the reads made and when the wait ended. */
  async function watch(withEvents: boolean) {
    const fake = fakeBb({ withEvents });
    if (withEvents) installThreadSignals(fake.bb);
    const started = Date.now();
    let endedAt = 0;
    const waiting = waitThreadIdle(fake.bb, "w1", "writer").then(() => { endedAt = Date.now() - started; });
    await vi.advanceTimersByTimeAsync(45_000);
    fake.finish();
    const finishedAt = Date.now() - started;
    await vi.advanceTimersByTimeAsync(25_000);
    await waiting;
    return { gets: fake.state.gets, lists: fake.state.lists, lag: endedAt - finishedAt };
  }

  it("falls from one read a second to about one every 20 s, and the end is seen at once", async () => {
    const polled = await watch(false);
    const woken = await watch(true);
    // The old path reads every second: 45 reads until the writer ends, and it sees the end within a second.
    expect(polled.gets).toBeGreaterThanOrEqual(44);
    expect(polled.lag).toBeLessThanOrEqual(1_000);
    // With events: the first read, the fallback reads at 20 s and 40 s, and one read when BB says idle.
    expect(woken.gets).toBeLessThanOrEqual(4);
    expect(woken.lists).toBeLessThanOrEqual(4);
    expect(woken.lag).toBeLessThanOrEqual(2_000);
    expect(polled.gets / woken.gets).toBeGreaterThanOrEqual(10);
  });

  it("a failed thread is seen when BB reports it, with decideThreadCompletion as the judge", async () => {
    const fake = fakeBb({ withEvents: true });
    installThreadSignals(fake.bb);
    const waiting = waitThreadIdle(fake.bb, "w1", "writer").then(() => "done", (cause: Error) => cause.message);
    await vi.advanceTimersByTimeAsync(10_000);
    fake.state.status = "error";
    fake.emit("thread.failed", { thread: { id: "w1", status: "error" }, error: "provider died" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toBe("writer:error:thread_status_error");
    expect(fake.state.gets).toBeLessThanOrEqual(3);
  });

  it("observeStageChild reads as often", async () => {
    const fake = fakeBb({ withEvents: true });
    installThreadSignals(fake.bb);
    const observing = observeStageChild(fake.bb, "w1", 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    fake.finish();
    await vi.advanceTimersByTimeAsync(0);
    await expect(observing).resolves.toEqual({ kind: "completed" });
    expect(fake.state.gets).toBeLessThanOrEqual(3);
  });

  it("a lost event costs one fallback interval, not the wait", async () => {
    const fake = fakeBb({ withEvents: true });
    installThreadSignals(fake.bb);
    const waiting = waitThreadIdle(fake.bb, "w1", "writer");
    await vi.advanceTimersByTimeAsync(5_000);
    fake.state.status = "idle";
    fake.state.done = true; // no event
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(waiting).resolves.toBeUndefined();
  });
});
