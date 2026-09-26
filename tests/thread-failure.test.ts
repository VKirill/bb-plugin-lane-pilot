import { expect, it } from "vitest";
import { decideThreadCompletion, PROVIDER_START_LIMIT_MS, threadFailure } from "../src/thread-completion";

const ev = (seq: number, type: string, data: Record<string, unknown> = {}, createdAt = 1_000) => ({ seq, type, createdAt, threadId:"t", data });

it("fails at once on BB's terminal errors for the current request", () => {
  const request = ev(1, "client/turn/requested");
  expect(threadFailure([request, ev(2, "provider/error", { message:"quota exceeded" })], 2_000)).toBe("provider_error:quota exceeded");
  expect(threadFailure([request, ev(2, "system/thread/interrupted", { reason:"host-daemon-restarted", cause:"host-connection-lost" })], 2_000))
    .toBe("thread_interrupted:host-daemon-restarted:host-connection-lost");
  expect(threadFailure([request, ev(2, "client/turn/rejected", { reason:"busy", message:"thread busy" })], 2_000)).toBe("turn_rejected:busy:thread busy");
  expect(threadFailure([request, ev(2, "system/thread-provisioning", { status:"failed" })], 2_000)).toBe("provisioning_failed");
  expect(threadFailure([request, ev(2, "system/error", { code:"x", message:"boom" })], 2_000)).toBe("system_error:x:boom");
});

it("waits through retries, earlier requests and a working provider", () => {
  const events = [ev(1, "provider/error", { message:"old" }), ev(2, "client/turn/requested"),
    ev(3, "provider/error", { message:"retrying", willRetry:true }), ev(4, "system/error", { message:"reconnecting", reconnectAttempt:1, reconnectTotal:3 }),
    ev(5, "thread/identity")];
  expect(threadFailure(events, 1_000 + PROVIDER_START_LIMIT_MS * 10)).toBeNull();
});

it("reports a provider that never opened a session, and only then", () => {
  const events = [ev(1, "client/turn/requested", {}, 0)];
  expect(threadFailure(events, PROVIDER_START_LIMIT_MS - 1)).toBeNull();
  expect(threadFailure(events, PROVIDER_START_LIMIT_MS + 1_000)).toMatch(/^provider_not_started/);
});

it("lets a completed turn win and turns a failure into an error decision", () => {
  const request = ev(1, "client/turn/requested", {}, 0);
  expect(decideThreadCompletion({ threadId:"t", status:"idle", events:[request, ev(2, "turn/started"), ev(3, "turn/completed", { status:"completed" })] }).ok).toBe(true);
  expect(decideThreadCompletion({ threadId:"t", status:"starting", events:[request], now:PROVIDER_START_LIMIT_MS + 1 }))
    .toMatchObject({ ok:false, via:"error" });
});

it("after a follow-up, waits for the turn it requested rather than the finished one", () => {
  const done = [ev(1, "client/turn/requested", {}, 1_000), ev(2, "turn/started", {}, 1_100), ev(3, "turn/completed", { status:"completed" }, 5_000)];
  expect(decideThreadCompletion({ threadId:"t", status:"idle", events:done }).ok).toBe(true);
  expect(decideThreadCompletion({ threadId:"t", status:"idle", events:done, requestedAfter:6_000 })).toMatchObject({ ok:false, detail:"follow_up_not_requested_yet" });
  const asked = [...done, ev(4, "client/turn/requested", {}, 6_500)];
  expect(decideThreadCompletion({ threadId:"t", status:"active", events:asked, requestedAfter:6_000 })).toMatchObject({ ok:false, detail:"follow_up_not_started" });
  const finished = [...asked, ev(5, "turn/started", {}, 6_600), ev(6, "turn/completed", { status:"completed" }, 9_000)];
  expect(decideThreadCompletion({ threadId:"t", status:"idle", events:finished, requestedAfter:6_000 }).ok).toBe(true);
});
