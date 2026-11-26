import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ScheduleAgentApi } from "../../../contracts";
import { KEEP_RUNS, MAX_RUN_OUTPUT, taskOf, type NormalizedWhen, type RunRow, type RunStatus, type RunTrigger, type ScheduleDefinition, type ScheduleRow, type ScheduleState } from "../../models/schedule";

type Db = Database.Database;

export function createScheduleStore(db: Db, now: () => number = Date.now) {
  const get = (id: string): ScheduleRow | undefined => db.prepare("SELECT * FROM lane_pilot_schedule WHERE id=?").get(id) as ScheduleRow | undefined;
  const getRun = (id: string): RunRow | undefined => db.prepare("SELECT * FROM lane_pilot_schedule_run WHERE id=?").get(id) as RunRow | undefined;

  function insert(definition: ScheduleDefinition & { when: NormalizedWhen; timeoutSec: number }, meta: { createdBy: string; state: ScheduleState }): ScheduleRow {
    const at = now();
    const id = `sch_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const when = definition.when;
    db.prepare(`INSERT INTO lane_pilot_schedule(id,project_id,name,description,kind,task_json,trigger_type,cron,timezone,run_at,missed_policy,missed_limit,overlap,timeout_sec,max_failures,state,cursor_at,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, definition.projectId, definition.name, definition.description, definition.task.kind, JSON.stringify(definition.task), when.type,
        when.type === "cron" ? when.cron : null, when.type === "cron" ? when.timezone : null, when.type === "once" ? when.runAt : null,
        definition.missed, definition.missedLimit, definition.overlap, definition.timeoutSec, definition.maxFailures, meta.state,
        // A new schedule starts counting from now: what lies before its creation is no missed tick.
        at, meta.createdBy, at, at);
    return get(id)!;
  }

  /** Replaces the definition. A changed time resets the cursor to now (the new rhythm starts from the edit); a changed task or policy keeps it. */
  function update(id: string, definition: ScheduleDefinition & { when: NormalizedWhen; timeoutSec: number }): ScheduleRow | undefined {
    const current = get(id);
    if (!current) return undefined;
    const when = definition.when;
    const sameTime = current.trigger_type === when.type && (when.type === "cron" ? current.cron === when.cron && current.timezone === when.timezone : current.run_at === when.runAt);
    const at = now();
    db.prepare(`UPDATE lane_pilot_schedule SET name=?,description=?,kind=?,task_json=?,trigger_type=?,cron=?,timezone=?,run_at=?,missed_policy=?,missed_limit=?,overlap=?,timeout_sec=?,max_failures=?,
      cursor_at=?,state=CASE WHEN ?=1 AND state='done' THEN 'active' ELSE state END,updated_at=? WHERE id=?`)
      .run(definition.name, definition.description, definition.task.kind, JSON.stringify(definition.task), when.type,
        when.type === "cron" ? when.cron : null, when.type === "cron" ? when.timezone : null, when.type === "once" ? when.runAt : null,
        definition.missed, definition.missedLimit, definition.overlap, definition.timeoutSec, definition.maxFailures,
        sameTime ? current.cursor_at : at, sameTime ? 0 : 1, at, id);
    return get(id);
  }

  function setState(id: string, state: ScheduleState, reason: string | null = null): void {
    const at = now();
    // A resumed cron schedule counts from now: the time it stood paused is no missed tick, and the failures that paused it are forgiven.
    // A one-time task keeps its moment: if that passed while it was paused it runs late, as the missed policy says.
    if (state === "active") db.prepare("UPDATE lane_pilot_schedule SET state='active',pause_reason=NULL,consecutive_failures=0,cursor_at=CASE WHEN trigger_type='cron' THEN MAX(cursor_at,?) ELSE cursor_at END,updated_at=? WHERE id=?").run(at, at, id);
    else db.prepare("UPDATE lane_pilot_schedule SET state=?,pause_reason=?,updated_at=? WHERE id=?").run(state, reason, at, id);
  }

  const remove = (id: string): boolean => db.prepare("DELETE FROM lane_pilot_schedule WHERE id=?").run(id).changes > 0;

  function list(filter: { projectId?: string; states?: readonly ScheduleState[] } = {}): ScheduleRow[] {
    const where: string[] = [], args: unknown[] = [];
    if (filter.projectId) { where.push("project_id=?"); args.push(filter.projectId); }
    if (filter.states?.length) { where.push(`state IN (${filter.states.map(() => "?").join(",")})`); args.push(...filter.states); }
    return db.prepare(`SELECT * FROM lane_pilot_schedule${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`).all(...args) as ScheduleRow[];
  }

  /** Inserts a run unless its key exists; the row of the key either way, and whether this call made it. */
  function addRun(input: { scheduleId: string; runKey: string; scheduledAt: number; trigger: RunTrigger; status?: RunStatus; reason?: string }): { run: RunRow; created: boolean } {
    const at = now();
    const status = input.status ?? "queued";
    const result = db.prepare(`INSERT OR IGNORE INTO lane_pilot_schedule_run(id,schedule_id,run_key,scheduled_at,trigger,status,reason,queued_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`srun_${randomUUID().replaceAll("-", "").slice(0, 20)}`, input.scheduleId, input.runKey, input.scheduledAt, input.trigger, status, input.reason ?? null, at, status === "skipped" ? at : null);
    const run = db.prepare("SELECT * FROM lane_pilot_schedule_run WHERE run_key=?").get(input.runKey) as RunRow;
    return { run, created: result.changes > 0 };
  }

  /** queued -> running, atomically: of two instances that try, one wins. */
  function claim(runId: string, deadlineAt: number): boolean {
    return db.prepare("UPDATE lane_pilot_schedule_run SET status='running',started_at=?,deadline_at=? WHERE id=? AND status='queued'").run(now(), deadlineAt, runId).changes > 0;
  }

  function finish(runId: string, status: Extract<RunStatus, "succeeded" | "failed" | "timed_out" | "skipped" | "canceled">, detail: { reason?: string | undefined; exitCode?: number | null | undefined; output?: string | undefined; error?: string | undefined; truncated?: boolean | undefined } = {}): boolean {
    const output = detail.output === undefined ? null : detail.output.length > MAX_RUN_OUTPUT ? `${detail.output.slice(0, MAX_RUN_OUTPUT / 4)}\n[... ${detail.output.length - MAX_RUN_OUTPUT} characters cut ...]\n${detail.output.slice(-MAX_RUN_OUTPUT * 3 / 4)}` : detail.output;
    return db.prepare(`UPDATE lane_pilot_schedule_run SET status=?,reason=COALESCE(?,reason),exit_code=?,output=?,error=?,truncated=?,finished_at=? WHERE id=? AND status IN ('queued','running','waiting')`)
      .run(status, detail.reason ?? null, detail.exitCode ?? null, output, detail.error?.slice(0, 4000) ?? null, detail.truncated || (detail.output?.length ?? 0) > MAX_RUN_OUTPUT ? 1 : 0, now(), runId).changes > 0;
  }

  function runsOf(scheduleId: string, limit = 50, offset = 0): RunRow[] {
    return db.prepare("SELECT * FROM lane_pilot_schedule_run WHERE schedule_id=? ORDER BY scheduled_at DESC, queued_at DESC LIMIT ? OFFSET ?").all(scheduleId, limit, offset) as RunRow[];
  }

  /** The newest finished runs of a schedule (a skipped one did nothing), without the run being started. */
  function finishedRuns(scheduleId: string, exceptRunId: string, limit: number): RunRow[] {
    return db.prepare(`SELECT * FROM lane_pilot_schedule_run WHERE schedule_id=? AND id<>? AND status IN ('succeeded','failed','timed_out','canceled') ORDER BY scheduled_at DESC, queued_at DESC LIMIT ?`)
      .all(scheduleId, exceptRunId, limit) as RunRow[];
  }

  const unfinishedRuns = (scheduleId?: string): RunRow[] => db.prepare(`SELECT * FROM lane_pilot_schedule_run WHERE status IN ('queued','running','waiting')${scheduleId ? " AND schedule_id=?" : ""} ORDER BY scheduled_at, queued_at`)
    .all(...(scheduleId ? [scheduleId] : [])) as RunRow[];

  /** The newest run of each schedule in one query (the board's cards). */
  function lastRuns(scheduleIds: readonly string[]): Map<string, RunRow> {
    const out = new Map<string, RunRow>();
    for (const id of scheduleIds) {
      const row = db.prepare("SELECT * FROM lane_pilot_schedule_run WHERE schedule_id=? AND status<>'skipped' ORDER BY scheduled_at DESC, queued_at DESC LIMIT 1").get(id) as RunRow | undefined;
      if (row) out.set(id, row);
    }
    return out;
  }

  function prune(scheduleId: string): void {
    db.prepare(`DELETE FROM lane_pilot_schedule_run WHERE schedule_id=? AND status IN ('succeeded','failed','timed_out','skipped','canceled') AND id NOT IN
      (SELECT id FROM lane_pilot_schedule_run WHERE schedule_id=? ORDER BY scheduled_at DESC, queued_at DESC LIMIT ?)`).run(scheduleId, scheduleId, KEEP_RUNS);
  }

  function advanceCursor(scheduleId: string, newest: number, at: number): void {
    db.prepare("UPDATE lane_pilot_schedule SET cursor_at=MAX(cursor_at,?),state=CASE WHEN trigger_type='once' THEN 'done' ELSE state END,updated_at=? WHERE id=?").run(newest, at, scheduleId);
  }

  function nearestRunDeadline(): number | null {
    const row = db.prepare("SELECT MIN(deadline_at) AS at FROM lane_pilot_schedule_run WHERE status IN ('running','waiting') AND deadline_at IS NOT NULL").get() as { at: number | null } | undefined;
    return typeof row?.at === "number" ? row.at : null;
  }

  function resetConsecutiveFailures(scheduleId: string): void {
    db.prepare("UPDATE lane_pilot_schedule SET consecutive_failures=0 WHERE id=?").run(scheduleId);
  }

  function incrementConsecutiveFailures(scheduleId: string): void {
    db.prepare("UPDATE lane_pilot_schedule SET consecutive_failures=consecutive_failures+1 WHERE id=?").run(scheduleId);
  }

  function setRunRef(runId: string, refKind: string, refId: string, hostId: string | null): void {
    db.prepare("UPDATE lane_pilot_schedule_run SET ref_kind=?,ref_id=?,host_id=COALESCE(?,host_id) WHERE id=?").run(refKind, refId, hostId, runId);
  }

  function markRunWaiting(runId: string, deadlineAt: number): void {
    db.prepare("UPDATE lane_pilot_schedule_run SET status='waiting',deadline_at=? WHERE id=? AND status='running'").run(deadlineAt, runId);
  }

  function markRunRunning(runId: string, deadlineAt: number): void {
    db.prepare("UPDATE lane_pilot_schedule_run SET status='running',deadline_at=? WHERE id=? AND status='waiting'").run(deadlineAt, runId);
  }

  function activeRunsForWorkflow(wfRunId: string): RunRow[] {
    return db.prepare("SELECT * FROM lane_pilot_schedule_run WHERE ref_kind='workflow_run' AND ref_id=? AND status IN ('running','waiting')").all(wfRunId) as RunRow[];
  }

  function countRuns(scheduleId: string): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_schedule_run WHERE schedule_id=?").get(scheduleId) as { n: number }).n;
  }

  function runsInWindow(scheduleIds: readonly string[], from: number, to: number): RunRow[] {
    return db.prepare(`SELECT * FROM lane_pilot_schedule_run WHERE scheduled_at>=? AND scheduled_at<=? AND status<>'skipped' AND schedule_id IN (${scheduleIds.map(() => "?").join(",") || "''"}) ORDER BY scheduled_at LIMIT 2000`)
      .all(from, to, ...scheduleIds) as RunRow[];
  }

  function transaction<T>(fn: () => T): T {
    return db.transaction(fn)();
  }

  return {
    get, getRun, insert, update, setState, remove, list, addRun, claim, finish, runsOf, finishedRuns, unfinishedRuns, lastRuns, prune,
    advanceCursor, nearestRunDeadline, resetConsecutiveFailures, incrementConsecutiveFailures, setRunRef, markRunWaiting, markRunRunning, activeRunsForWorkflow,
    countRuns, runsInWindow, transaction,
  };
}
export type ScheduleStore = ReturnType<typeof createScheduleStore>;

/** The schedule board's active-agent read, typed in contracts so the native-agent registry needs no schedule import. */
export function scheduleAgentApi(): ScheduleAgentApi {
  return {
    activeAgentSchedules: (db) =>
      createScheduleStore(db as never)
        .list({ states: ["active"] })
        .filter((row) => row.kind === "agent")
        .map((row) => ({ id: row.id, name: row.name, task: taskOf(row) as { agentId?: string } })),
  };
}

/** The schedule's name by id (the errand list's schedule column). */
export function scheduleNameOf(db: Db, id: string): string | null {
  return (db.prepare("SELECT name FROM lane_pilot_schedule WHERE id=?").get(id) as { name: string } | undefined)?.name ?? null;
}

/** Finished run reference ids for a schedule and ref kind, newest first. */
export function finishedRefIds(db: Db, scheduleId: string, refKind: "thread" | "workflow_run"): string[] {
  const rows = db.prepare(`SELECT ref_id FROM lane_pilot_schedule_run
    WHERE schedule_id=? AND ref_kind=? AND status IN ('succeeded','failed','timed_out') ORDER BY scheduled_at DESC`).all(scheduleId, refKind) as Array<{ ref_id: string }>;
  return rows.map((row) => row.ref_id);
}

/** Looks up a failed run's schedule and whether a later run has ended, for owner-item janitor sweeps. */
export function failureRunState(db: Pick<Db, "prepare">, runId: string): { run: { schedule_id: string; finished_at: number | null } | undefined; schedule: { state: string } | undefined; hasLaterRun: boolean } {
  const run = db.prepare("SELECT schedule_id, finished_at FROM lane_pilot_schedule_run WHERE id=?").get(runId) as { schedule_id: string; finished_at: number | null } | undefined;
  const schedule = run ? db.prepare("SELECT state FROM lane_pilot_schedule WHERE id=?").get(run.schedule_id) as { state: string } | undefined : undefined;
  const hasLaterRun = Boolean(run && schedule && db.prepare("SELECT 1 FROM lane_pilot_schedule_run WHERE schedule_id=? AND finished_at>? LIMIT 1").get(run.schedule_id, run.finished_at ?? 0));
  return { run, schedule, hasLaterRun };
}
