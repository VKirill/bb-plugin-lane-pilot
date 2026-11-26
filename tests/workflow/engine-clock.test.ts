import { describe, expect, it, vi } from "vitest";
import { END, START, parseWorkflow } from "@lane-pilot/workflow-engine";
import type { ClockTimers } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, rows } from "./engine-helpers";

const waitGraph = (durationSec: number) => parseWorkflow({
  id: "clock-wait",
  name: { en: "clock-wait", ru: "clock-wait" },
  description: { en: "clock-wait", ru: "clock-wait" },
  outputs: [{ name: "woke", type: "string" }],
  nodes: [
    { id: "wait", type: "action", uses: "builtin:wait", params: { event: "clock.ping", eventKey: `k-${durationSec}`, durationSec } },
  ],
  edges: [{ from: START, to: "wait" }, { from: "wait", to: END, with: { woke: "wait.woke" } }],
});

/** A manual timer: the test decides when it fires, and can see that only one is ever armed. */
function manualTimers() {
  let live: { fn: () => void; ms: number } | null = null;
  let armedTwice = 0;
  const timers: ClockTimers = {
    set: (fn, ms) => { if (live) armedTwice += 1; const handle = { fn, ms }; live = handle; return handle; },
    clear: (handle) => { if (live === handle) live = null; },
  };
  return { timers, live: () => live, armedTwice: () => armedTwice };
}

const stateOf = (db: ReturnType<typeof journalDb>, runId: string) => rows<{ status: string }>(db, "SELECT status FROM lane_pilot_wf_run WHERE id=?", runId)[0]!.status;

describe("engine clock", () => {
  it("sleeps to the nearest deadline with one timer and fires two deadlines in order", async () => {
    const db = journalDb();
    let at = 1_000_000;
    const engine = engineOn(db, {}, { now: () => at });
    const timer = manualTimers();
    const clock = engine.startClock({ timers: timer.timers });
    const slow = engine.start({ workflow: waitGraph(20), inputs: {} });
    const fast = engine.start({ workflow: waitGraph(10), inputs: {} });
    await vi.waitFor(() => expect(clock.armedAt()).toBe(1_010_000));
    expect(timer.armedTwice()).toBe(0);

    at = 1_010_000;
    await clock.tick();
    await engine.idle();
    expect(stateOf(db, fast.runId)).toBe("succeeded");
    expect(stateOf(db, slow.runId)).toBe("waiting");
    expect(clock.armedAt()).toBe(1_020_000);

    at = 1_020_000;
    await clock.tick();
    await engine.idle();
    expect(stateOf(db, slow.runId)).toBe("succeeded");
    expect(engine.get(slow.runId)!.output).toEqual({ woke: "timeout" });
    engine.dispose();
  });

  it("holds everything while paused, keeps beating, and fires the overdue deadline once on resume", async () => {
    const db = journalDb();
    let at = 1_000_000;
    let paused = false;
    const beats: number[] = [];
    const engine = engineOn(db, {}, { now: () => at });
    const timer = manualTimers();
    const clock = engine.startClock({ timers: timer.timers, isPaused: () => paused, onBeat: (when) => beats.push(when) });
    const first = engine.start({ workflow: waitGraph(10), inputs: {} });
    const second = engine.start({ workflow: waitGraph(20), inputs: {} });
    await vi.waitFor(() => expect(clock.armedAt()).toBe(1_010_000));

    paused = true;
    at = 1_030_000;
    await clock.tick();
    await engine.idle();
    expect(stateOf(db, first.runId)).toBe("waiting");
    expect(stateOf(db, second.runId)).toBe("waiting");
    expect(beats).toEqual([1_030_000]);
    expect(clock.armedAt()).toBe(1_030_000 + 60_000);

    paused = false;
    clock.arm();
    expect(clock.armedAt()).toBe(1_030_000);
    await clock.tick();
    await engine.idle();
    // Both are overdue by now: each fires once, oldest deadline first, and nothing fires twice.
    expect(stateOf(db, first.runId)).toBe("succeeded");
    expect(stateOf(db, second.runId)).toBe("succeeded");
    expect(rows(db, "SELECT 1 FROM lane_pilot_wf_step WHERE state='succeeded' AND node_id='wait'")).toHaveLength(2);
    engine.dispose();
  });

  it("fires 100 overdue deadlines after a restart in deadline order within the cap, and a fresh event still wakes its step", async () => {
    const db = journalDb();
    let at = 1_000_000;
    const before = engineOn(db, {}, { now: () => at, instanceId: "before" });
    const runs: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      at = 1_000_000 + index * 1_000;
      runs.push(before.start({ workflow: waitGraph(10), inputs: {} }).runId);
    }
    await vi.waitFor(() => expect(rows(db, "SELECT 1 FROM lane_pilot_wf_step WHERE state='waiting'")).toHaveLength(100));
    // A step that waits for an event, far from its deadline.
    const fresh = before.start({ workflow: waitGraph(100_000), inputs: {} });
    await vi.waitFor(() => expect(rows(db, "SELECT 1 FROM lane_pilot_wf_step WHERE state='waiting'")).toHaveLength(101));
    before.dispose();

    at = 2_000_000;
    const after = engineOn(db, {}, { now: () => at, instanceId: "after", overdueCap: 10 });
    const clock = after.startClock({ timers: manualTimers().timers });
    await after.resume({ takeOver: true });
    await after.idle();
    const doneNow = () => runs.filter((id) => stateOf(db, id) === "succeeded");
    expect(doneNow()).toEqual(runs.slice(0, 10));

    expect(await after.wake("clock.ping", "k-100000", {})).toBe(1);
    await after.idle();
    expect(stateOf(db, fresh.runId)).toBe("succeeded");
    expect(doneNow()).toEqual(runs.slice(0, 10));

    for (let tick = 0; tick < 9; tick += 1) { await clock.tick(); await after.idle(); expect(doneNow()).toEqual(runs.slice(0, 10 * (tick + 2))); }
    expect(doneNow()).toEqual(runs);
    after.dispose();
  });
});
