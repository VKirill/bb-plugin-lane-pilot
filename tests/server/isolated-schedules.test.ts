import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { scheduleIsolated } from "../../src/server/schedules";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

type Registration = { cron: string; fn: (context: { signal: AbortSignal }) => unknown; options: { isolated?: boolean; timeoutMs?: number; overlap?: string } };
const ISOLATED = ["self-repair", "parked-task-sweep", "attempt-worktree-sweep", "writer-silence-sweep", "docs-maintenance-hourly", "docs-nightly-hourly", "docs-nightly-catchup", "rules-nightly"];

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

  // 2026-10-03: a long docs schedule held self-repair back for 50 minutes because the core waits for each schedule in turn.
  it("self-repair fires on its schedule while a nightly docs pass is busy", async () => {
    let listed = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { projects: { list: () => { listed++; return new Promise(() => {}); } } } as never,
    });
    const registered = new Map<string, Registration>();
    (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, cron: string, fn: Registration["fn"], options: Registration["options"]) => { registered.set(name, { cron, fn, options }); };
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    for (const name of ISOLATED) {
      expect(registered.get(name)?.options, name).toMatchObject({ isolated: true, overlap: "skip" });
      expect(registered.get(name)?.options.timeoutMs, name).toBeGreaterThan(0);
    }
    const signal = new AbortController().signal;
    // The core starts an isolated schedule without waiting for it.
    const docs = registered.get("docs-nightly-hourly")!.fn({ signal });
    let docsSettled = false;
    void Promise.resolve(docs).then(() => { docsSettled = true; });
    const repair = await Promise.race([
      Promise.resolve(registered.get("self-repair")!.fn({ signal })).then(() => "ran"),
      new Promise((done) => setTimeout(() => done("held"), 2_000)),
    ]);
    expect(repair).toBe("ran");
    expect(listed).toBe(1);
    expect(docsSettled).toBe(false);
    // A tick that comes while the pass still runs finds it running and starts nothing more.
    const second = await Promise.race([Promise.resolve(registered.get("docs-nightly-hourly")!.fn({ signal })).then(() => "returned"), new Promise((done) => setTimeout(() => done("held"), 200))]);
    expect(second).toBe("returned");
    expect(listed).toBe(1);
  });
});
