import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { openDatabase } from "../../src/database";
import { cleanupFinishedAttemptEnvironments, closeAbandonedRuns } from "../../src/server/run-finish";
import { createCore } from "../../src/server/core";
import { createDeployDrain } from "../../src/server/deploy-drain";
import { createHostJobs } from "../../src/server/host-jobs";
import { currentScheduleSignal, scheduleIsolated } from "../../src/server/schedules";
import { sweepWriterSilence } from "../../src/server/writer-silence";

type Fn = (context: { signal: AbortSignal }) => unknown;
const fakeCore = () => {
  const registered = new Map<string, Fn>();
  const bb = { background: { experimental_vkSchedule: (name: string, _cron: string, fn: Fn) => { registered.set(name, fn); } } } as never;
  return { bb, registered };
};
const never = () => new Promise<never>(() => undefined);
const settles = (work: Promise<unknown>) => Promise.race([work.then(() => "resolved", (cause: Error) => `rejected: ${cause.message}`), new Promise((done) => setTimeout(() => done("pending"), 150))]);

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("isolated schedule runs and the core's signal", () => {
  it("hands the signal to the body and keeps it as the ambient signal of the run", async () => {
    const { bb, registered } = fakeCore();
    let given: AbortSignal | undefined, ambient: AbortSignal | undefined;
    scheduleIsolated(bb, "x", "* * * * *", async (signal) => { given = signal; await Promise.resolve(); ambient = currentScheduleSignal(); }, { timeoutMs: 1000 });
    const controller = new AbortController();
    await registered.get("x")!({ signal: controller.signal });
    expect(given).toBe(controller.signal);
    expect(ambient).toBe(controller.signal);
    expect(currentScheduleSignal()).toBeUndefined();
  });

  it("frees the slot when the core aborts a body that hangs, and the next tick runs", async () => {
    const { bb, registered } = fakeCore();
    let starts = 0;
    scheduleIsolated(bb, "hung", "* * * * *", () => { starts++; return starts === 1 ? never() : "ok"; }, { timeoutMs: 1000 });
    const first = new AbortController();
    const running = Promise.resolve(registered.get("hung")!({ signal: first.signal }));
    expect(await settles(running)).toBe("pending");
    first.abort(new Error("timeout after 1000ms"));
    expect(await settles(running)).toBe("rejected: timeout after 1000ms");
    await registered.get("hung")!({ signal: new AbortController().signal });
    expect(starts).toBe(2);
  });

  it("a run that is already aborted starts nothing that matters and rejects at once", async () => {
    const { bb, registered } = fakeCore();
    scheduleIsolated(bb, "late", "* * * * *", never, { timeoutMs: 1000 });
    const controller = new AbortController();
    controller.abort(new Error("aborted: plugin stopped or reloaded"));
    expect(await settles(Promise.resolve(registered.get("late")!({ signal: controller.signal })))).toBe("rejected: aborted: plugin stopped or reloaded");
  });

  it("the nightly docs tick that hangs is released at the abort and does not block the following tick", async () => {
    let listed = 0;
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { projects: { list: () => { listed++; return never(); } } } as never });
    const registered = new Map<string, Fn>();
    (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, _cron: string, fn: Fn) => { registered.set(name, fn); };
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const tick = registered.get("docs-nightly-hourly")!;
    const first = new AbortController();
    const running = Promise.resolve(tick({ signal: first.signal }));
    await new Promise((wake) => setTimeout(wake, 50));
    expect(listed).toBe(1);
    // While it hangs a second tick finds it running and starts nothing.
    expect(await settles(Promise.resolve(tick({ signal: new AbortController().signal })))).toBe("resolved");
    expect(listed).toBe(1);
    first.abort(new Error("timeout after 1000ms"));
    expect(await settles(running)).toBe("rejected: timeout after 1000ms");
    void Promise.resolve(tick({ signal: new AbortController().signal }));
    await new Promise((wake) => setTimeout(wake, 50));
    expect(listed).toBe(2);
  });

  it("the remaining ordinary schedules are isolated with a limit", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const registered = new Map<string, { cron: string; options: { isolated?: boolean; timeoutMs?: number; overlap?: string } }>();
    const plain: string[] = [];
    (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, cron: string, _fn: Fn, options: never) => { registered.set(name, { cron, options }); };
    const schedule = bb.background.schedule.bind(bb.background);
    (bb.background as unknown as Record<string, unknown>).schedule = (name: string, ...rest: unknown[]) => { plain.push(name); return (schedule as (...args: unknown[]) => unknown)(name, ...rest); };
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    for (const name of ["stability-drill", "rules-triage", "runs-sweep", "lessons-sweep", "handoff-expiry", "token-usage-sync"]) {
      expect(registered.get(name)?.options, name).toMatchObject({ isolated: true, overlap: "skip" });
      expect(registered.get(name)?.options.timeoutMs, name).toBeGreaterThan(0);
    }
    expect(plain).toEqual([]);
    // BB starts at most 8 isolated runs at once and skips the tick of a ninth: the new ones are off minute 0.
    const crowdedAtZero = [...registered].filter(([, row]) => /^(\*\/5|\*\/15|\*\/30|0|\*\/10|\*\/2) /.test(row.cron) || /^0 /.test(row.cron)).map(([name]) => name);
    for (const name of ["rules-triage", "runs-sweep", "lessons-sweep", "handoff-expiry", "token-usage-sync", "stability-drill"]) expect(crowdedAtZero, name).not.toContain(name);
  });
});

