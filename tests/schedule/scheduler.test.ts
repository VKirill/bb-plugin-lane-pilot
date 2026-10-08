import { describe, expect, it } from "vitest";
import { createScheduler } from "../../src/schedule/scheduler";
import { createScheduleStore } from "../../src/schedule/store";
import { addSchedule, bag, createClock, createDb, createFakeExecutor, schedulerOn, statuses } from "./harness";

const T0 = Date.parse("2026-10-08T10:03:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function setup(options: Parameters<typeof createFakeExecutor>[1] = {}) {
  const db = createDb();
  const clock = createClock(T0);
  const fake = createFakeExecutor(clock, options);
  const scheduler = schedulerOn(db, clock, fake.executor);
  const store = createScheduleStore(db, clock.now);
  return { db, clock, fake, scheduler, store };
}

describe("ticks are idempotent", () => {
  it("one fire time is one run, however often the tick sees it", async () => {
    const { db, clock, scheduler, store } = setup();
    const schedule = addSchedule(db, clock);
    clock.t = Date.parse("2026-10-08T10:10:20Z");
    expect(scheduler.materialise().created).toBe(1);
    expect(scheduler.materialise().created).toBe(0);
    await scheduler.tick();
    await scheduler.tick();
    const runs = store.runsOf(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_key: `${schedule.id}:${Date.parse("2026-10-08T10:10:00Z")}`, status: "succeeded", trigger: "tick", exit_code: 0 });
  });

  it("a crash between the insert and the cursor move repeats the insert, which changes nothing", async () => {
    const { db, clock, scheduler, store } = setup();
    const schedule = addSchedule(db, clock);
    clock.t = Date.parse("2026-10-08T10:10:20Z");
    // The row exists, the cursor did not move (the instance died between the two writes).
    store.addRun({ scheduleId: schedule.id, runKey: `${schedule.id}:${Date.parse("2026-10-08T10:10:00Z")}`, scheduledAt: Date.parse("2026-10-08T10:10:00Z"), trigger: "tick" });
    await scheduler.tick();
    expect(store.runsOf(schedule.id)).toHaveLength(1);
    expect(store.get(schedule.id)!.cursor_at).toBe(Date.parse("2026-10-08T10:10:00Z"));
  });

  it("two instances on one database make one run and start it once", async () => {
    const { db, clock, store } = setup();
    const schedule = addSchedule(db, clock);
    const fake = createFakeExecutor(clock);
    const a = schedulerOn(db, clock, fake.executor), b = schedulerOn(db, clock, fake.executor);
    clock.t = Date.parse("2026-10-08T10:10:20Z");
    await Promise.all([a.tick(), b.tick()]);
    expect(store.runsOf(schedule.id)).toHaveLength(1);
    expect(fake.jobs.size).toBe(1);
    expect([...fake.calls.values()]).toEqual([1]);
  });
});

describe("missed ticks", () => {
  const away = (policy: "run_once" | "skip" | "run_all", limit = 5) => {
    const env = setup();
    const schedule = addSchedule(env.db, env.clock, { when: { type: "cron", cron: "0 * * * *", timezone: "UTC" }, missed: policy, missedLimit: limit });
    // The hub was off from 10:03 to 14:30: ticks at 11, 12, 13, 14 came and went.
    env.clock.t = Date.parse("2026-10-08T14:30:00Z");
    return { ...env, schedule };
  };

  it("run_once: one catching-up run for the newest missed tick, the rest noted as skipped", async () => {
    const { scheduler, store, schedule } = away("run_once");
    await scheduler.tick();
    const runs = store.runsOf(schedule.id);
    expect(runs.filter((run) => run.status === "succeeded").map((run) => [run.trigger, new Date(run.scheduled_at).toISOString()])).toEqual([["catchup", "2026-10-08T14:00:00.000Z"]]);
    expect(runs.filter((run) => run.status === "skipped")).toHaveLength(3);
    expect(runs.find((run) => run.status === "skipped")!.reason).toMatch(/3 tick\(s\) came while Lane Pilot was not running/);
  });

  it("skip: nothing runs", async () => {
    const { scheduler, store, schedule } = away("skip");
    await scheduler.tick();
    expect(statuses(store.runsOf(schedule.id)).every((status) => status === "skipped")).toBe(true);
    expect(store.get(schedule.id)!.cursor_at).toBe(Date.parse("2026-10-08T14:00:00Z"));
    await scheduler.tick();
    expect(store.runsOf(schedule.id)).toHaveLength(3);
  });

  it("run_all: each missed tick runs, up to the limit", async () => {
    const { scheduler, store, schedule } = away("run_all", 3);
    await scheduler.tick();
    const ran = store.runsOf(schedule.id).filter((run) => run.status === "succeeded").map((run) => new Date(run.scheduled_at).toISOString().slice(11, 16)).sort();
    expect(ran).toEqual(["12:00", "13:00", "14:00"]);
  });

  it("a fresh tick covers the missed ones: one run, the old ticks are skipped", async () => {
    const { scheduler, store, schedule, clock } = away("run_once");
    clock.t = Date.parse("2026-10-08T14:00:30Z");
    await scheduler.tick();
    const ran = store.runsOf(schedule.id).filter((run) => run.status === "succeeded");
    expect(ran).toHaveLength(1);
    expect(ran[0]!.trigger).toBe("tick");
  });

  it("a paused schedule does not count its pause as missed ticks", async () => {
    const { db, clock, scheduler, store } = setup();
    const schedule = addSchedule(db, clock, { when: { type: "cron", cron: "0 * * * *", timezone: "UTC" } });
    store.setState(schedule.id, "paused", "by the owner");
    clock.t = Date.parse("2026-10-08T14:30:00Z");
    await scheduler.tick();
    expect(store.runsOf(schedule.id)).toHaveLength(0);
    store.setState(schedule.id, "active");
    await scheduler.tick();
    expect(store.runsOf(schedule.id)).toHaveLength(0);
    clock.t = Date.parse("2026-10-08T15:00:20Z");
    await scheduler.tick();
    expect(statuses(store.runsOf(schedule.id))).toEqual(["succeeded"]);
  });
});

