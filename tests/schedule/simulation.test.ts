import { describe, expect, it } from "vitest";
import { createScheduleStore } from "../../src/schedule/store";
import { fireTimes } from "../../src/schedule/time";
import { addSchedule, createClock, createDb, createFakeExecutor, schedulerOn } from "./harness";
import type { Executor } from "../../src/schedule/scheduler";

/**
 * Fault simulation of the scheduler. A seeded random walk drives ticks against a database and a model of the hosts while the hub
 * is off for hours, an instance dies in the middle of starting a run (after the host job exists, before its id is written down),
 * and two instances tick at once. Then the faults stop, the clock runs on, and for every schedule:
 *  1. no lost tick: every fire time between its creation and its cursor has a run;
 *  2. no double tick: the key is unique, so each fire time has exactly one row;
 *  3. no stuck run: every row is finished;
 *  4. no double work: one host job per run key, however many times a start was repeated.
 * The zones are those whose clocks change during the walk (Madrid, Sydney).
 */
const SEEDS = Array.from({ length: Number(process.env.LP_SIM_SEEDS ?? 20) }, (_, index) => index + 1);
const MIN = 60_000;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORLDS = [
  { zone: "Europe/Madrid", start: "2026-10-24T20:00:00Z" },
  { zone: "Australia/Sydney", start: "2026-10-03T08:00:00Z" },
  { zone: "Europe/Madrid", start: "2026-03-28T20:00:00Z" },
];
const CRONS = ["*/20 * * * *", "30 2 * * *", "0 * * * *"];

describe("scheduler fault simulation", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, async () => {
      const rand = random(seed);
      const world = WORLDS[seed % WORLDS.length]!;
      const db = createDb();
      const clock = createClock(Date.parse(world.start));
      const base = createFakeExecutor(clock, { durationMs: 3 * MIN });
      let crashNext = false;
      // One executor per instance, so a crash kills one instance and not the other.
      const make = () => {
        const control = { dead: false, died: () => undefined as void };
        const executor: Executor = {
          ...base.executor,
          async start(input) {
            const ref = await base.executor.start(input);
            // The host job exists; the instance dies before it writes the job's id down.
            if (crashNext) { crashNext = false; control.dead = true; control.died(); return await new Promise(() => undefined); }
            return ref;
          },
        };
        return { scheduler: schedulerOn(db, clock, executor), control };
      };
      const store = createScheduleStore(db, clock.now);
      const schedules = CRONS.map((cron) => addSchedule(db, clock, { name: cron, when: { type: "cron", cron, timezone: world.zone }, missed: "run_all", missedLimit: 20, overlap: "parallel" }));
      let instance = make();

      const tickOnce = async (current: ReturnType<typeof make>) => {
        const dying = new Promise<void>((resolve) => { current.control.died = resolve; });
        await Promise.race([current.scheduler.tick({ budgetMs: 20_000 }), dying]);
        return current.control.dead;
      };

      for (let step = 0; step < 200; step += 1) {
        const roll = rand();
        if (roll < 0.04) clock.t += Math.floor(rand() * 5 * 60) * MIN;
        else clock.t += (1 + Math.floor(rand() * 20)) * MIN;
        if (rand() < 0.15) crashNext = true;
        if (rand() < 0.12) {
          const other = make();
          const [first] = await Promise.all([tickOnce(instance), tickOnce(other)]);
          if (first) instance = make();
        } else if (await tickOnce(instance)) instance = make();
        crashNext = false;
      }

      // The faults stop; the next ticks recover whatever the dead instances left.
      for (let settle = 0; settle < 30; settle += 1) { clock.t += 5 * MIN; await instance.scheduler.tick({ budgetMs: 20_000 }); }
      for (let guard = 0; store.unfinishedRuns().length && guard < 500; guard += 1) { clock.t += MIN; await instance.scheduler.supervise({ budgetMs: 20_000 }); }

      for (const schedule of schedules) {
        const row = store.get(schedule.id)!;
        const runs = store.runsOf(schedule.id, 5000);
        // The history keeps the newest 200 runs of a schedule; older rows are pruned by design.
        const expected = fireTimes(row.cron!, row.timezone!, schedule.created_at, { untilMs: row.cursor_at, limit: 5000 }).slice(-200);
        const got = runs.filter((run) => run.trigger !== "manual").map((run) => run.scheduled_at).sort((a, b) => a - b);
        expect(got, `${schedule.name}: one run per fire time`).toEqual(expected);
        expect(runs.filter((run) => run.status !== "succeeded").map((run) => `${run.run_key} ${run.status} ${run.reason ?? ""}`), `${schedule.name}: all finished well`).toEqual([]);
        for (const run of runs) expect(base.jobs.has(run.run_key), `job for ${run.run_key}`).toBe(true);
      }
      expect(base.jobs.size).toBeGreaterThanOrEqual(schedules.reduce((sum, schedule) => sum + store.runsOf(schedule.id, 5000).length, 0));
    }, 120_000);
  }
});