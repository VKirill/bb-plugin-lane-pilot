import type Database from "better-sqlite3";
import { WAITING_LIMIT_MS, type ScheduleKind, type ScheduleTask } from "./model";
import { ACTIVE_RUN_STATUSES, createScheduleStore, taskOf, whenOf, type RunRow, type ScheduleRow, type ScheduleStore } from "./store";
import { fireTimes } from "./time";
import { pollPause } from "@lane-pilot/kit";

/**
 * The scheduler of the schedule board. A tick (every minute, from an isolated schedule of the core) does two things:
 *
 * 1. **Materialise**: for every active schedule, the fire times between its cursor and now become rows of `lane_pilot_schedule_run`
 *    (key = schedule id + scheduled time, UNIQUE) and the cursor moves, in one transaction. A tick that runs twice, or two
 *    instances ticking during a reload, make the same rows; a crash between the insert and the cursor move repeats the insert,
 *    which is a no-op.
 * 2. **Supervise**: queued rows are started (overlap policy), running rows are polled until they end or the tick's time budget is
 *    spent. Nothing lives in memory between ticks: the next tick (or the next hub) reads the rows and goes on. Starting a run is
 *    idempotent on the run key (a workflow run key, a thread's spawn id, a host job key), so a start repeated after a crash is not a second run.
 */
export type PollResult =
  | { state: "running" }
  | { state: "waiting"; note?: string }
  | { state: "done"; status: "succeeded" | "failed"; output?: string; exitCode?: number | null; error?: string; truncated?: boolean; reason?: string };

export type ExecutorInput = { schedule: ScheduleRow; task: ScheduleTask; run: RunRow };
export type Executor = {
  /** Starts the work, or finds it again if this run key already started it. */
  start(input: ExecutorInput): Promise<{ refKind: string; refId: string; hostId?: string }>;
  poll(input: ExecutorInput): Promise<PollResult>;
  /** Stops what start began; best effort. */
  cancel(input: ExecutorInput): Promise<void>;
};

/** A fire time later than this behind now is a missed tick, not a slow one. */
export const ON_TIME_MS = 3 * 60_000;
const BACKLOG_CHUNK = 1000;
const BACKLOG_CHUNKS = 20;
/** Skipped ticks are shown as a few rows with a count, not one row each. */
const SKIPPED_ROWS = 3;
const QUEUE_DEPTH = 10;
/** A run whose work cannot be asked about is given up this long after its deadline. */
const SILENT_GRACE_MS = 10 * 60_000;
const POLL_FIRST_MS = 1_000;
const POLL_MAX_MS = 5_000;

export type SchedulerDeps = {
  db: Database.Database;
  executors: Record<ScheduleKind, Executor>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  isDisposed?: () => boolean;
  /** A schedule or a run changed: the board re-reads. */
  onChange?: (projectId: string, scheduleId: string) => void;
  /** A schedule paused itself after repeated failures, or a run ended in failure. */
  onFailure?: (event: { schedule: ScheduleRow; run: RunRow; paused: boolean }) => void;
  store?: ScheduleStore;
};

export type TickSummary = { created: number; skipped: number; started: number; finished: number };

