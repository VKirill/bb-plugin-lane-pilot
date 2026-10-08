import { describe, expect, it } from "vitest";
import { failureClass } from "../../src/failure-class";
import { USAGE_FETCH_METHOD, USAGE_LIST_METHOD, createProviderUsage, usageHold, usageHoldReason, usageSkipPercent, type UsageMeasurement, type UsageResource } from "../../src/rooms/usage/server/provider-usage";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const later = "2026-10-07T15:00:00.000Z";
const host = (id: string, providerId = "claude-code", hostId = "h1"): UsageResource => ({ id, providerId, scope: { kind: "host", hostId } }) as UsageResource;
const shared = (id: string, providerId = "claude-code"): UsageResource => ({ id, providerId, scope: { kind: "shared" } }) as UsageResource;
const ok = (...windows: Array<{ usedPercent: number; resetsAt?: string | null; model?: string | null; label?: string }>): UsageMeasurement =>
  ({ usage: { status: "ok", windows } }) as UsageMeasurement;
const ask = { providerId: "claude-code", model: "claude-opus-4-8", hostId: "h1", threshold: 90, now: NOW };

describe("usageHold", () => {
  it("holds a pair whose window is at the threshold and has not reset, with the reset time", () => {
    expect(usageHold([{ resource: host("a"), measurement: ok({ usedPercent: 91, resetsAt: later, label: "5-hour" }) }], ask))
      .toEqual({ percent: 91, window: "5-hour", resetsAt: later });
  });

  it("does not hold below the threshold, after the reset, or with the check off", () => {
    expect(usageHold([{ resource: host("a"), measurement: ok({ usedPercent: 89.9, resetsAt: later }) }], ask)).toBeNull();
    expect(usageHold([{ resource: host("a"), measurement: ok({ usedPercent: 99, resetsAt: "2026-10-07T11:00:00Z" }) }], ask)).toBeNull();
    expect(usageHold([{ resource: host("a"), measurement: ok({ usedPercent: 99, resetsAt: later }) }], { ...ask, threshold: 0 })).toBeNull();
  });

  it("holds on any spent window of the model, and a window of another model family does not count", () => {
    const rows = [{ resource: host("a"), measurement: ok({ usedPercent: 97, resetsAt: later, model: "sonnet" }, { usedPercent: 20, model: null }) }];
    expect(usageHold(rows, ask)).toBeNull();
    expect(usageHold(rows, { ...ask, model: "claude-sonnet-5" })).toMatchObject({ percent: 97 });
    expect(usageHold([{ resource: host("a"), measurement: ok({ usedPercent: 20 }, { usedPercent: 95, resetsAt: later, model: null }) }], ask)).toMatchObject({ percent: 95 });
  });

  it("is the writer's own machine first, shared accounts only when the machine has none, and another machine's never", () => {
    const spent = ok({ usedPercent: 99, resetsAt: later });
    const free = ok({ usedPercent: 10 });
    expect(usageHold([{ resource: host("a", "claude-code", "h1"), measurement: spent }, { resource: shared("p"), measurement: free }], ask)).toMatchObject({ percent: 99 });
    expect(usageHold([{ resource: shared("p"), measurement: spent }], ask)).toMatchObject({ percent: 99 });
    expect(usageHold([{ resource: host("a", "claude-code", "h2"), measurement: spent }], ask)).toBeNull();
    expect(usageHold([{ resource: host("a", "codex", "h1"), measurement: spent }], ask)).toBeNull();
  });

  it("needs every serving account spent: one with room, or one that cannot be read, keeps the pair", () => {
    const spent = ok({ usedPercent: 99, resetsAt: later });
    expect(usageHold([{ resource: shared("p1"), measurement: spent }, { resource: shared("p2"), measurement: ok({ usedPercent: 40 }) }], ask)).toBeNull();
    expect(usageHold([{ resource: shared("p1"), measurement: spent }, { resource: shared("p2"), measurement: null }], ask)).toBeNull();
    expect(usageHold([{ resource: shared("p1"), measurement: spent }, { resource: shared("p2"), measurement: { usage: { status: "expired" } } as UsageMeasurement }], ask)).toBeNull();
    const first = usageHold([{ resource: shared("p1"), measurement: ok({ usedPercent: 99, resetsAt: later }) }, { resource: shared("p2"), measurement: ok({ usedPercent: 95, resetsAt: "2026-10-07T13:00:00Z" }) }], ask);
    expect(first).toMatchObject({ resetsAt: "2026-10-07T13:00:00.000Z" });
  });

  it("gives no reset time when a source does not report one", () => {
    expect(usageHold([{ resource: host("a"), measurement: ok({ usedPercent: 99, resetsAt: null }) }], ask)).toMatchObject({ percent: 99, resetsAt: null });
  });
});

