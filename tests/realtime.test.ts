import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, openDatabase, transitionAttempt } from "../src/rooms/storage/database";
import { createRealtime, mountHelperSignals, REALTIME_WINDOW_MS } from "../src/server/realtime";
import { lpChannel, parseLpSignal } from "@lane-pilot/ui-kit/realtime-channel";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const realtime = createRealtime(bb, () => undefined);
  return { bb, harness, db, realtime };
}

describe("realtime signals (H6)", () => {
  it("publishes one coalesced signal per project, kind and chat on lp:<project>", () => {
    const { harness, realtime } = setup();
    realtime.notify("proj_1", "council");
    realtime.notify("proj_1", "council");
    realtime.notify("proj_1", "rules");
    realtime.notify("proj_2", "council");
    expect(harness.realtimeSignals).toHaveLength(0);
    vi.advanceTimersByTime(REALTIME_WINDOW_MS + 1);
    const signals = harness.realtimeSignals.map((row) => ({ channel: row.channel, payload: row.payload }));
    expect(signals).toEqual([
      { channel: "lp:proj_1", payload: { kind: "council" } },
      { channel: "lp:proj_1", payload: { kind: "rules" } },
      { channel: "lp:proj_2", payload: { kind: "council" } },
    ]);
    realtime.notify("proj_1", "council");
    vi.advanceTimersByTime(REALTIME_WINDOW_MS + 1);
    expect(harness.realtimeSignals).toHaveLength(4);
  });

  it("does nothing on a BB without bb.realtime", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const bare = { ...bb, realtime: undefined } as unknown as typeof bb;
    const realtime = createRealtime(bare, () => undefined);
    expect(() => { realtime.notify("proj_1", "rules"); vi.advanceTimersByTime(1000); }).not.toThrow();
  });

  it("a failing publish is logged once and never thrown", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const logs: string[] = [];
    const broken = { ...bb, realtime: { publish: () => { throw new Error("socket closed"); } } } as unknown as typeof bb;
    const realtime = createRealtime(broken, (line) => logs.push(line));
    realtime.notify("p", "rules");
    vi.advanceTimersByTime(REALTIME_WINDOW_MS + 1);
    realtime.notify("p", "council");
    vi.advanceTimersByTime(REALTIME_WINDOW_MS + 1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("socket closed");
  });

  it("signals the PM chat's helpers on thread events of its children and on attempt moves", async () => {
    const { bb, harness, db, realtime } = setup();
    createRun(db, "run", "proj_1", "cli", "/repo");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run'").run();
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run','bb','{}',1)").run();
    const stop = mountHelperSignals(bb, db, realtime);

    await harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "thr_w", projectId: "proj_1", parentThreadId: "thr_pm" }) });
    // A child of some other chat (not a Lane Pilot PM) and a thread with no parent are not ours.
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_x", projectId: "proj_1", parentThreadId: "thr_other" }), lastAssistantText: null });
    await harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_y", projectId: "proj_1", parentThreadId: null }) });
    vi.advanceTimersByTime(REALTIME_WINDOW_MS + 1);
    expect(harness.realtimeSignals.map((row) => [row.channel, row.payload])).toEqual([["lp:proj_1", { kind: "helpers", threadId: "thr_pm" }]]);

    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    vi.advanceTimersByTime(REALTIME_WINDOW_MS + 1);
    expect(harness.realtimeSignals).toHaveLength(2);

    stop();
    transitionAttempt(db, "a1", "running", { threadId: "thr_w" });
    vi.advanceTimersByTime(REALTIME_WINDOW_MS + 1);
    expect(harness.realtimeSignals).toHaveLength(2);
  });

  it("the channel and the payload are one contract for server and screens", () => {
    expect(lpChannel("proj_1")).toBe("lp:proj_1");
    expect(parseLpSignal({ kind: "rules" })).toEqual({ kind: "rules" });
    expect(parseLpSignal({ kind: "helpers", threadId: "thr" })).toEqual({ kind: "helpers", threadId: "thr" });
    expect(parseLpSignal({ kind: "nope" })).toBeNull();
    expect(parseLpSignal(null)).toBeNull();
  });
});