describe("one-time tasks", () => {
  it("runs once at its moment and is done", async () => {
    const { db, clock, scheduler, store } = setup();
    const schedule = addSchedule(db, clock, { when: { type: "once", delay: "30m" } });
    expect(store.get(schedule.id)!.run_at).toBe(T0 + 30 * MIN);
    await scheduler.tick();
    expect(store.runsOf(schedule.id)).toHaveLength(0);
    clock.t = T0 + 30 * MIN + 10_000;
    await scheduler.tick();
    await scheduler.tick();
    expect(statuses(store.runsOf(schedule.id))).toEqual(["succeeded"]);
    expect(store.get(schedule.id)!.state).toBe("done");
  });

  it("a one-time task whose moment passed while the hub was off runs once as a catch-up", async () => {
    const { db, clock, scheduler, store } = setup();
    const schedule = addSchedule(db, clock, { when: { type: "once", delay: "30m" } });
    clock.t = T0 + 5 * HOUR;
    await scheduler.tick();
    expect(store.runsOf(schedule.id).map((run) => [run.trigger, run.status])).toEqual([["catchup", "succeeded"]]);
  });
});

describe("overlap", () => {
  const slow = { durationMs: 25 * MIN };
  const ticks = async (env: ReturnType<typeof setup>, times: string[]) => {
    for (const time of times) { env.clock.t = Date.parse(time); await env.scheduler.tick({ budgetMs: 1000 }); }
  };

  it("skip: a tick that finds the last run still running is skipped", async () => {
    const env = setup(slow);
    const schedule = addSchedule(env.db, env.clock, { overlap: "skip" });
    await ticks(env, ["2026-10-08T10:10:10Z", "2026-10-08T10:20:10Z", "2026-10-08T10:30:10Z", "2026-10-08T10:40:10Z"]);
    expect(env.store.runsOf(schedule.id).reverse().map((run) => [new Date(run.scheduled_at).toISOString().slice(11, 16), run.status, run.reason?.slice(0, 7) ?? null]))
      .toEqual([["10:10", "succeeded", null], ["10:20", "skipped", "overlap"], ["10:30", "skipped", "overlap"], ["10:40", "running", null]]);
  });

  it("queue: the next run waits for the first and then starts", async () => {
    const env = setup({ durationMs: 12 * MIN });
    const schedule = addSchedule(env.db, env.clock, { overlap: "queue" });
    await ticks(env, ["2026-10-08T10:10:10Z", "2026-10-08T10:20:10Z", "2026-10-08T10:30:10Z"]);
    const runs = env.store.runsOf(schedule.id).reverse();
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "running", "queued"]);
    expect(runs[1]!.started_at!).toBeGreaterThanOrEqual(runs[0]!.finished_at!);
  });

  it("parallel: runs start beside each other", async () => {
    const env = setup(slow);
    const schedule = addSchedule(env.db, env.clock, { overlap: "parallel" });
    await ticks(env, ["2026-10-08T10:10:10Z", "2026-10-08T10:20:10Z"]);
    expect(env.store.runsOf(schedule.id).map((run) => run.status)).toEqual(["running", "running"]);
  });
});

