import { expect, it } from "vitest";
import { addSchedule, createClock, createDb, createFakeExecutor, schedulerOn } from "./harness";
import { createScheduleExecutors } from "../../src/rooms/schedule/server/schedule-executors";

// The 2026-10-29 full-code audit (Аудит GPT), probes A-007, A-008 and A-009, kept as regressions.
it("stops the job of a run canceled while its start was awaited, once the job has a reference", async () => {
  const db = createDb(), clock = createClock(Date.parse("2026-10-01T00:00:00Z"));
  let release!: (value: unknown) => void, entered!: () => void, cancels = 0;
  const began = new Promise<void>((wake) => { entered = wake; }), started = new Promise((wake) => { release = wake; });
  const scheduler = schedulerOn(db, clock, { start: async () => { entered(); return await started; }, poll: async () => ({ state: "running" }), cancel: async () => { cancels++; } } as never);
  try {
    const schedule = addSchedule(db, clock);
    const run = scheduler.runNow(schedule.id)!.run;
    const dispatch = scheduler.dispatch();
    await began;
    expect(await scheduler.cancelRun(run.id)).toBe(true);
    release({ refKind: "host_job", refId: "job-fixture" });
    await dispatch;
    await scheduler.pollAll();
    expect(cancels).toBe(1);
    expect(scheduler.store.getRun(run.id)?.status).toBe("canceled");
  } finally { db.close(); }
});

it("ends a scheduled run whose workflow was interrupted", async () => {
  const executors = createScheduleExecutors({ bb: {}, db: {} } as never,
    { workflowEngine: { get: () => ({ status: "interrupted", reason: "step_interrupted:write:not_reentrant", error: null, failedNode: null }) } } as never);
  expect(await executors.workflow.poll({ run: { ref_id: "wf" } } as never)).toMatchObject({ state: "done", status: "failed" });
});

it("catches up once after an absence longer than the counted backlog (run_once)", () => {
  const db = createDb(), clock = createClock(Date.parse("2026-10-01T00:00:00Z"));
  const scheduler = schedulerOn(db, clock, createFakeExecutor(clock).executor);
  try {
    const schedule = addSchedule(db, clock, { when: { type: "cron", cron: "* * * * *", timezone: "UTC" }, missed: "run_once" });
    clock.t += 30 * 24 * 60 * 60_000;
    scheduler.materialise();
    expect(scheduler.materialise().created).toBe(0);
    expect(scheduler.store.runsOf(schedule.id, 50).filter((row) => row.status === "queued")).toHaveLength(1);
  } finally { db.close(); }
}, 30_000);
