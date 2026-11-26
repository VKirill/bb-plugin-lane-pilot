import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { scheduleIsolated } from "../../src/rooms/platform/server/services/schedules";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

type Registration = { cron: string; fn: (context: { signal: AbortSignal }) => unknown; options: { isolated?: boolean; timeoutMs?: number; overlap?: string } };
const ISOLATED = ["engine-clock"];
const REMOVED_ISOLATED = ["workflow-schedules", "schedule-board-tick", "landing-suite", "task-reconcile", "attempt-worktree-sweep", "runs-sweep", "handoff-expiry"];

describe("isolated schedules", () => {
  it("registers through experimental_vkSchedule when the core has it, with a limit and no overlap", () => {
    const registered: Array<[string, Registration["options"]]> = [];
    const plain: string[] = [];
    const bb = { background: {
      experimental_vkSchedule: (name: string, _cron: string, _fn: unknown, options: Registration["options"]) => { registered.push([name, options]); },
      schedule: (name: string) => { plain.push(name); },
    } } as never;
    scheduleIsolated(bb, "x", "* * * * *", () => undefined, { timeoutMs: 1234 });
    expect(registered).toEqual([["x", { isolated: true, timeoutMs: 1234, overlap: "skip" }]]);
    expect(plain).toEqual([]);
  });

  it("without the core function it is the ordinary schedule, with the fallback work if one is given", async () => {
    const ran: string[] = [];
    const schedules = new Map<string, () => unknown>();
    const bb = { background: { schedule: (name: string, _cron: string, fn: () => unknown) => { schedules.set(name, fn); } } } as never;
    scheduleIsolated(bb, "a", "* * * * *", () => { ran.push("work"); }, { timeoutMs: 1 });
    scheduleIsolated(bb, "b", "* * * * *", () => { ran.push("work"); }, { timeoutMs: 1, fallback: () => { ran.push("fallback"); } });
    await schedules.get("a")!();
    await schedules.get("b")!();
    expect(ran).toEqual(["work", "fallback"]);
  });

  it("registers all expected isolated schedules with non-overlap and positive timeouts", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const logs: string[] = [];
    const origInfo = bb.log.info.bind(bb.log);
    bb.log.info = (msg: string) => { logs.push(msg); return origInfo(msg); };
    const registered = new Map<string, Registration>();
    (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, cron: string, fn: Registration["fn"], options: Registration["options"]) => { registered.set(name, { cron, fn, options }); };
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    for (const name of ISOLATED) {
      expect(registered.get(name)?.options, name).toMatchObject({ isolated: true, overlap: "skip" });
      expect(registered.get(name)?.options.timeoutMs, name).toBeGreaterThan(0);
    }
    expect(registered.size).toBe(1);
    for (const name of REMOVED_ISOLATED) {
      expect(registered.has(name), name).toBe(false);
    }
    expect(logs).toContain("Lane Pilot clock: scheduler=engine-clock timers=1, 0 waiting steps, 0 calendar rows");
  });
});
