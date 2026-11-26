import { describe, expect, it, vi } from "vitest";
import { WorkflowEngine, workflowInboxMigrations, workflowMigrations, workflowNodeFormMigrations, workflowNotVerifiedMigrations, workflowOpsMigrations, workflowStepFactsMigrations } from "@lane-pilot/workflow-engine";
import type { ClockTimers } from "@lane-pilot/workflow-engine";
import { createBoardPause } from "../../src/rooms/schedule/server/repositories/board-pause-repository";
import { runScheduleCli } from "../../src/rooms/schedule/server/handlers/schedule-cli";
import { addSchedule, createClock, createDb, createFakeExecutor, schedulerOn } from "./harness";

const T0 = Date.parse("2026-10-08T10:03:00Z");

function kvStore() {
  const data = new Map<string, unknown>();
  return { data, kv: { get: async (key: string) => data.get(key) ?? null, set: async (key: string, value: unknown) => { data.set(key, value); } } };
}

/** The board, the engine clock and the pause on one database, as the plugin wires them. */
function setup() {
  const db = createDb();
  for (const statement of [...workflowMigrations, ...workflowOpsMigrations, ...workflowNotVerifiedMigrations, ...workflowInboxMigrations, ...workflowStepFactsMigrations, ...workflowNodeFormMigrations]) db.exec(statement as string);
  const clock = createClock(T0);
  const fake = createFakeExecutor(clock);
  const store = kvStore();
  const logs: string[] = [];
  const pause = createBoardPause(store.kv as never, { now: clock.now, log: (line) => logs.push(line), onChange: () => engine.clock?.arm() });
  const scheduler = schedulerOn(db, clock, fake.executor, { isPaused: pause.isPaused });
  const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", now: clock.now });
  const timers: ClockTimers = { set: (fn, ms) => ({ fn, ms }), clear: () => undefined };
  const engineClock = engine.startClock({ timers, board: { nextDueAt: scheduler.nextDueAt, fireDue: scheduler.fireDue }, isPaused: pause.isPaused });
  return { db, clock, fake, store, logs, pause, scheduler, engine, engineClock };
}

describe("board-wide pause", () => {
  it("a due board row starts its run through the engine clock", async () => {
    const { db, clock, fake, scheduler, engineClock } = setup();
    const schedule = addSchedule(db, clock);
    expect(scheduler.nextDueAt()).toBe(Date.parse("2026-10-08T10:10:00Z"));
    // The clock never sleeps past one beat; inside that window it sleeps to the row.
    clock.t = Date.parse("2026-10-08T10:09:30Z");
    engineClock.arm();
    expect(engineClock.armedAt()).toBe(Date.parse("2026-10-08T10:10:00Z"));

    clock.t = Date.parse("2026-10-08T10:10:01Z");
    await engineClock.tick();
    await vi.waitFor(() => expect(fake.calls.size).toBe(1));
    expect(scheduler.store.runsOf(schedule.id)).toHaveLength(1);
    expect(engineClock.armedAt()).toBe(Date.parse("2026-10-08T10:11:01Z"));
  });

  it("pause-all holds the board and the clock, survives a restart, and resume-all fires the missed row once", async () => {
    const { db, clock, fake, store, logs, pause, scheduler, engineClock } = setup();
    const schedule = addSchedule(db, clock);
    const cli = (args: string[]) => runScheduleCli({ schedules: { pause } } as never, args);

    expect((await cli(["pause-all", "deploy", "freeze"])).exitCode).toBe(0);
    expect(pause.state()).toMatchObject({ paused: true, reason: "deploy freeze" });
    expect(logs).toEqual(["board paused: deploy freeze"]);
    await cli(["pause-all", "deploy", "freeze"]);
    expect(logs).toHaveLength(1);

    clock.t = Date.parse("2026-10-08T10:10:01Z");
    expect(await engineClock.tick()).toBe(0);
    await scheduler.tick();
    expect(scheduler.store.runsOf(schedule.id)).toHaveLength(0);
    expect(fake.calls.size).toBe(0);

    // A new process reads the stored pause.
    const restarted = createBoardPause(store.kv as never, { now: clock.now });
    expect((await restarted.load()).paused).toBe(true);

    await cli(["resume-all"]);
    expect(logs).toEqual(["board paused: deploy freeze", "board resumed"]);
    await engineClock.tick();
    await vi.waitFor(() => expect(fake.calls.size).toBe(1));
    expect(scheduler.store.runsOf(schedule.id)).toHaveLength(1);
  });

  it("after an outage the board starts at most the cap of schedules per tick, oldest due first", () => {
    const { db, clock, scheduler } = setup();
    for (let index = 0; index < 5; index += 1) addSchedule(db, clock, { name: `s${index}`, when: { type: "cron", cron: `${index} 11 * * *`, timezone: "UTC" } });
    clock.t = Date.parse("2026-10-08T12:00:00Z");
    expect(scheduler.materialise(2).created).toBe(2);
    expect(scheduler.materialise(2).created).toBe(2);
    expect(scheduler.materialise(2).created).toBe(1);
    expect(scheduler.materialise(2).created).toBe(0);
  });
});
