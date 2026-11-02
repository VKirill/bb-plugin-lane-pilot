import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { PRESENCE_WINDOW_MS, type Presence } from "../src/rooms/owner-presence";
import { createProviderBreaker } from "@lane-pilot/resilience";
import { createAttempt, createRun, createTask, getAttempt, listDueWakes, openDatabase, parkAttemptWake, claimAttemptWake } from "../src/rooms/storage/database";
import { waitingWriterReason, waitingWriterText, walkWriterChain, writerHold, type WriterHoldDeps } from "../src/rooms/writer/server/writer-hold";

const NOW = 1_700_000_000_000;

function deps(input: { presence?: Presence[]; usageHold?: { percent: number; window: string; resetsAt: string | null } | null; coreHosts?: (id: string) => boolean; breaker?: ReturnType<typeof createProviderBreaker> } = {}): WriterHoldDeps {
  const marks = input.presence ?? [];
  return {
    breaker: input.breaker ?? createProviderBreaker(),
    presence: {
      holds: (providerId, now = NOW) => {
        const mark = marks.find((row) => row.providerId === providerId);
        return mark && now - mark.at <= PRESENCE_WINDOW_MS ? `owner_present:${providerId} used by the owner` : null;
      },
      current: () => marks,
    },
    usage: { hold: async () => input.usageHold ?? null },
    coreHosts: input.coreHosts ?? (() => true),
  };
}

const sel = (providerId = "claude-code", model = "sonnet") => ({ providerId, model, hostId: "h1", settings: {} });

describe("writerHold", () => {
  it("is free when nothing holds the pair", async () => {
    expect(await writerHold(sel(), deps(), NOW)).toBeNull();
  });

  it("holds while the owner used the provider inside the window, until mark + PRESENCE_WINDOW_MS", async () => {
    const mark = { providerId: "claude-code", at: NOW - 60_000, hostId: "h1", host: "mini" };
    const hold = await writerHold(sel(), deps({ presence: [mark] }), NOW);
    expect(hold).toMatchObject({ until: mark.at + PRESENCE_WINDOW_MS });
    expect(hold!.reason).toContain("owner_present:claude-code");
    // Outside the window the same mark holds nothing.
    expect(await writerHold(sel(), deps({ presence: [mark] }), NOW + PRESENCE_WINDOW_MS)).toBeNull();
  });

  it("holds on a spent usage window until resetsAt, or +15 min without one", async () => {
    const reset = new Date(NOW + 3_600_000).toISOString();
    const hold = await writerHold(sel(), deps({ usageHold: { percent: 95, window: "weekly", resetsAt: reset } }), NOW);
    expect(hold).toMatchObject({ until: Date.parse(reset) });
    expect(hold!.reason).toContain("usage_window:claude-code/sonnet");
    const unknown = await writerHold(sel(), deps({ usageHold: { percent: 95, window: "weekly", resetsAt: null } }), NOW);
    expect(unknown!.until).toBe(NOW + 15 * 60_000);
  });

  it("holds forever (until:null) on core_unsupported", async () => {
    const hold = await writerHold(sel("devin"), deps({ coreHosts: () => false }), NOW);
    expect(hold).toMatchObject({ until: null });
    expect(hold!.reason).toContain("core_unsupported:devin");
  });

  it("holds on an open breaker with a recheck in 5 minutes, without spending a trial", async () => {
    const breaker = createProviderBreaker();
    for (let index = 0; index < 3; index += 1) breaker.record("claude-code/sonnet", "failure", NOW - 1000);
    const hold = await writerHold(sel(), deps({ breaker }), NOW);
    expect(hold!.reason).toContain("breaker_open");
    expect(hold!.until).toBeLessThanOrEqual(NOW + 5 * 60_000);
    // The snapshot must not have taken the half-open trial: decide still allows one when the pair is open? No —
    // open is not half_open yet, so decide refuses; the point is no trialInFlight was set by the read.
    expect(breaker.decide("claude-code/sonnet", NOW).allow).toBe(false);
  });
});

describe("walkWriterChain", () => {
  it("primary held, fallback free → the fallback is the pick", async () => {
    const walk = await walkWriterChain(
      [{ providerId: "claude-code", model: "sonnet" }, { providerId: "codex", model: "gpt" }, { providerId: "pm", model: "m" }],
      { hostId: "h1", settings: {} },
      deps({ presence: [{ providerId: "claude-code", at: NOW - 1000, hostId: "h1", host: null }] }), NOW);
    expect(walk.free).toMatchObject({ index: 1 });
  });

  it("all held → no free member, wakeAt is the earliest until, shortest is that hold", async () => {
    const resetSoon = new Date(NOW + 300_000).toISOString();
    const walk = await walkWriterChain(
      [{ providerId: "claude-code", model: "sonnet" }, { providerId: "codex", model: "gpt" }],
      { hostId: "h1", settings: {} },
      {
        ...deps({ presence: [{ providerId: "claude-code", at: NOW - 1000, hostId: "h1", host: null }] }),
        usage: { hold: async () => ({ percent: 99, window: "5h", resetsAt: resetSoon }) },
      }, NOW);
    expect(walk.free).toBeUndefined();
    expect(walk.wakeAt).toBe(Date.parse(resetSoon));
    expect(walk.shortest!.hold.reason).toContain("usage_window");
    expect(walk.allUnsupported).toBe(false);
  });

  it("all core_unsupported → allUnsupported, wakeAt null", async () => {
    const walk = await walkWriterChain(
      [{ providerId: "devin", model: "d" }, { providerId: "devin", model: "e" }],
      { hostId: "h1", settings: {} }, deps({ coreHosts: () => false }), NOW);
    expect(walk.free).toBeUndefined();
    expect(walk.allUnsupported).toBe(true);
    expect(walk.wakeAt).toBeNull();
  });
});

describe("parked attempt and the waker's claim", () => {
  it("parkAttemptWake keeps the attempt queued with the reason and wake_at; claim clears it once", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "bb", "/repo");
    createTask(db, { id: "T1", runId: "run", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    parkAttemptWake(db, "a1", waitingWriterReason({ reason: "writer_provider_unavailable:owner_present:x", until: NOW + 60_000 }), NOW + 60_000);
    const attempt = getAttempt(db, "a1")!;
    expect(attempt.state).toBe("queued");
    expect(attempt.reason).toContain("waiting_writer:");
    expect(listDueWakes(db, NOW + 60_000).map((row) => row.id)).toEqual(["a1"]);
    expect(listDueWakes(db, NOW + 59_000)).toEqual([]);
    // Two ticks race: only the first claim wins.
    expect(claimAttemptWake(db, "a1")).toBe(true);
    expect(claimAttemptWake(db, "a1")).toBe(false);
  });
});

describe("waitingWriterText", () => {
  it("says what the board shows in Russian with the recheck minutes", () => {
    const text = waitingWriterText(
      { reason: "writer_provider_unavailable:owner_present:claude-code used by the owner 2 min ago on mini", until: NOW + 480_000 }, NOW + 480_000, NOW);
    expect(text).toBe("Ждёт писателя: владелец работает в Claude Code, проверка через 8 мин");
  });
});
