import type { NormalizedWhen } from "./model";
import { taskOf, whenOf, type RunRow, type ScheduleRow } from "./store";
import { fireTimes } from "./time";
import type { BoardColumn, RunView, ScheduleConflict, ScheduleView } from "./views";

export const runView = (row: RunRow): RunView => ({
  id: row.id, scheduleId: row.schedule_id, scheduledAt: row.scheduled_at, trigger: row.trigger, status: row.status, reason: row.reason,
  queuedAt: row.queued_at, startedAt: row.started_at, finishedAt: row.finished_at,
  durationMs: row.started_at !== null && row.finished_at !== null ? Math.max(0, row.finished_at - row.started_at) : null,
  refKind: row.ref_kind, refId: row.ref_id, hostId: row.host_id, exitCode: row.exit_code, output: row.output, error: row.error, truncated: row.truncated === 1,
});

/**
 * The column of the board a card stands in. Paused wins; then what is happening now (waiting for the owner, running); then how the
 * last run ended (failed stays until a run succeeds). A one-time task that ran well is done; a recurring one waits for its next time.
 */
export function boardColumn(row: ScheduleRow, active: readonly RunRow[], last: RunRow | undefined): BoardColumn {
  if (row.state === "paused") return "paused";
  if (active.some((run) => run.status === "waiting")) return "waiting";
  if (active.length) return "running";
  if (last && (last.status === "failed" || last.status === "timed_out")) return "failed";
  if (row.state === "done" && last?.status === "succeeded") return "done";
  return "scheduled";
}

/** The fire times of a definition in [from, until], capped. A one-time task has its one moment (if it has not run). */
export function fireList(when: NormalizedWhen, from: number, until: number, cap: number): number[] {
  if (when.type === "once") return when.runAt >= from && when.runAt <= until ? [when.runAt] : [];
  return fireTimes(when.cron, when.timezone, from - 1, { limit: cap, untilMs: until });
}

export function scheduleView(row: ScheduleRow, input: { nextFires: number[]; machine: string | null; last: RunRow | undefined; active: readonly RunRow[] }): ScheduleView {
  return {
    id: row.id, projectId: row.project_id, name: row.name, description: row.description, task: taskOf(row), when: whenOf(row),
    missed: row.missed_policy, missedLimit: row.missed_limit, overlap: row.overlap, timeoutSec: row.timeout_sec, maxFailures: row.max_failures,
    state: row.state, pauseReason: row.pause_reason, consecutiveFailures: row.consecutive_failures, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    nextFires: input.nextFires, machine: input.machine, lastRun: input.last ? runView(input.last) : null, active: input.active.map(runView),
    column: boardColumn(row, input.active, input.last),
  };
}

export const CONFLICT_WINDOW_MS = 10 * 60_000;
const CONFLICT_HORIZON_MS = 7 * 86_400_000;
const CONFLICT_CAP = 400;

/**
 * Two tasks that start within ten minutes of each other on one machine over the next week. `others` are the active schedules that
 * use the same machine. Pairs are counted by a sweep over the two sorted lists, so a minutely schedule does not cost a quadratic pass.
 */
export function findConflicts(candidate: { when: NormalizedWhen }, others: ReadonlyArray<{ id: string; name: string; machine: string; when: NormalizedWhen }>, from: number): ScheduleConflict[] {
  const mine = fireList(candidate.when, from, from + CONFLICT_HORIZON_MS, CONFLICT_CAP);
  if (!mine.length) return [];
  const out: ScheduleConflict[] = [];
  for (const other of others) {
    const theirs = fireList(other.when, from, from + CONFLICT_HORIZON_MS, CONFLICT_CAP);
    const samples: Array<{ at: number; otherAt: number }> = [];
    let pairs = 0, start = 0;
    for (const at of mine) {
      while (start < theirs.length && theirs[start]! < at - CONFLICT_WINDOW_MS) start += 1;
      for (let index = start; index < theirs.length && theirs[index]! <= at + CONFLICT_WINDOW_MS; index += 1) {
        pairs += 1;
        if (samples.length < 3) samples.push({ at, otherAt: theirs[index]! });
      }
    }
    if (pairs) out.push({ scheduleId: other.id, name: other.name, machine: other.machine, pairs, windowMinutes: CONFLICT_WINDOW_MS / 60_000, samples });
  }
  return out;
}