describe("usageSkipPercent and the reason", () => {
  it("defaults to 90, takes 0 as off and ignores nonsense", () => {
    expect(usageSkipPercent({})).toBe(90);
    expect(usageSkipPercent({ "usage.skip_percent": "" })).toBe(90);
    expect(usageSkipPercent({ "usage.skip_percent": 0 })).toBe(0);
    expect(usageSkipPercent({ "usage.skip_percent": "75" })).toBe(75);
    expect(usageSkipPercent({ "usage.skip_percent": "much" })).toBe(90);
    expect(usageSkipPercent({ "usage.skip_percent": -5 })).toBe(90);
  });

  it("reads as a limit (uncharged, moves down the chain)", () => {
    const reason = usageHoldReason("claude-code", "claude-opus-4-8", { percent: 96, window: "5-hour", resetsAt: later });
    expect(reason).toContain(`resets ${later}`);
    expect(failureClass("spawn_rejected", reason)).toBe("limit");
  });
});

describe("createProviderUsage", () => {
  const sdkWith = (plugins: unknown) => ({ sdk: { plugins } }) as never;
  const readings = (percent: number, calls: string[] = []) => ({
    experimental_discoverRpc: async (query: { method: string }) => { calls.push(`discover:${query.method}`); return [{ pluginId: "provider-claude-code" }]; },
    callRpc: async ({ method, input }: { method: string; input?: unknown }) => {
      calls.push(method);
      if (method === USAGE_LIST_METHOD) return { resources: [{ id: "r1", accountKey: null, providerId: "claude-code", label: "Claude", scope: { kind: "host", hostId: "h1", hostName: "h" } }] };
      expect(input).toEqual({ resourceId: "r1", refresh: false });
      return { accountKey: null, observedAt: Date.now(), usage: { status: "ok", accountEmail: null, planLabel: null, plan: null,
        windows: [{ kind: "five-hour", id: "0:x", label: "5-hour", usedPercent: percent, resetsAt: new Date(Date.now() + 3600_000).toISOString(), model: null, cost: null }] } };
    },
  });
  const pair = { providerId: "claude-code", model: "claude-opus-4-8", hostId: "h1", threshold: 90 };

  it("reads the source contract through discovery and caches the answers", async () => {
    const calls: string[] = [];
    const usage = createProviderUsage(sdkWith(readings(95, calls)));
    expect(await usage.hold(pair)).toMatchObject({ percent: 95, window: "5-hour" });
    expect(await usage.hold(pair)).toMatchObject({ percent: 95 });
    expect(calls).toEqual([`discover:${USAGE_LIST_METHOD}`, USAGE_LIST_METHOD, USAGE_FETCH_METHOD]);
    expect(await usage.hold({ ...pair, providerId: "codex" })).toBeNull();
    expect(await createProviderUsage(sdkWith(readings(40))).hold(pair)).toBeNull();
  });

  it("holds nothing when the plugins are absent, discovery fails, a call fails, or the check is off — and never throws", async () => {
    expect(await createProviderUsage({ sdk: {} } as never).hold(pair)).toBeNull();
    expect(await createProviderUsage(sdkWith({})).hold(pair)).toBeNull();
    expect(await createProviderUsage(sdkWith({ experimental_discoverRpc: async () => { throw new Error("no such RPC"); }, callRpc: async () => ({}) })).hold(pair)).toBeNull();
    expect(await createProviderUsage(sdkWith({ experimental_discoverRpc: () => { throw new Error("sync"); }, callRpc: async () => ({}) })).hold(pair)).toBeNull();
    expect(await createProviderUsage(sdkWith({ ...readings(99), callRpc: async () => { throw new Error("source down"); } })).hold(pair)).toBeNull();
    expect(await createProviderUsage(sdkWith({ ...readings(99), callRpc: async () => ({ resources: "nonsense" }) })).hold(pair)).toBeNull();
    expect(await createProviderUsage(sdkWith(readings(99))).hold({ ...pair, threshold: 0 })).toBeNull();
  });

  it("asks a hub without any usage source once in five minutes, not for every writer", async () => {
    let discoveries = 0;
    let at = 1_000_000;
    const usage = createProviderUsage(sdkWith({ experimental_discoverRpc: async () => { discoveries += 1; return []; }, callRpc: async () => ({}) }), () => at);
    await usage.hold(pair);
    await usage.hold(pair);
    expect(discoveries).toBe(1);
    at += 6 * 60_000;
    await usage.hold(pair);
    expect(discoveries).toBe(2);
  });
});
