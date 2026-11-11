import { taskFamily } from "@lane-pilot/contracts";
import { OPEN_ATTEMPT_STATES } from "../../contracts";
import type { LanePilotDatabase } from "../database";
import { listStageReceipts } from "../stages-store";

/** A task result the PM has not been told: the latest attempt of a task of a PM's run ended accepted, blocked or canceled. A closed run tells no one: its PM chat has handed the lead back or the run is over. */
export type TaskOutcome = { transitionId:number; attemptId:string; projectId:string; pmThreadId:string; taskId:string; state:string; reason:string|null; failureCode?:string|null; at:number };

/**
 * Task results not yet told to their PM, ended at `since` or later. Only the latest attempt of a task counts (an attempt
 * followed by a retry is not a result), only while it still holds that state (a blocked task the PM answered runs again),
 * and not a task the PM sent again as «<id>.N».
 */
export function listUnreportedTaskOutcomes(db: LanePilotDatabase, since: number): TaskOutcome[] {
  const rows = db.prepare(`SELECT t.rowid AS transitionId, a.id AS attemptId, r.project_id AS projectId, r.pm_thread_id AS pmThreadId,
      a.task_id AS taskId, a.state, a.reason, a.failure_code AS failureCode, t.at, a.created_at AS createdAt
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    JOIN lane_pilot_attempt_transition t ON t.rowid=(SELECT t2.rowid FROM lane_pilot_attempt_transition t2
      WHERE t2.attempt_id=a.id AND t2.refused=0 AND t2.to_state=a.state ORDER BY t2.at DESC, t2.rowid DESC LIMIT 1)
    WHERE a.state IN ('accepted','blocked','canceled') AND r.pm_thread_id IS NOT NULL AND r.closed_at IS NULL AND a.updated_at>=? AND t.at>=?
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_task k WHERE k.run_id=a.run_id AND k.id=a.task_id AND k.birth='lead')
      AND a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt c JOIN lane_pilot_run rc ON rc.id=c.run_id
        WHERE rc.project_id=r.project_id AND c.created_at>=a.created_at AND substr(c.task_id,1,length(a.task_id)+1)=a.task_id || '.')
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_pm_notice n WHERE n.transition_id=t.rowid)
    ORDER BY t.at`).all(since, since) as Array<TaskOutcome & { createdAt:number }>;
  // A task the PM already sent again is no news: `x.3` blocked while `x.4` runs, or `x.3` canceled by the PM for `x.4`. The check above
  // finds only `x.3.1`; the PM numbers redos `x.4`, so the Vampirism Fire PM was woken for three versions it had replaced (2026-10-23).
  const later = db.prepare(`SELECT c.task_id AS taskId FROM lane_pilot_attempt c JOIN lane_pilot_run rc ON rc.id=c.run_id
    WHERE rc.project_id=? AND c.created_at>? AND c.task_id<>? AND c.task_id LIKE ? ESCAPE '\\'`);
  return rows.filter((row) => {
    const family = taskFamily(row.taskId);
    const like = `${family.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return !(later.all(row.projectId, row.createdAt, row.taskId, like) as Array<{ taskId:string }>).some((other) => taskFamily(other.taskId) === family);
  }).map(({ createdAt: _createdAt, ...row }) => row);
}

/**
 * Outcomes a PM already has: Lane Pilot told it in a message of their own (a writer's question, a task not started for its baseline),
 * its own lane_pilot_wait_writer returned them, or it canceled the task itself. The batched results skip them, so the PM is not woken
 * for a fact it already acted on (Vampirism Fire vf-s1-xp.3, 20:18 and again 20:19, 2026-10-23). The mark is the time the PM had the
 * news; it covers every transition up to then (and 15 minutes before a transition, for a notice sent just ahead of it). In memory:
 * after a reload a told outcome may be repeated once, never lost.
 */
const toldDirectly = new WeakMap<LanePilotDatabase, Map<string, number>>();
function toldMap(db: LanePilotDatabase): Map<string, number> {
  let map = toldDirectly.get(db);
  if (!map) { map = new Map(); toldDirectly.set(db, map); }
  return map;
}
export function noteToldPmDirectly(db: LanePilotDatabase, pmThreadId: string, taskId: string, at = Date.now()): void {
  const map = toldMap(db);
  for (const [key, when] of map) if (at - when > 3_600_000) map.delete(key);
  map.set(`${pmThreadId}\u0000${taskId}`, at);
}
export function toldPmDirectly(db: LanePilotDatabase, pmThreadId: string, taskId: string, at: number, windowMs = 15 * 60_000): boolean {
  const when = toldMap(db).get(`${pmThreadId}\u0000${taskId}`);
  return when !== undefined && when >= at - windowMs;
}

/** Whether any task of the PM's runs is still at work (queued, being spawned, running or being canceled). */
export function pmHasTasksAtWork(db: LanePilotDatabase, pmThreadId: string): string[] {
  return (db.prepare(`SELECT DISTINCT a.task_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.pm_thread_id=? AND a.state IN (${OPEN_ATTEMPT_STATES.map(() => "?").join(",")}) ORDER BY a.created_at`)
    .all(pmThreadId, ...OPEN_ATTEMPT_STATES) as Array<{ task_id:string }>).map((row) => row.task_id);
}

/**
 * The tasks of this PM still at work that are parked on a reason, written the way writer/server/start.ts writes
 * them: the `writer-agent` stage receipt in `pending` with a reason (quarantine, a held writer provider, a paused
 * run, a hold-until). The digest lists them as `task (waits: reason → wayOut)` instead of a bare id.
 */
export function pmTasksWaiting(db: LanePilotDatabase, pmThreadId: string): Array<{ taskId: string; reason: string }> {
  return db.prepare(`SELECT DISTINCT s.task_id AS taskId, s.reason FROM lane_pilot_stage_receipt s
    JOIN lane_pilot_attempt a ON a.run_id=s.run_id AND a.task_id=s.task_id
    JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.pm_thread_id=? AND s.stage_id='writer-agent' AND s.state='pending' AND s.reason IS NOT NULL AND s.reason != ''
      AND a.state IN (${OPEN_ATTEMPT_STATES.map(() => "?").join(",")})
    ORDER BY s.task_id`).all(pmThreadId, ...OPEN_ATTEMPT_STATES) as Array<{ taskId: string; reason: string }>;
}

/**
 * Lane Pilot's own commit after an accepted task is still on its way to main: the project-life stage of one of these accepted attempts
 * is pending or running, or has not started within `startMs` of the acceptance. A PM told its results now would push before it.
 */
export function pmBookkeepingPending(db: LanePilotDatabase, rows: ReadonlyArray<Pick<TaskOutcome, "attemptId" | "taskId" | "state" | "at">>, now: number, startMs = 90_000): boolean {
  const stage = db.prepare(`SELECT s.state FROM lane_pilot_stage_receipt s JOIN lane_pilot_attempt a ON a.run_id=s.run_id AND a.task_id=s.task_id
    WHERE a.id=? AND s.stage_id='project-life'`);
  return rows.some((row) => {
    if (row.state !== "accepted") return false;
    const receipt = stage.get(row.attemptId) as { state:string } | undefined;
    return receipt ? receipt.state === "pending" || receipt.state === "running" : now - row.at < startMs;
  });
}

export function markTaskOutcomesReported(db: LanePilotDatabase, rows: Array<Pick<TaskOutcome, "transitionId" | "attemptId" | "pmThreadId">>, at: number): void {
  const insert = db.prepare("INSERT OR IGNORE INTO lane_pilot_pm_notice(transition_id,attempt_id,pm_thread_id,sent_at) VALUES(?,?,?,?)");
  db.transaction(() => { for (const row of rows) insert.run(row.transitionId, row.attemptId, row.pmThreadId, at); })();
}
