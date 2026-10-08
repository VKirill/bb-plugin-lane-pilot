import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { MAX_RUN_OUTPUT, type NormalizedWhen, type RunStatus, type RunTrigger, type ScheduleDefinition, type ScheduleKind, type ScheduleState, type ScheduleTask } from "./model";

type Db = Database.Database;

/**
 * The schedule board's tables. Appended at the END of `migrations` in src/database.ts, as a spread, never into an earlier array
 * (tests/migration-lineage.test.ts pins the statements the hub already applied).
 *
 * `lane_pilot_schedule_run.run_key` is `<schedule id>:<scheduled time>` for a tick and `<schedule id>:manual:<nonce>` for a run
 * started by hand. It is UNIQUE: a tick materialised twice (a retried tick, two instances during a reload) is one row.
 */
export const scheduleMigrations: string[] = [
  `CREATE TABLE lane_pilot_schedule (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK(kind IN ('workflow','errand','script')),
    task_json TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('cron','once')),
    cron TEXT,
    timezone TEXT,
    run_at INTEGER,
    missed_policy TEXT NOT NULL DEFAULT 'run_once' CHECK(missed_policy IN ('run_once','skip','run_all')),
    missed_limit INTEGER NOT NULL DEFAULT 5,
    overlap TEXT NOT NULL DEFAULT 'skip' CHECK(overlap IN ('skip','queue','parallel')),
    timeout_sec INTEGER NOT NULL,
    max_failures INTEGER NOT NULL DEFAULT 3,
    state TEXT NOT NULL CHECK(state IN ('active','paused','done')),
    pause_reason TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    cursor_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_schedule_project ON lane_pilot_schedule(project_id, state)`,
  `CREATE TABLE lane_pilot_schedule_run (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES lane_pilot_schedule(id) ON DELETE CASCADE,
    run_key TEXT NOT NULL UNIQUE,
    scheduled_at INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('tick','catchup','manual')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','succeeded','failed','timed_out','skipped','canceled')),
    reason TEXT,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    deadline_at INTEGER,
    ref_kind TEXT,
    ref_id TEXT,
    host_id TEXT,
    exit_code INTEGER,
    output TEXT,
    error TEXT,
    truncated INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX lane_pilot_schedule_run_schedule ON lane_pilot_schedule_run(schedule_id, scheduled_at)`,
  `CREATE INDEX lane_pilot_schedule_run_status ON lane_pilot_schedule_run(status)`,
];

export type ScheduleRow = {
  id: string; project_id: string; name: string; description: string; kind: ScheduleKind; task_json: string;
  trigger_type: "cron" | "once"; cron: string | null; timezone: string | null; run_at: number | null;
  missed_policy: "run_once" | "skip" | "run_all"; missed_limit: number; overlap: "skip" | "queue" | "parallel"; timeout_sec: number; max_failures: number;
  state: ScheduleState; pause_reason: string | null; consecutive_failures: number; cursor_at: number; created_by: string; created_at: number; updated_at: number;
};

export type RunRow = {
  id: string; schedule_id: string; run_key: string; scheduled_at: number; trigger: RunTrigger; status: RunStatus; reason: string | null;
  queued_at: number; started_at: number | null; finished_at: number | null; deadline_at: number | null;
  ref_kind: string | null; ref_id: string | null; host_id: string | null; exit_code: number | null; output: string | null; error: string | null; truncated: number;
};

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["running", "waiting"];
export const FINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "timed_out", "skipped", "canceled"];
/** How many finished runs a schedule keeps. */
export const KEEP_RUNS = 200;

export const taskOf = (row: ScheduleRow): ScheduleTask => JSON.parse(row.task_json) as ScheduleTask;
export const whenOf = (row: ScheduleRow): NormalizedWhen => row.trigger_type === "cron"
  ? { type: "cron", cron: row.cron!, timezone: row.timezone! } : { type: "once", runAt: row.run_at! };

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

  return { get, getRun, insert, update, setState, remove, list, addRun, claim, finish, runsOf, unfinishedRuns, lastRuns, prune };
}
export type ScheduleStore = ReturnType<typeof createScheduleStore>;
