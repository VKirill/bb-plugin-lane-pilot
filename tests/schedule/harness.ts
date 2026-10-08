import Database from "better-sqlite3";
import { normalizeSchedule, type ScheduleInput, type ScheduleKind } from "../../src/rooms/schedule/model";
import { createScheduler, type Executor, type ExecutorInput, type PollResult, type Scheduler } from "../../src/rooms/schedule/scheduler";
import { createScheduleStore, scheduleMigrations, type RunRow } from "../../src/rooms/schedule/store";

/** A fake clock the scheduler's sleeps advance, so a minute of supervising costs no time. */
export function createClock(start: number) {
  const clock = { t: start, now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } };
  return clock;
}

export function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const statement of scheduleMigrations) db.exec(statement);
  return db;
}

export type FakeJob = { ref: string; startedAt: number; finishAt: number; ok: boolean; cancelled: boolean };

/**
 * An executor that behaves like the real three: starting is idempotent on the run key (a second start finds the same job), a job
 * ends after `durationMs` of the fake clock, and `failKeys` end badly. `calls` counts how often start was called per key.
 */
export function createFakeExecutor(clock: { now(): number }, options: { durationMs?: number; failKeys?: Set<string> } = {}) {
  const jobs = new Map<string, FakeJob>();
  const calls = new Map<string, number>();
  const executor: Executor = {
    async start({ run }: ExecutorInput) {
      calls.set(run.run_key, (calls.get(run.run_key) ?? 0) + 1);
      if (!jobs.has(run.run_key)) jobs.set(run.run_key, { ref: `job-${jobs.size + 1}`, startedAt: clock.now(), finishAt: clock.now() + (options.durationMs ?? 5_000), ok: !options.failKeys?.has(run.run_key), cancelled: false });
      return { refKind: "job", refId: jobs.get(run.run_key)!.ref, hostId: "h1" };
    },
    async poll({ run }: ExecutorInput): Promise<PollResult> {
      const job = jobs.get(run.run_key);
      if (!job) return { state: "done", status: "failed", error: "job lost" };
      if (job.cancelled) return { state: "done", status: "failed", error: "cancelled" };
      if (clock.now() < job.finishAt) return { state: "running" };
      return job.ok ? { state: "done", status: "succeeded", output: `ok ${run.run_key}`, exitCode: 0 } : { state: "done", status: "failed", output: "boom", exitCode: 1, error: "exit 1" };
    },
    async cancel({ run }: ExecutorInput) { const job = jobs.get(run.run_key); if (job) job.cancelled = true; },
  };
  return { executor, jobs, calls };
}

export function bag(executor: Executor): Record<ScheduleKind, Executor> { return { workflow: executor, errand: executor, script: executor }; }

export function schedulerOn(db: Database.Database, clock: { now(): number; sleep(ms: number): Promise<void> }, executor: Executor, extra: Partial<Parameters<typeof createScheduler>[0]> = {}): Scheduler {
  return createScheduler({ db, executors: bag(executor), now: clock.now, sleep: clock.sleep, ...extra });
}

export const scriptTask = { kind: "script" as const, hostId: "h1", command: "echo hi", cwd: "/tmp", env: [] as string[] };

export function addSchedule(db: Database.Database, clock: { now(): number }, overrides: Partial<ScheduleInput> = {}, state: "active" | "paused" = "active") {
  const normalized = normalizeSchedule({ projectId: "p1", name: "Test", timeoutSec: 10_000, task: scriptTask, when: { type: "cron", cron: "*/10 * * * *", timezone: "UTC" }, ...overrides }, clock.now());
  if (!normalized.ok) throw new Error(normalized.problems.join("; "));
  return createScheduleStore(db, clock.now).insert(normalized.value, { createdBy: "test", state });
}

export const statuses = (rows: RunRow[]) => rows.map((row) => row.status);
