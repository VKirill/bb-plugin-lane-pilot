import { taskFamily, taskRedispatchBase } from "@lane-pilot/contracts";
import { FREE_CLASSES, failureClass, isOwnerDecision, isPreStartStop, isWaitingSecret, isWriterSilent } from "../../contracts";
import { HARNESS_VERSION, type LanePilotDatabase } from "../database";
import { attemptChanged, transitionAttempt } from "./transition";

export function createAttempt(db: LanePilotDatabase, ids: { id:string; runId:string; taskId:string }): void {
  const now = Date.now();
  const used = countAttempts(db, ids.runId, ids.taskId);
  db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,created_at,updated_at,harness_version) VALUES (?,?,?,?,?,?,?,?)")
    .run(ids.id, ids.runId, ids.taskId, "queued", used + 1, now, now, HARNESS_VERSION);
  attemptChanged(db, ids.id);
}

/**
 * A canceled attempt whose writer never started goes back to queued: the PM sent the same task again (a replan), and that task keeps its attempt
 * instead of adding another row. Refused for an attempt that had a writer thread or a workspace.
 */
export function reviveCanceledAttempt(db: LanePilotDatabase, attemptId: string, reason: string): boolean {
  const row = db.prepare("SELECT state,thread_id,workspace_path FROM lane_pilot_attempt WHERE id=?").get(attemptId) as
    { state:string; thread_id:string|null; workspace_path:string|null } | undefined;
  if (!row || row.state !== "canceled" || row.thread_id !== null || row.workspace_path !== null) return false;
  return transitionAttempt(db, attemptId, "queued", { reason });
}

/** The Lane Pilot build the task's latest attempt was created by; null when it predates the column or the task has none. */
export function latestAttemptHarnessVersion(db: LanePilotDatabase, runId: string, taskId: string): string | null {
  const row = db.prepare("SELECT harness_version FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC, attempt_no DESC LIMIT 1")
    .get(runId, taskId) as { harness_version: string | null } | undefined;
  return row?.harness_version ?? null;
}

/** Bind a task attempt to one immutable writer workspace exactly once. */
export function setAttemptWorkspace(db:LanePilotDatabase, attemptId:string, binding:{path:string;environmentId:string|null;decision:unknown}):boolean {
  if (!binding.path.startsWith("/")) throw new Error("attempt workspace path must be absolute");
  if (binding.environmentId !== null && !binding.environmentId.trim()) throw new Error("attempt environment id must be non-empty or null");
  const decisionJson=JSON.stringify(binding.decision);
  const changed=db.prepare(`UPDATE lane_pilot_attempt SET workspace_path=?,environment_id=?,workspace_decision_json=?,updated_at=?
    WHERE id=? AND state IN ('queued','spawn_requested') AND workspace_path IS NULL AND environment_id IS NULL AND workspace_decision_json IS NULL`)
    .run(binding.path,binding.environmentId,decisionJson,Date.now(),attemptId).changes;
  return changed===1;
}

/** The BB environment of an attempt that started on Lane Pilot's own provider, known once its thread exists. */
export function setAttemptEnvironment(db:LanePilotDatabase, attemptId:string, environmentId:string):boolean {
  if (!environmentId.trim()) throw new Error("attempt environment id must be non-empty");
  return db.prepare("UPDATE lane_pilot_attempt SET environment_id=?,updated_at=? WHERE id=? AND environment_id IS NULL AND workspace_path IS NOT NULL")
    .run(environmentId,Date.now(),attemptId).changes===1;
}

export function setAttemptHolderThread(db:LanePilotDatabase, attemptId:string, holderThreadId:string):boolean {
  if (!holderThreadId.trim()) throw new Error("holder thread id must be non-empty");
  const changed=db.prepare(`UPDATE lane_pilot_attempt SET holder_thread_id=?,updated_at=?
    WHERE id=? AND holder_thread_id IS NULL AND thread_id IS NULL AND workspace_path IS NULL
    AND state IN ('queued','spawn_requested')`)
    .run(holderThreadId,Date.now(),attemptId).changes;
  return changed===1;
}

export function countAttempts(db: LanePilotDatabase, runId: string, taskId: string): number {
  const row = db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE run_id=? AND task_id=?").get(runId, taskId) as
    {count:number};
  return row.count;
}

/**
 * Attempts that count against the task's limit: a merge conflict, Lane Pilot's own fault, the machine's or a
 * silent writer's does not spend one (an attempt still running counts, its outcome is not known yet).
 */
export function countChargedAttempts(db: LanePilotDatabase, runId: string, taskId: string): number {
  const rows = db.prepare("SELECT state, reason, thread_id FROM lane_pilot_attempt WHERE run_id=? AND task_id=?").all(runId, taskId) as
    Array<{ state:string; reason:string|null; thread_id:string|null }>;
  // One writer session is one attempt: the feedback turns sent into the same thread are not charged again.
  return new Set(rows.filter((row) => !(row.reason && (FREE_CLASSES.has(failureClass(row.state, row.reason)) || isWriterSilent(row.reason) || isWaitingSecret(row.reason) || isPreStartStop(row.reason) || isOwnerDecision(row.reason))))
    .map((row, index) => row.thread_id ?? `#${index}`)).size;
}