export function createScheduler(deps: SchedulerDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((wake) => setTimeout(wake, pollPause(ms))));
  const log = deps.log ?? (() => undefined);
  const store = deps.store ?? createScheduleStore(deps.db, now);
  const { db } = deps;
  const changed = (schedule: ScheduleRow) => deps.onChange?.(schedule.project_id, schedule.id);

  /** The fire times in (after, until], oldest first; chunked so a long absence is counted, not cut at the oldest. */
  function dueTimes(schedule: ScheduleRow, until: number): number[] {
    const when = whenOf(schedule);
    if (when.type === "once") return schedule.cursor_at < when.runAt && when.runAt <= until ? [when.runAt] : [];
    const out: number[] = [];
    let after = schedule.cursor_at;
    for (let chunk = 0; chunk < BACKLOG_CHUNKS; chunk += 1) {
      const part = fireTimes(when.cron, when.timezone, after, { limit: BACKLOG_CHUNK, untilMs: until });
      out.push(...part);
      if (part.length < BACKLOG_CHUNK) break;
      after = part[part.length - 1]!;
    }
    return out;
  }

  /** One schedule's due fire times as rows. Pure in the database: running it again for the same state adds nothing. */
  function materialiseOne(schedule: ScheduleRow, at: number): { created: number; skipped: number } {
    const due = dueTimes(schedule, at);
    if (!due.length) return { created: 0, skipped: 0 };
    const fresh = due.filter((time) => at - time <= ON_TIME_MS);
    const late = due.filter((time) => at - time > ON_TIME_MS);
    const toRun: Array<{ time: number; trigger: "tick" | "catchup" }> = fresh.map((time) => ({ time, trigger: "tick" as const }));
    const toSkip: number[] = [];
    if (late.length) {
      if (schedule.missed_policy === "skip" || (schedule.missed_policy === "run_once" && fresh.length)) toSkip.push(...late);
      else if (schedule.missed_policy === "run_once") { toRun.push({ time: late[late.length - 1]!, trigger: "catchup" }); toSkip.push(...late.slice(0, -1)); }
      else {
        const keep = late.slice(-schedule.missed_limit);
        toRun.push(...keep.map((time) => ({ time, trigger: "catchup" as const })));
        toSkip.push(...late.slice(0, late.length - keep.length));
      }
    }
    let created = 0, skipped = 0;
    db.transaction(() => {
      for (const item of toRun) {
        if (store.addRun({ scheduleId: schedule.id, runKey: `${schedule.id}:${item.time}`, scheduledAt: item.time, trigger: item.trigger }).created) created += 1;
      }
      const noted = toSkip.slice(-SKIPPED_ROWS);
      for (const time of noted) {
        const reason = `missed: ${toSkip.length} tick(s) came while Lane Pilot was not running${schedule.missed_policy === "skip" ? " (policy: skip)" : ""}`;
        if (store.addRun({ scheduleId: schedule.id, runKey: `${schedule.id}:${time}`, scheduledAt: time, trigger: "tick", status: "skipped", reason }).created) skipped += 1;
      }
      const newest = due[due.length - 1]!;
      db.prepare("UPDATE lane_pilot_schedule SET cursor_at=MAX(cursor_at,?),state=CASE WHEN trigger_type='once' THEN 'done' ELSE state END,updated_at=? WHERE id=?").run(newest, at, schedule.id);
    })();
    return { created, skipped };
  }

  function materialise(): { created: number; skipped: number } {
    const at = now();
    let created = 0, skipped = 0;
    for (const schedule of store.list({ states: ["active"] })) {
      try {
        const result = materialiseOne(schedule, at);
        created += result.created; skipped += result.skipped;
        if (result.created || result.skipped) changed(schedule);
      } catch (cause) { log(`schedule ${schedule.id} (${schedule.name}) not materialised: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    return { created, skipped };
  }

  /** After a run ended: the failure count, the pause, the history cap. Only the call that ended the run counts it. */
  function settle(schedule: ScheduleRow, run: RunRow, status: string): void {
    const failed = status === "failed" || status === "timed_out";
    if (status === "succeeded") db.prepare("UPDATE lane_pilot_schedule SET consecutive_failures=0 WHERE id=?").run(schedule.id);
    let paused = false;
    if (failed) {
      db.prepare("UPDATE lane_pilot_schedule SET consecutive_failures=consecutive_failures+1 WHERE id=?").run(schedule.id);
      const after = store.get(schedule.id)!;
      if (after.max_failures > 0 && after.consecutive_failures >= after.max_failures && after.state === "active") {
        store.setState(schedule.id, "paused", `${after.consecutive_failures} runs in a row failed`);
        paused = true;
      }
    }
    store.prune(schedule.id);
    changed(schedule);
    if (failed) { try { deps.onFailure?.({ schedule: store.get(schedule.id) ?? schedule, run: store.getRun(run.id) ?? run, paused }); } catch (cause) { log(`schedule failure notice not sent: ${cause instanceof Error ? cause.message : String(cause)}`); } }
  }

  function end(run: RunRow, status: "succeeded" | "failed" | "timed_out" | "skipped" | "canceled", detail: Parameters<ScheduleStore["finish"]>[2] = {}): void {
    if (!store.finish(run.id, status, detail)) return;
    const schedule = store.get(run.schedule_id);
    if (schedule) settle(schedule, run, status);
  }

  const inputFor = (run: RunRow): ExecutorInput | null => {
    const schedule = store.get(run.schedule_id);
    return schedule ? { schedule, task: taskOf(schedule), run } : null;
  };

  async function startRun(run: RunRow): Promise<boolean> {
    const input = inputFor(run);
    if (!input) return false;
    try {
      const ref = await deps.executors[input.schedule.kind].start(input);
      db.prepare("UPDATE lane_pilot_schedule_run SET ref_kind=?,ref_id=?,host_id=COALESCE(?,host_id) WHERE id=?").run(ref.refKind, ref.refId, ref.hostId ?? null, run.id);
      changed(input.schedule);
      return true;
    } catch (cause) {
      end(run, "failed", { error: `could not start: ${cause instanceof Error ? cause.message : String(cause)}`, reason: "start_failed" });
      return false;
    }
  }

  /** Queued rows are started under the overlap policy of their schedule. */
  async function dispatch(): Promise<number> {
    let started = 0;
    const bySchedule = new Map<string, RunRow[]>();
    for (const run of store.unfinishedRuns()) if (run.status === "queued") bySchedule.set(run.schedule_id, [...(bySchedule.get(run.schedule_id) ?? []), run]);
    for (const [scheduleId, queued] of bySchedule) {
      const schedule = store.get(scheduleId);
      if (!schedule) continue;
      const running = () => store.unfinishedRuns(scheduleId).filter((run) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)).length;
      for (const [index, run] of queued.entries()) {
        if (deps.isDisposed?.()) return started;
        // A paused schedule starts nothing of its own; a run asked for by hand is allowed on a paused one.
        if (run.trigger !== "manual" && schedule.state === "paused") { end(run, "canceled", { reason: "schedule is paused" }); continue; }
        if (schedule.overlap !== "parallel" && running() > 0) {
          // A catching-up run is a missed tick the policy wants run: it waits its turn instead of being skipped.
          if (schedule.overlap === "skip" && run.trigger !== "catchup") end(run, "skipped", { reason: "overlap: the previous run is still running" });
          else if (index >= QUEUE_DEPTH && run.trigger !== "catchup") end(run, "skipped", { reason: `queue is full (${QUEUE_DEPTH})` });
          continue;
        }
        if (!store.claim(run.id, now() + schedule.timeout_sec * 1000)) continue;
        if (await startRun(store.getRun(run.id)!)) started += 1;
      }
    }
    return started;
  }

  /** One look at every running row: finished, timed out, or still going. Returns how many ended. */
  async function pollAll(): Promise<number> {
    let ended = 0;
    for (const run of store.unfinishedRuns().filter((row) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status))) {
      if (deps.isDisposed?.()) return ended;
      const input = inputFor(run);
      if (!input) continue;
      const executor = deps.executors[input.schedule.kind];
      try {
        // Claimed but never recorded a reference (the instance died between): start again, which finds the work by its key.
        if (!run.ref_id && !(await startRun(run))) { ended += 1; continue; }
        const fresh = store.getRun(run.id)!;
        const polled = await executor.poll({ ...input, run: fresh });
        // Late is not lost: work that finished while nobody was looking (the hub was off) is taken as it ended. Only work still going past its deadline is stopped.
        if (polled.state !== "done" && fresh.deadline_at !== null && now() > fresh.deadline_at) {
          await executor.cancel({ ...input, run: fresh }).catch(() => undefined);
          end(fresh, "timed_out", { error: fresh.status === "waiting" ? "nobody answered in time" : `did not finish within ${input.schedule.timeout_sec} s`, reason: "timeout" });
          ended += 1;
          continue;
        }
        if (polled.state === "done") {
          end(fresh, polled.status, { exitCode: polled.exitCode, output: polled.output, error: polled.error, truncated: polled.truncated, reason: polled.reason });
          ended += 1;
        } else if (polled.state === "waiting" && fresh.status !== "waiting") {
          db.prepare("UPDATE lane_pilot_schedule_run SET status='waiting',deadline_at=? WHERE id=? AND status='running'").run(now() + WAITING_LIMIT_MS, run.id);
          changed(input.schedule);
        } else if (polled.state === "running" && fresh.status === "waiting") {
          db.prepare("UPDATE lane_pilot_schedule_run SET status='running',deadline_at=? WHERE id=? AND status='waiting'").run(now() + input.schedule.timeout_sec * 1000, run.id);
          changed(input.schedule);
        }
      } catch (cause) {
        // A host that does not answer for a moment is not a failed run; one that stays silent well past the deadline ends it.
        const message = cause instanceof Error ? cause.message : String(cause);
        log(`schedule run ${run.id} not polled: ${message}`);
        if (run.deadline_at !== null && now() > run.deadline_at + SILENT_GRACE_MS) end(run, "timed_out", { error: `no answer after the deadline: ${message}`.slice(0, 500), reason: "unreachable" });
      }
    }
    return ended;
  }

  let flight: Promise<TickSummary> | null = null;
  let again = false;

  /** Starts what is queued and watches what runs, until nothing is left or the budget is spent. One at a time: a second call joins the first. */
  function supervise(options: { budgetMs: number; signal?: AbortSignal }): Promise<TickSummary> {
    if (flight) { again = true; return flight; }
    const loop = async (): Promise<TickSummary> => {
      const summary: TickSummary = { created: 0, skipped: 0, started: 0, finished: 0 };
      const stopAt = now() + options.budgetMs;
      let delay = POLL_FIRST_MS;
      for (;;) {
        again = false;
        // Finished runs are collected first: a run that has just ended must not hold the next one back as «still running».
        summary.finished += await pollAll();
        summary.started += await dispatch();
        const pending = store.unfinishedRuns();
        // A run waiting for the owner is polled by every tick but does not keep this loop alive.
        const busy = pending.some((run) => run.status === "running" || run.status === "queued");
        if ((!busy && !again) || options.signal?.aborted || deps.isDisposed?.() || now() >= stopAt) break;
        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.5), POLL_MAX_MS);
      }
      return summary;
    };
    flight = loop().finally(() => { flight = null; });
    return flight;
  }

  async function tick(options: { budgetMs?: number; signal?: AbortSignal } = {}): Promise<TickSummary> {
    const made = materialise();
    const summary = await supervise({ budgetMs: options.budgetMs ?? 50_000, ...(options.signal ? { signal: options.signal } : {}) });
    return { ...summary, created: made.created, skipped: made.skipped };
  }

  /** A run by hand. `key` makes a repeated request the same run. */
  function runNow(scheduleId: string, key: string = `${now()}-${Math.random().toString(36).slice(2, 8)}`): { run: RunRow; created: boolean } | undefined {
    const schedule = store.get(scheduleId);
    if (!schedule) return undefined;
    const added = store.addRun({ scheduleId, runKey: `${scheduleId}:manual:${key}`, scheduledAt: now(), trigger: "manual" });
    if (added.created) changed(schedule);
    return added;
  }

  /** Stops a run: a queued one is dropped, a running one is told to stop. */
  async function cancelRun(runId: string): Promise<boolean> {
    const run = store.getRun(runId);
    if (!run) return false;
    if (run.status === "queued") { end(run, "canceled", { reason: "canceled by the owner" }); return true; }
    if (run.status !== "running" && run.status !== "waiting") return false;
    const input = inputFor(run);
    if (input && run.ref_id) await deps.executors[input.schedule.kind].cancel(input).catch(() => undefined);
    end(run, "canceled", { reason: "canceled by the owner" });
    return true;
  }

  /** The next `count` fire times of a schedule from `from`. */
  function nextFires(schedule: ScheduleRow, count: number, from: number = now()): number[] {
    if (schedule.state !== "active") return [];
    const when = whenOf(schedule);
    if (when.type === "once") return schedule.cursor_at < when.runAt ? [when.runAt] : [];
    return fireTimes(when.cron, when.timezone, from, { limit: count });
  }

  return { store, materialise, dispatch, pollAll, supervise, tick, runNow, cancelRun, nextFires, kick: (budgetMs = 50_000) => { void supervise({ budgetMs }).catch((cause: unknown) => log(`schedule supervise: ${cause instanceof Error ? cause.message : String(cause)}`)); } };
}
export type Scheduler = ReturnType<typeof createScheduler>;
