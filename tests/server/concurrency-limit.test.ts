import { describe, expect, it } from "vitest";
import { startLimitWaiting, turnHeldByPlugin, waitThreadIdle } from "@lane-pilot/thread-observe";
import { createConcurrencyLimit, hostWriterCap } from "../../src/server/concurrency-limit";

const configuration = (hosts: Array<{ id: string; effectiveLimit: number }>, globalLimit: number | null = null) => ({ globalLimit, hosts });

describe("hostWriterCap", () => {
  it("is the host's effective limit, or the overall one when lower, and never below one writer", () => {
    expect(hostWriterCap(configuration([{ id: "h1", effectiveLimit: 4 }]), "h1")).toBe(4);
    expect(hostWriterCap(configuration([{ id: "h1", effectiveLimit: 4 }], 2), "h1")).toBe(2);
    expect(hostWriterCap(configuration([{ id: "h1", effectiveLimit: 0 }]), "h1")).toBe(1);
    expect(hostWriterCap(configuration([{ id: "h2", effectiveLimit: 8 }], 3), "h1")).toBe(3);
    expect(hostWriterCap(configuration([{ id: "h2", effectiveLimit: 8 }]), "h1")).toBeNull();
    expect(hostWriterCap(null, "h1")).toBeNull();
  });
});

describe("createConcurrencyLimit", () => {
  const sdkWith = (plugins: unknown) => ({ sdk: { plugins } }) as never;

  it("reads the plugin's configuration once a minute", async () => {
    let calls = 0;
    let at = 5_000_000;
    const limit = createConcurrencyLimit(sdkWith({ callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: unknown }) => {
      calls += 1;
      expect([pluginId, method, input]).toEqual(["concurrency-limit", "getConfiguration", null]);
      return { ...configuration([{ id: "h1", effectiveLimit: 3, name: "x", status: "connected" } as never]), hostOverrides: [] };
    } }), () => at);
    expect(await limit.hostCap("h1")).toBe(3);
    expect(await limit.hostCap("h1")).toBe(3);
    expect(calls).toBe(1);
    at += 61_000;
    await limit.hostCap("h1");
    expect(calls).toBe(2);
  });

  it("gives no cap when the plugin is absent, disabled or fails, and asks a missing one only every five minutes", async () => {
    expect(await createConcurrencyLimit({ sdk: {} } as never).hostCap("h1")).toBeNull();
    let calls = 0;
    let at = 1_000;
    const limit = createConcurrencyLimit(sdkWith({ callRpc: async () => { calls += 1; throw new Error("plugin concurrency-limit is disabled"); } }), () => at);
    expect(await limit.hostCap("h1")).toBeNull();
    expect(await limit.hostCap("h1")).toBeNull();
    expect(calls).toBe(1);
    at += 6 * 60_000;
    await limit.hostCap("h1");
    expect(calls).toBe(2);
  });
});

/** A turn requested long ago that no session ever answered: the provider's start limit has passed. */
const stuckRequest = { seq: 1, type: "client/turn/requested", createdAt: 0, threadId: "t1", data: {} };
const bbWith = (queue: () => Promise<unknown>) => ({ sdk: { threads: {
  get: async () => ({ id: "t1", status: "pending", queuedWork: "queued" }),
  events: { list: async () => [stuckRequest] },
  queue: { list: queue },
} } }) as never;
const held = { id: "q1", threadId: "t1", waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: "2 of 2 running on host h1" } };

describe("a turn waiting in a plugin's queue is not a provider that never started", () => {
  it("sees a turn held by a plugin and nothing else", async () => {
    expect(await turnHeldByPlugin(bbWith(async () => [held]), "t1")).toBe(true);
    expect(await turnHeldByPlugin(bbWith(async () => [{ id: "q2", threadId: "t1", waitingOn: { kind: "thread-busy" } }]), "t1")).toBe(false);
    expect(await turnHeldByPlugin(bbWith(async () => []), "t1")).toBe(false);
    expect(await turnHeldByPlugin(bbWith(async () => { throw new Error("queue unavailable"); }), "t1")).toBe(false);
  });

  it("drops only the start-limit failure while the turn waits", async () => {
    const bb = bbWith(async () => [held]);
    expect(await startLimitWaiting(bb, "t1", "provider_not_started:no session 200s after the request")).toBe(true);
    expect(await startLimitWaiting(bb, "t1", "provider_error:quota exceeded")).toBe(false);
    expect(await startLimitWaiting(bb, "t1", null)).toBe(false);
    expect(await startLimitWaiting(bbWith(async () => []), "t1", "provider_not_started:no session 200s after the request")).toBe(false);
  });

  it("keeps waiting while held, and still fails a writer that never started when nothing holds it", async () => {
    await expect(waitThreadIdle(bbWith(async () => []), "t1", "writer", 1_500)).rejects.toThrow(/writer:error:provider_not_started/);
    await expect(waitThreadIdle(bbWith(async () => [held]), "t1", "writer", 1_500)).rejects.toThrow(/writer:incomplete:/);
  });
});