/** Turns one writer thread took for this task: its first answer and every feedback turn after it. */
export function countThreadTurns(db: LanePilotDatabase, runId: string, taskId: string, threadId: string): number {
  return (db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND thread_id=?").get(runId, taskId, threadId) as {count:number}).count;
}

export function listAttemptsForTask(db: LanePilotDatabase, runId: string, taskId: string): Array<{
  id:string; state:string; attempt_no:number; thread_id:string|null;
}> {
  return db.prepare("SELECT id,state,attempt_no,thread_id FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY attempt_no")
    .all(runId, taskId) as Array<{id:string; state:string; attempt_no:number; thread_id:string|null}>;
}

/**
 * The state of each piece of work in a run: one per task family («T3», «T3.2», «T3.4» are one task sent again), the
 * latest-sent member's latest attempt. Counting every row ended magicseo's run (2026-10-30) «blocked» with all nine
 * families accepted: the replaced T1.3, T3.2, T5.2… stayed blocked or canceled for good.
 */
export function listTaskTerminalStates(db: LanePilotDatabase, runId: string): string[] {
  const latest = new Map<string, string>();
  for (const row of db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=? ORDER BY created_at, rowid").all(runId) as Array<{id:string}>) latest.set(taskFamily(row.id), row.id);
  const tasks = [...latest.values()].map((id) => ({ id }));
  return tasks.map((task) => {
    const latest = db.prepare("SELECT state FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY attempt_no DESC LIMIT 1")
      .get(runId, task.id) as {state:string}|undefined;
    return latest?.state ?? "queued";
  });
}

/** The latest attempt of a task id in a project (any run): what a dependent task waits on. */
/**
 * The state of a task's latest attempt. A task the PM sent again is «<id>.2», «<id>.3»: naming «<id>» means its
 * latest redispatch, so a dependent written against the plan's ids does not block on a name no attempt carries
 * (live 2026-10-03: P3 depends_on P1, P1 was blocked by the plan check and sent again as P1.2).
 */
export function latestTaskAttemptState(db: LanePilotDatabase, projectId: string, taskId: string): string | null {
  return latestTaskAttempt(db, projectId, taskId)?.state ?? null;
}

/** How long a task waits for a depends_on that ended blocked to be sent again (`<id>.2`) before it gives up. */
export const ATTEMPT_TABLE = "lane_pilot_attempt";

export const DEPENDENCY_REDO_WAIT_MS = 6 * 3_600_000;

/** The latest attempt of a task or of its redispatches, with when it got its state. */
export function latestTaskAttempt(db: LanePilotDatabase, projectId: string, taskId: string): { state:string; updated_at:number; reason:string|null } | null {
  // Naming «P1.2» also follows its later redispatches («P1.3», «P1.2.2»): the base is the id without its numeric suffixes.
  const base = taskRedispatchBase(taskId);
  const rows = db.prepare(`SELECT a.task_id, a.state, a.updated_at, a.reason FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? AND (a.task_id=? OR a.task_id LIKE ? ESCAPE '\\')
    ORDER BY a.created_at DESC, a.attempt_no DESC`).all(projectId, taskId, `${base.replace(/[\\%_]/g, "\\$&")}.%`) as Array<{ task_id:string; state:string; updated_at:number; reason:string|null }>;
  const member = (id:string) => id === taskId || (id.startsWith(`${base}.`) && /^(\.\d+)+$/.test(id.slice(base.length)));
  const row = rows.find((candidate) => member(candidate.task_id));
  return row ? { state:row.state, updated_at:row.updated_at, reason:row.reason } : null;
}

/**
 * latestTaskAttempt inside one run: a depends_on name resolves among the tasks of the dependent's own run (owner's rule, ТЗ 4д.1),
 * so an accepted «T1» of an older run of the project no longer satisfies a new plan's «T1» (lp.plan ids are almost always T1…T8).
 */
export function latestRunTaskAttempt(db: LanePilotDatabase, runId: string, taskId: string): { state:string; updated_at:number; reason:string|null } | null {
  const base = taskRedispatchBase(taskId);
  const rows = db.prepare(`SELECT task_id, state, updated_at, reason FROM lane_pilot_attempt
    WHERE run_id=? AND (task_id=? OR task_id LIKE ? ESCAPE '\\')
    ORDER BY created_at DESC, attempt_no DESC`).all(runId, taskId, `${base.replace(/[\\%_]/g, "\\$&")}.%`) as Array<{ task_id:string; state:string; updated_at:number; reason:string|null }>;
  const member = (id:string) => id === taskId || (id.startsWith(`${base}.`) && /^(\.\d+)+$/.test(id.slice(base.length)));
  const row = rows.find((candidate) => member(candidate.task_id));
  return row ? { state:row.state, updated_at:row.updated_at, reason:row.reason } : null;
}

/** The state of a task's latest attempt (or of its redispatches) inside one run. */
export const latestRunTaskAttemptState = (db: LanePilotDatabase, runId: string, taskId: string): string | null => latestRunTaskAttempt(db, runId, taskId)?.state ?? null;