describe("what runs inside an isolated run stops with it", () => {
  it("a host call made inside the run carries its signal and is cancelled with it", async () => {
    let seen: AbortSignal | undefined;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: async (call) => { seen = call.signal; return await new Promise((_, reject) => call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true })); },
    });
    dispose = () => harness.lifecycle.dispose();
    const core = createCore(bb, openDatabase(bb));
    const registered = new Map<string, Fn>();
    (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, _cron: string, fn: Fn) => { registered.set(name, fn); };
    scheduleIsolated(bb, "calls", "* * * * *", async () => { await core.host.call("diskFree", { requestedHostId: "h", path: "/" }, { hostId: "h" }); }, { timeoutMs: 1000 });
    const controller = new AbortController();
    const running = Promise.resolve(registered.get("calls")!({ signal: controller.signal }));
    await new Promise((wake) => setTimeout(wake, 50));
    expect(seen).toBeDefined();
    controller.abort(new Error("timeout after 1000ms"));
    expect(await settles(running)).toBe("rejected: timeout after 1000ms");
    // Outside a run a call gets no signal of its own.
    seen = undefined;
    void core.host.call("diskFree", { requestedHostId: "h", path: "/" }, { hostId: "h" }).catch(() => undefined);
    await new Promise((wake) => setTimeout(wake, 50));
    expect(seen).toBeUndefined();
  });

  it("a call held by a deploy drain gives up when its run is aborted", async () => {
    const drain = createDeployDrain(() => false, () => Date.now(), 5);
    drain.set(true);
    const controller = new AbortController();
    const held = drain.around("gitIntegrate", async () => "ran", controller.signal);
    setTimeout(() => controller.abort(new Error("timeout after 1000ms")), 20);
    await expect(held).rejects.toThrow("timeout after 1000ms");
  });

  it("a host job poll stops at the abort and leaves the job to the host", async () => {
    const calls: string[] = [];
    const store = new Map<string, unknown>();
    const jobs = createHostJobs({
      call: async (method) => { calls.push(method); return method === "jobStart" ? { jobId: "job_abcdefghij1" } : { state: "running", error: null, progress: { updatedAt: Date.now() } }; },
      kv: { get: async <T>(key: string) => store.get(key) as T | undefined, set: async (key, value) => { store.set(key, value); }, delete: async (key) => { store.delete(key); } },
      disposed: () => false,
      sleep: () => new Promise<void>((wake) => setTimeout(wake, 5)),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("timeout after 1000ms")), 20);
    await expect(jobs.run("gitIntegrate", { a: 1 }, { hostId: "h", signal: controller.signal }, never)).rejects.toThrow("timeout after 1000ms");
    expect(calls).not.toContain("jobCancel");
    expect(store.size).toBe(1);
  });

  it("the sweeps check the signal between steps", async () => {
    const aborted = new AbortController();
    aborted.abort(new Error("timeout after 1000ms"));
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { get: async () => { throw new Error("must not be asked"); } } } as never });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    db.prepare("INSERT INTO lane_pilot_run (id, project_id, state, created_at, updated_at) VALUES ('r1','p1','running',1,1)").run();
    await expect(closeAbandonedRuns(bb, db, Date.now(), aborted.signal)).rejects.toThrow("timeout after 1000ms");
    const silent = await sweepWriterSilence({
      bb: bb as never, getThread: async () => { throw new Error("must not be asked"); }, isDisposed: () => false, signal: aborted.signal, log: () => undefined,
      openAttempts: () => [{ id: "a1", run_id: "r1", task_id: "t1", thread_id: "th1", state: "running", project_id: "p1" }], silenceMinutes: () => 20,
    });
    expect(silent).toEqual([]);
    await expect(cleanupFinishedAttemptEnvironments(bb, db, async () => ({ status: "none", path: null }) as never, Date.now(), aborted.signal)).resolves.toEqual([]);
  });
});