describe("failures, timeouts, pause", () => {
  it("pauses after N failures in a row, tells the owner, and a resume forgives them", async () => {
    const db = createDb();
    const clock = createClock(T0);
    const failKeys = new Set<string>();
    const fake = createFakeExecutor(clock, { failKeys });
    const events: Array<{ paused: boolean }> = [];
    const scheduler = createScheduler({ db, executors: bag(fake.executor), now: clock.now, sleep: clock.sleep, onFailure: (event) => events.push({ paused: event.paused }) });
    const schedule = addSchedule(db, clock, { maxFailures: 2 });
    for (const time of ["10:10", "10:20", "10:30"]) {
      clock.t = Date.parse(`2026-10-08T${time}:05Z`);
      failKeys.add(`${schedule.id}:${Date.parse(`2026-10-08T${time}:00Z`)}`);
      await scheduler.tick();
    }
    const store = createScheduleStore(db, clock.now);
    const row = store.get(schedule.id)!;
    expect(row).toMatchObject({ state: "paused", consecutive_failures: 2 });
    expect(row.pause_reason).toMatch(/2 runs in a row failed/);
    expect(events).toEqual([{ paused: false }, { paused: true }]);
    expect(store.runsOf(schedule.id).filter((run) => run.status === "failed")).toHaveLength(2);
    store.setState(schedule.id, "active");
    expect(store.get(schedule.id)).toMatchObject({ state: "active", consecutive_failures: 0, pause_reason: null });
  });

  it("a run that outlives its timeout is stopped and counted as failed", async () => {
    const env = setup({ durationMs: 3 * HOUR });
    const schedule = addSchedule(env.db, env.clock, { timeoutSec: 600 });
    env.clock.t = Date.parse("2026-10-08T10:10:10Z");
    await env.scheduler.tick({ budgetMs: 1000 });
    env.clock.t += 11 * MIN;
    await env.scheduler.tick({ budgetMs: 1000 });
    const run = env.store.runsOf(schedule.id).at(-1);
    expect(run).toMatchObject({ status: "timed_out", reason: "timeout" });
    expect([...env.fake.jobs.values()][0]!.cancelled).toBe(true);
    expect(env.store.get(schedule.id)!.consecutive_failures).toBe(1);
  });

  it("work that finished while the hub was off is taken as it ended, not timed out", async () => {
    const env = setup({ durationMs: 5 * MIN });
    const schedule = addSchedule(env.db, env.clock, { timeoutSec: 600 });
    env.clock.t = Date.parse("2026-10-08T10:10:10Z");
    await env.scheduler.tick({ budgetMs: 1000 });
    expect(env.store.runsOf(schedule.id)[0]!.status).toBe("running");
    // The hub is down for three hours; the job finished long ago.
    env.clock.t += 3 * HOUR;
    await env.scheduler.supervise({ budgetMs: 1000 });
    expect(env.store.runsOf(schedule.id).at(-1)).toMatchObject({ status: "succeeded", exit_code: 0 });
  });

  it("a host that stays silent past the deadline ends the run as unreachable", async () => {
    const env = setup({ durationMs: HOUR });
    const schedule = addSchedule(env.db, env.clock, { timeoutSec: 600 });
    env.clock.t = Date.parse("2026-10-08T10:10:10Z");
    await env.scheduler.tick({ budgetMs: 1000 });
    env.fake.executor.poll = async () => { throw new Error("host h1 is not connected"); };
    env.clock.t += 5 * MIN;
    await env.scheduler.supervise({ budgetMs: 1000 });
    expect(env.store.runsOf(schedule.id).at(-1)!.status).toBe("running");
    env.clock.t += 30 * MIN;
    await env.scheduler.supervise({ budgetMs: 1000 });
    expect(env.store.runsOf(schedule.id).at(-1)).toMatchObject({ status: "timed_out", reason: "unreachable" });
  });

  it("a start that throws fails the run with the reason", async () => {
    const env = setup();
    const schedule = addSchedule(env.db, env.clock);
    env.fake.executor.start = async () => { throw new Error("host h1 is offline"); };
    env.clock.t = Date.parse("2026-10-08T10:10:10Z");
    await env.scheduler.tick();
    expect(env.store.runsOf(schedule.id)[0]).toMatchObject({ status: "failed", reason: "start_failed" });
    expect(env.store.runsOf(schedule.id)[0]!.error).toMatch(/host h1 is offline/);
  });
});

describe("runs by hand", () => {
  it("run now makes one run per key, also on a paused schedule", async () => {
    const env = setup();
    const schedule = addSchedule(env.db, env.clock);
    env.store.setState(schedule.id, "paused", "by the owner");
    const first = env.scheduler.runNow(schedule.id, "k1")!;
    const again = env.scheduler.runNow(schedule.id, "k1")!;
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    await env.scheduler.tick();
    expect(statuses(env.store.runsOf(schedule.id))).toEqual(["succeeded"]);
  });

  it("cancel drops a queued run and stops a running one", async () => {
    const env = setup({ durationMs: HOUR });
    const schedule = addSchedule(env.db, env.clock);
    const { run } = env.scheduler.runNow(schedule.id, "x")!;
    await env.scheduler.dispatch();
    expect(env.store.getRun(run.id)!.status).toBe("running");
    expect(await env.scheduler.cancelRun(run.id)).toBe(true);
    expect(env.store.getRun(run.id)!.status).toBe("canceled");
    expect([...env.fake.jobs.values()][0]!.cancelled).toBe(true);
    expect(env.store.get(schedule.id)!.consecutive_failures).toBe(0);
  });

  it("keeps the newest 200 runs", () => {
    const env = setup();
    const schedule = addSchedule(env.db, env.clock);
    for (let index = 0; index < 230; index += 1) {
      const { run } = env.store.addRun({ scheduleId: schedule.id, runKey: `${schedule.id}:${index}`, scheduledAt: index, trigger: "tick" });
      env.store.finish(run.id, "succeeded");
    }
    env.store.prune(schedule.id);
    expect(env.store.runsOf(schedule.id, 500)).toHaveLength(200);
  });
});
