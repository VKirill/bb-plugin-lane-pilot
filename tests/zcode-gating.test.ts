import { afterEach, describe, expect, it, vi } from "vitest";
import { roleModelKey, writerCandidates, type ModelCatalog } from "@lane-pilot/models";
import { resolveSpawnModel, spawnUsageOf } from "../src/rooms/core/server/spawn-model";
import { fullAccessSpawn } from "../src/rooms/core/server/pm-spawn";
import { noteZcodeThread, zcodeBusy, zcodeBusyPeek } from "../src/rooms/core/server/zcode-slot";
import { createWriterState } from "../src/rooms/writer/server/state";
import { createProviderUsage, usageHoldReason } from "../src/rooms/usage/server/provider-usage";
import { writerPickOverlay } from "../src/rooms/writer/writer-model-pick";
import { roleSelection, type CriticCatalog } from "../src/rooms/critique/critic-pair";
import { failureClass } from "../src/rooms/runs/failure-class";
import { WRITER_FALLBACK_SLOTS } from "../src/rooms/writer/writer-fallbacks";

/** Lane Pilot never picks the ZCode app where it cannot work: its machine, its free hours, one task at a time. */
const IN_WINDOW = Date.UTC(2026, 9, 27, 18, 0);
const OUT_OF_WINDOW = Date.UTC(2026, 9, 27, 9, 0);
const catalog = (zcodeHosts: string[] = ["mini"]): ModelCatalog => ({
  hosts: [{ id: "mini", name: "Mac mini", connected: true }, { id: "ovh", name: "OVH", connected: true }],
  providers: [
    { id: "claude-code", displayName: "Claude Code", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mini", "ovh"], models: [] },
    ...(zcodeHosts.length ? [{ id: "zcode", displayName: "ZCode", logoUrl: null, family: "acp", supportsServiceTier: false, serviceTiers: [], hostIds: zcodeHosts,
      models: [{ id: "glm-5.3-flash", model: "glm-5.3-flash", displayName: "GLM-5.3-Flash", efforts: ["low", "high", "max"], defaultEffort: "high", isDefault: true, hostIds: zcodeHosts }] }] : []),
  ],
});
const memoryOnZcode = { [roleModelKey("memory")]: { model: "glm-5.3-flash" } };
const at = (now: number) => { vi.useFakeTimers(); vi.setSystemTime(now); };
afterEach(() => vi.useRealTimers());

describe("the helpers' resolver offers ZCode only where it works", () => {
  const ask = (over: Record<string, unknown> = {}) => resolveSpawnModel({ role: "memory", settings: memoryOnZcode, pm: null, catalog: catalog(), hostId: "mini", ...over } as never);
  const onZcode = (answer: { providerId: string }) => answer.providerId === "zcode";

  it("uses the owner's pick (memory on ZCode) on the Mac mini in the free hours", () => {
    at(IN_WINDOW);
    expect(ask()).toMatchObject({ providerId: "zcode", model: "glm-5.3-flash", reasoningEffort: "high", source: "table" });
  });
  it("keeps the role's own default on a machine without the zcode provider, and with a catalog that is not known", () => {
    at(IN_WINDOW);
    expect(onZcode(ask({ hostId: "ovh" }))).toBe(false);
    expect(ask({ hostId: "ovh" })).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5", source: "role-default" });
    expect(onZcode(ask({ catalog: catalog([]) }))).toBe(false);
    expect(onZcode(ask({ catalog: null }))).toBe(false);
    expect(onZcode(ask({ hostId: null }))).toBe(false);
  });
  it("keeps the role's default outside 15:00-01:00 UTC unless zcode.window is always", () => {
    at(OUT_OF_WINDOW);
    expect(onZcode(ask())).toBe(false);
    expect(onZcode(ask({ settings: { ...memoryOnZcode, "zcode.window": "promo" } }))).toBe(false);
    expect(onZcode(ask({ settings: { ...memoryOnZcode, "zcode.window": "always" } }))).toBe(true);
  });
  it("keeps the role's default while a ZCode task runs (one slot)", () => {
    at(IN_WINDOW);
    expect(onZcode(ask({ usage: { peek: () => null, warm: async () => undefined, zcodeBusy: () => true } }))).toBe(false);
    expect(onZcode(ask({ usage: { peek: () => null, warm: async () => undefined, zcodeBusy: () => false } }))).toBe(true);
  });
  it("makes a graph agent step (any role) able to run on it when the table points there", () => {
    at(IN_WINDOW);
    for (const role of ["memory", "project-life", "docs-maintainer", "errand", "analyst"]) {
      const settings = { [roleModelKey(role)]: { model: "glm-5.3-flash", reasoning_effort: "max" } };
      expect(resolveSpawnModel({ role, settings, pm: null, catalog: catalog(), hostId: "mini" }), role).toMatchObject({ providerId: "zcode", model: "glm-5.3-flash", reasoningEffort: "max" });
    }
  });
});

describe("the slot: a thread Lane Pilot started on ZCode holds it until BB says it is idle", () => {
  const bbWith = (status: () => string | null) => ({ sdk: { threads: { get: vi.fn(async () => (status() ? { id: "t1", status: status() } : null)) } } }) as never;

  it("is busy at the spawn, free once the thread is idle, busy again when it works again, and forgets a thread BB does not answer for after hours", async () => {
    let status: string | null = "active";
    const bb = bbWith(() => status);
    expect(zcodeBusyPeek(bb)).toBe(false);
    noteZcodeThread(bb, "t1", Date.now());
    expect(zcodeBusyPeek(bb)).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    expect(await zcodeBusy(bb, Date.now())).toBe(true);
    status = "idle";
    vi.setSystemTime(Date.now() + 10_000);
    expect(await zcodeBusy(bb, Date.now())).toBe(false);
    status = "active";
    vi.setSystemTime(Date.now() + 10_000);
    expect(await zcodeBusy(bb, Date.now())).toBe(true);
    status = null;
    vi.setSystemTime(Date.now() + 4 * 60 * 60_000);
    expect(await zcodeBusy(bb, Date.now())).toBe(false);
  });
  it("is noted by fullAccessSpawn for the zcode provider only", async () => {
    const spawn = vi.fn(async (args: { providerId: string }) => ({ id: `thread-${args.providerId}` }));
    const bb = { sdk: { threads: { spawn, get: async () => ({ status: "active" }) }, providers: { list: async () => [] } }, log: { warn: () => undefined } } as never;
    await fullAccessSpawn(bb, { providerId: "claude-code", model: "m" } as never);
    expect(zcodeBusyPeek(bb)).toBe(false);
    await fullAccessSpawn(bb, { providerId: "zcode", model: "glm-5.3-flash" } as never);
    expect(zcodeBusyPeek(bb)).toBe(true);
  });
});

describe("the writers: a hold on the zcode pair, whatever the usage threshold", () => {
  it("holds with the machine's reason (no percentage), at threshold 0 too, and not another provider", async () => {
    const closed = { code: "window" as const, detail: "ZCode is free only 15:00-01:00 UTC", resetsAt: "2026-10-28T15:00:00.000Z" };
    const usage = createProviderUsage({ sdk: {} } as never, Date.now, async () => closed);
    const hold = await usage.hold({ providerId: "zcode", model: "glm-5.3-flash", hostId: "mini", threshold: 0 });
    expect(hold).toMatchObject({ window: closed.detail, resetsAt: closed.resetsAt });
    const reason = usageHoldReason("zcode", "glm-5.3-flash", hold!);
    expect(reason).toBe("writer_provider_unavailable:usage_window:zcode/glm-5.3-flash: ZCode is free only 15:00-01:00 UTC, resets 2026-10-28T15:00:00.000Z");
    expect(failureClass("spawn_rejected", reason)).toBe("limit");
    expect(await usage.hold({ providerId: "claude-code", model: "m", hostId: "mini", threshold: 0 })).toBeNull();
    expect(await createProviderUsage({ sdk: {} } as never, Date.now, async () => null).hold({ providerId: "zcode", model: "glm-5.3-flash", hostId: "mini", threshold: 90 })).toBeNull();
    // A probe that cannot answer is a hold: the app is never sent work blind.
    expect(await createProviderUsage({ sdk: {} } as never, Date.now, async () => { throw new Error("x"); }).hold({ providerId: "zcode", model: "glm-5.3-flash", hostId: "mini", threshold: 90 })).toMatchObject({ percent: 100 });
  });

  it("through the real writer state: free on the Mac mini in the free hours, held elsewhere, outside the hours and while its slot is taken", async () => {
    const threads = new Map<string, string>();
    const bb = {
      events: { on: () => () => undefined },
      sdk: {
        hosts: { list: async () => [{ id: "mini", name: "Mac mini", status: "connected" }, { id: "ovh", name: "OVH", status: "connected" }] },
        providers: {
          list: async ({ hostId }: { hostId: string }) => (hostId === "mini" ? [{ id: "zcode", displayName: "ZCode", available: true }] : [{ id: "claude-code", displayName: "Claude Code", available: true }]),
          models: async ({ providerId }: { providerId: string }) => ({ models: providerId === "zcode" ? [{ id: "glm-5.3-flash", model: "glm-5.3-flash", displayName: "GLM", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high", isDefault: true }] : [] }),
        },
        threads: { get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: threads.get(threadId) ?? "idle" }) },
      },
    } as never;
    const state = createWriterState({ bb, log: () => undefined } as never);
    const hold = (hostId: string, settings: Record<string, unknown> = {}) => state.providerUsage.hold({ providerId: "zcode", model: "glm-5.3-flash", hostId, threshold: 90, settings });
    at(IN_WINDOW);
    expect(await hold("mini")).toBeNull();
    expect(await hold("ovh")).toMatchObject({ window: expect.stringContaining("only the Mac mini") });
    noteZcodeThread(bb, "w1");
    threads.set("w1", "active");
    vi.setSystemTime(IN_WINDOW + 10_000);
    expect(await hold("mini")).toMatchObject({ window: expect.stringContaining("busy") });
    threads.set("w1", "idle");
    vi.setSystemTime(IN_WINDOW + 20_000);
    expect(await hold("mini")).toBeNull();
    vi.setSystemTime(OUT_OF_WINDOW);
    expect(await hold("mini")).toMatchObject({ window: expect.stringContaining("15:00-01:00 UTC"), resetsAt: new Date(Date.UTC(2026, 9, 27, 15)).toISOString() });
    expect(await hold("mini", { "zcode.window": "always" })).toBeNull();
    // The helpers' resolver reads the same slot through the registered usage.
    vi.setSystemTime(IN_WINDOW + 40_000);
    noteZcodeThread(bb, "w2");
    threads.set("w2", "active");
    const usage = spawnUsageOf({ bb })!;
    expect(usage.zcodeBusy?.()).toBe(true);
  });
});

describe("the writer pick does not offer ZCode where it cannot work", () => {
  const kv = () => { const map = new Map<string, unknown>(); return { get: async (key: string) => map.get(key), set: async (key: string, value: unknown) => { map.set(key, value); } }; };
  const input = { projectId: "p", runId: "r", taskId: "t1", task: { title: "Port the docs", objective: "x", owns_paths: ["docs/**"], expected_outputs: ["docs/a.md"], acceptance: ["npm test"] } };
  const settings = { "writer.provider": "acp-cursor", "writer.model": "composer-2.5", "writer.reasoning_effort": "medium" };

  it("hands Jev the candidates without ZCode when it is held, and with it when it is not", async () => {
    const seen: string[][] = [];
    const jev = { enabled: () => true, judge: async (_judgment: unknown, state: { candidates: Array<{ key: string }> }) => { seen.push(state.candidates.map((row) => row.key)); return { by: "jev", decision: { key: "zcode-flash" } }; } } as never;
    const held = await writerPickOverlay({ kv: kv(), jev, log: () => undefined, held: async (profile) => profile.providerId === "zcode" }, settings, input);
    expect(seen[0]).not.toContain("zcode-flash");
    expect(seen[0]).toContain("composer");
    // Jev had no ZCode to name: its answer is not a candidate, so the project's writer writes.
    expect(held).toBeNull();
    const free = await writerPickOverlay({ kv: kv(), jev, log: () => undefined, held: async () => false }, settings, { ...input, taskId: "t2" });
    expect(seen[1]).toContain("zcode-flash");
    expect(free).toMatchObject({ "writer.provider": "zcode", "writer.model": "glm-5.3-flash", "writer.reasoning_effort": "high", "writer.picked": "zcode-flash", "writer.fallback1.model": "composer-2.5" });
    expect(WRITER_FALLBACK_SLOTS).toHaveLength(3);
    expect(writerCandidates({}).map((row) => row.key)).toContain("zcode-flash");
  });
});

describe("the pipeline's critics: a held ZCode pick gives way to the row's default", () => {
  const critic: CriticCatalog = {
    provider: async (id) => ({ id, available: true, supportsServiceTier: false, serviceTiers: [] }),
    models: async (id) => (id === "zcode" ? [{ id: "glm-5.3-flash", model: "glm-5.3-flash", efforts: ["low", "high", "max"] }] : [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", efforts: ["high", "medium"] }, { id: "router9/ag/gemini-3.8-flash-high", model: "router9/ag/gemini-3.8-flash-high", efforts: ["medium"] }]),
  };
  const settings = { [roleModelKey("code-critic")]: { model: "glm-5.3-flash", reasoning_effort: "high" } };
  const fallback = { providerId: "claude-code", model: "claude-sonnet-5-5" };

  it("runs on ZCode in the free hours with the slot free, on the row's default outside them or while busy", async () => {
    at(IN_WINDOW);
    expect(await roleSelection({ catalog: critic, settings, role: "code-critic", fallback })).toMatchObject({ providerId: "zcode", model: "glm-5.3-flash", effort: "high", source: "table" });
    expect(await roleSelection({ catalog: critic, settings, role: "code-critic", fallback, zcodeBusy: true })).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", source: "default" });
    at(OUT_OF_WINDOW);
    expect(await roleSelection({ catalog: critic, settings, role: "code-critic", fallback })).toMatchObject({ providerId: "opencode2", source: "default" });
    expect(await roleSelection({ catalog: critic, settings: { ...settings, "zcode.window": "always" }, role: "code-critic", fallback })).toMatchObject({ providerId: "zcode" });
  });
});
