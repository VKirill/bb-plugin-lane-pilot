import { afterEach, expect, it, vi } from "vitest";
import { decideThreadCompletion, onThreadFailure, threadFailure, waitThreadIdle } from "@lane-pilot/thread-observe";
import samples from "./fixtures/rules-ask-provider-retries-2026-11-10.json";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const sample = samples[0]!;
const threadId = sample.threadId;
const event = (seq: number, type: string, data = {}) => ({ threadId, seq, type, data, createdAt: sample.events[0]!.createdAt });
const bbFor = (events: unknown[]) => ({ sdk: { threads: {
  get: async () => ({ status: "active" }), events: { list: async () => [...events] },
} } }) as never;

it("lets a provider retry and finish before the deadline instead of failing early", async () => {
  vi.useFakeTimers();
  const events: unknown[] = [...sample.events];
  let finished = false;
  const waiting = waitThreadIdle(bbFor(events), threadId, "analyzer", 20 * 60_000).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(finished).toBe(false);
  events.push(event(20, "turn/completed", { status: "completed" }));
  await vi.advanceTimersByTimeAsync(1_000);
  await waiting;
  expect(finished).toBe(true);
});

it("does not turn an old request's retry into the new request's deadline cause", async () => {
  vi.useFakeTimers();
  const events = [...sample.events, event(30, "client/turn/requested"), event(31, "turn/started")];
  const waiting = waitThreadIdle(bbFor(events), threadId, "analyzer", 10).catch((cause: Error) => cause.message);
  await vi.advanceTimersByTimeAsync(10);
  expect(await waiting).toBe("analyzer:incomplete:status=active;queuedWork=unknown;started_seq=31;turn=none");
});

it("does not reuse a retry notice while the follow-up has not been requested yet", async () => {
  vi.useFakeTimers();
  const waiting = waitThreadIdle(bbFor(sample.events), threadId, "analyzer", 10, sample.events[0]!.createdAt + 1).catch((cause: Error) => cause.message);
  await vi.advanceTimersByTimeAsync(10);
  expect(await waiting).toBe("analyzer:incomplete:follow_up_not_requested_yet");
});

it.each(["aborted", "plugin_stopped"])("keeps %s ahead of a provider retry at the deadline", async (reason) => {
  vi.useFakeTimers();
  const bb = bbFor(sample.events);
  const listener = vi.fn();
  onThreadFailure(bb, listener);
  let stopped: string | null = null;
  const waiting = waitThreadIdle(bb, threadId, "analyzer", 10, undefined, () => stopped).catch((cause: Error) => cause.message);
  await vi.advanceTimersByTimeAsync(9);
  stopped = reason;
  await vi.advanceTimersByTimeAsync(1);
  expect(await waiting).toBe(`analyzer:${reason}`);
  expect(listener).not.toHaveBeenCalled();
});

it("retains a provider retry that arrived during the last sleep", async () => {
  vi.useFakeTimers();
  const events: unknown[] = sample.events.filter((row) => row.type !== "provider/error");
  const waiting = waitThreadIdle(bbFor(events), threadId, "analyzer", 10).catch((cause: Error) => cause.message);
  await vi.advanceTimersByTimeAsync(9);
  events.push(event(20, "provider/error", { message: "HTTP 403 (reset after 2m)", willRetry: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(await waiting).toBe("analyzer:error:provider_error:HTTP 403 (reset after 2m)");
});

it("does not hang on the final event refresh when the core stops answering", async () => {
  vi.useFakeTimers();
  vi.stubEnv("LANE_PILOT_POLL_SCALE", "1");
  let reads = 0;
  const bb = { sdk: { threads: {
    get: async () => ({ status: "active" }),
    events: { list: async () => ++reads === 1 ? [...sample.events] : new Promise<never>(() => {}) },
  } } } as never;
  const waiting = waitThreadIdle(bb, threadId, "analyzer", 10).catch((cause: Error) => cause.message);
  await vi.advanceTimersByTimeAsync(1010);
  expect(await waiting).toContain("analyzer:error:provider_error:");
  expect(reads).toBe(2);
});

it("keeps a plain cancellation after retry notices a cancellation", () => {
  expect(decideThreadCompletion({ threadId, status: "active", events: [...sample.events,
    event(20, "system/thread/interrupted", { reason: "manual-stop" }), event(21, "turn/completed", { status: "interrupted" })] }))
    .toEqual({ ok: false, via: "canceled", detail: "turn_interrupted" });
});

it("uses the latest retry cause at the deadline and excludes sub-agent notices", () => {
  const events = [event(1, "client/turn/requested"), event(2, "turn/started"),
    event(3, "provider/error", { message: "temporary network failure", willRetry: true }),
    event(4, "provider/error", { message: "HTTP 403 (reset after 2m)", willRetry: true }),
    event(5, "provider/error", { message: "sub-agent failure", willRetry: true, parentToolCallId: "tool-1" })];
  expect(threadFailure(events)).toBeNull();
  expect(threadFailure(events, Date.now(), { includeRetrying: true })).toBe("provider_error:HTTP 403 (reset after 2m)");
});

it("keeps a terminal provider error when a follow-up was accepted into the running turn", () => {
  const events = [event(1, "turn/started"), event(2, "client/turn/requested"), event(3, "turn/input/accepted"),
    event(4, "provider/error", { message: "HTTP 403 (reset after 2m)" }), event(5, "turn/completed", { status: "failed" })];
  expect(decideThreadCompletion({ threadId, status: "active", events, requestedAfter: sample.events[0]!.createdAt }))
    .toEqual({ ok: false, via: "error", detail: "provider_error:HTTP 403 (reset after 2m)" });
});
