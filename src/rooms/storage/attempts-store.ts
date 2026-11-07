import { parseDirtSnapshots, type DirtSnapshot } from "../dirt-snapshot";
import { taskFamily, taskRedispatchBase } from "@lane-pilot/contracts";
import { FREE_CLASSES, failureClass, isOwnerDecision, isPreStartStop, isWaitingSecret, isWriterSilent, type FailureCode } from "../platform";
import { IllegalTransitionError, isLegalMove, OPEN_ATTEMPT_STATES, RETRY_ELIGIBLE } from "../state-machine";
import { HARNESS_VERSION, type LanePilotDatabase } from "./database";

/**
 * Parks a queued attempt until `wakeAt` while every writer provider is held (H2): the attempt stays `queued`, the
 * wait is journaled as a queued→queued note (an operational move), and the board reads its reason + wake_at.
 */
export function parkAttemptWake(db: LanePilotDatabase, attemptId: string, reason: string, wakeAt: number | null): void {
  transitionAttempt(db, attemptId, "queued", { reason });
  db.prepare("UPDATE lane_pilot_attempt SET wake_at=? WHERE id=?").run(wakeAt, attemptId);
}

/** Consecutive `queued` parks of an attempt whose journal reason starts with `reasonPrefix`, counted back until a different row. */
export function trailingQueuedParks(db: LanePilotDatabase, attemptId: string, reasonPrefix: string): number {
  const rows = db.prepare("SELECT to_state, reason FROM lane_pilot_attempt_transition WHERE attempt_id=? AND refused=0 ORDER BY at DESC, rowid DESC LIMIT 100")
    .all(attemptId) as Array<{ to_state: string; reason: string | null }>;
  let count = 0;
  for (const row of rows) {
    if (row.to_state !== "queued" || !(row.reason ?? "").startsWith(reasonPrefix)) break;
    count += 1;
  }
  return count;
}

/** Journals that a pre-spawn store read succeeded after parks, so a later `store_read:` streak counts only what followed it. */
export function noteCleanAdmission(db: LanePilotDatabase, attemptId: string): void {
  const state = (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { state: string } | undefined)?.state ?? "queued";
  db.prepare(`INSERT INTO lane_pilot_attempt_transition(attempt_id,from_state,to_state,reason,refused,at) VALUES(?,?,?,?,0,?)`)
    .run(attemptId, state, state, "admission: store reads clean", Date.now());
}

/** How many times the attempt's journal blocked it under a reason prefix — the next such block's sequence number. */
export function blockedReasonCount(db: LanePilotDatabase, attemptId: string, reasonPrefix: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt_transition WHERE attempt_id=? AND to_state='blocked' AND refused=0 AND substr(reason,1,?)=?")
    .get(attemptId, reasonPrefix.length, reasonPrefix) as { n: number }).n;
}

/** Queued attempts whose writer hold ended (or should be re-checked): the minute waker picks them up. */
export function listDueWakes(db: LanePilotDatabase, now: number): Array<{ id: string; run_id: string; task_id: string; reason: string | null }> {
  return db.prepare("SELECT id,run_id,task_id,reason FROM lane_pilot_attempt WHERE state='queued' AND wake_at IS NOT NULL AND wake_at<=? ORDER BY wake_at")
    .all(now) as Array<{ id: string; run_id: string; task_id: string; reason: string | null }>;
}

/** Takes the wake of a queued attempt: clears wake_at once, so two ticks cannot spawn the same attempt twice. */
export function claimAttemptWake(db: LanePilotDatabase, attemptId: string): boolean {
  return db.prepare("UPDATE lane_pilot_attempt SET wake_at=NULL WHERE id=? AND state='queued' AND wake_at IS NOT NULL").run(attemptId).changes === 1;
}

/** The wait is over once the attempt leaves `queued`; a spawn that begins clears any wake still set. */
export function clearAttemptWake(db: LanePilotDatabase, attemptId: string): void {
  db.prepare("UPDATE lane_pilot_attempt SET wake_at=NULL WHERE id=?").run(attemptId);
}

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
export const DEPENDENCY_REDO_WAIT_MS = 6 * 3_600_000;

/** The latest attempt of a task or of its redispatches, with when it got its state. */
export function latestTaskAttempt(db: LanePilotDatabase, projectId: string, taskId: string): { state:string; updated_at:number } | null {
  // Naming «P1.2» also follows its later redispatches («P1.3», «P1.2.2»): the base is the id without its numeric suffixes.
  const base = taskRedispatchBase(taskId);
  const rows = db.prepare(`SELECT a.task_id, a.state, a.updated_at FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? AND (a.task_id=? OR a.task_id LIKE ? ESCAPE '\\')
    ORDER BY a.created_at DESC, a.attempt_no DESC`).all(projectId, taskId, `${base.replace(/[\\%_]/g, "\\$&")}.%`) as Array<{ task_id:string; state:string; updated_at:number }>;
  const member = (id:string) => id === taskId || (id.startsWith(`${base}.`) && /^(\.\d+)+$/.test(id.slice(base.length)));
  const row = rows.find((candidate) => member(candidate.task_id));
  return row ? { state:row.state, updated_at:row.updated_at } : null;
}

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

export function listOpenAttempts(db: LanePilotDatabase): Array<{
  id:string; run_id:string; task_id:string; thread_id:string|null; state:string; project_id:string;
}> {
  // A retry-eligible attempt with a saved reconcile page is still in flight: its scan died mid-page and the next
  // process continues it, so it is listed with the live states (fault-injection: a spawn rejected while its scan
  // was interrupted would otherwise sit open forever).
  const open = OPEN_ATTEMPT_STATES.map(() => "?").join(",");
  const retry = RETRY_ELIGIBLE.map(() => "?").join(",");
  return db.prepare(`SELECT a.id,a.run_id,a.task_id,a.thread_id,a.state,r.project_id
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state IN (${open})
       OR (a.state IN (${retry})
           AND EXISTS (SELECT 1 FROM lane_pilot_reconcile_cursor c WHERE c.attempt_id=a.id))
    ORDER BY a.created_at`).all(...OPEN_ATTEMPT_STATES, ...RETRY_ELIGIBLE) as Array<{
    id:string; run_id:string; task_id:string; thread_id:string|null; state:string; project_id:string;
  }>;
}

/**
 * Tasks whose latest attempt ended with the writer's question (`needs_human:`) and nobody has answered it yet. The writer's
 * edits are still in the files where the folder has no git, so such a task still holds its folder.
 */
export function listUnansweredWriterQuestions(db: LanePilotDatabase): Array<{
  id:string; run_id:string; task_id:string; thread_id:string|null; project_id:string; reason:string|null; updated_at:number;
}> {
  return db.prepare(`SELECT a.id,a.run_id,a.task_id,a.thread_id,a.reason,a.updated_at,r.project_id
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state='blocked' AND a.reason LIKE 'needs_human:%' AND r.closed_at IS NULL
      AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
    ORDER BY a.created_at`).all() as Array<{ id:string; run_id:string; task_id:string; thread_id:string|null; project_id:string; reason:string|null; updated_at:number }>;
}

/** States an attempt never leaves: its work is merged, or the owner stopped it. */
const FINAL_ATTEMPT_STATES = ["accepted", "canceled"] as const;

const illegalTransitionLogs = new WeakMap<LanePilotDatabase, (message:string) => void>();
/** Where a refused move of this database is reported (the plugin log); until set, the console. */
export function setIllegalTransitionLog(db: LanePilotDatabase, log:(message:string) => void):void { illegalTransitionLogs.set(db, log); }

const attemptListeners = new WeakMap<LanePilotDatabase, Set<(attemptId:string, toState?:string, reason?:string) => void>>();
/** Called after an attempt of this database is created or changes state (live screens re-read); returns the function that stops it. A listener's failure never touches the write. `toState`/`reason` are the move's target and note; absent on creation. */
export function onAttemptChanged(db: LanePilotDatabase, listener:(attemptId:string, toState?:string, reason?:string) => void):() => void {
  let listeners = attemptListeners.get(db);
  if (!listeners) { listeners = new Set(); attemptListeners.set(db, listeners); }
  listeners.add(listener);
  return () => { listeners!.delete(listener); };
}
function attemptChanged(db:LanePilotDatabase, attemptId:string, toState?:string, reason?:string):void {
  for (const listener of attemptListeners.get(db) ?? []) { try { listener(attemptId, toState, reason); } catch { /* a screen update is never worth a failed write */ } }
}

/** The structured facts of a verification failure; the human reason text keeps its wording. */
export type AttemptFailureFields = { failureCode?: FailureCode; checkName?: string; timeoutSec?: number };

/** The structured failure facts of a validateWriterResult-like record, for a caller that passes them to `transitionAttempt`. */
export function failureFieldsOf(row: { failureCode?: unknown; checkName?: unknown; timeoutSec?: unknown }): AttemptFailureFields {
  const failureCode = typeof row.failureCode === "string" ? row.failureCode as FailureCode : undefined;
  const checkName = typeof row.checkName === "string" ? row.checkName : undefined;
  const timeoutSec = typeof row.timeoutSec === "number" ? row.timeoutSec : undefined;
  return {
    ...(failureCode ? { failureCode } : {}),
    ...(checkName ? { checkName } : {}),
    ...(timeoutSec !== undefined ? { timeoutSec } : {}),
  };
}

/**
 * Moves an attempt to a new state and journals it. An accepted or canceled attempt keeps its state: before,
 * a cancel during verification could be overwritten with «accepted» after the merge (fleet invariants audit,
 * 2026-10-03). Returns false when the move was refused that way. The one declared way out of a settled state is
 * `canceled -> queued` (the PM's replan reusing the attempt, reviveCanceledAttempt).
 *
 * Every other move must be a row of the state machine's table (src/state-machine.ts) or one of its documented operational
 * moves. An illegal one is logged, journaled as refused and thrown as `IllegalTransitionError`: a caller that did it is
 * wrong, and the writer loop's catch ends the attempt as `internal_error` (a Lane Pilot fault, parked and restarted).
 *
 * The structured failure facts come from the caller (the producer that knows them); the migration backfilled the rows
 * written before the fields existed. A caller that does not pass them writes NULL.
 */
export function transitionAttempt(
  db: LanePilotDatabase,
  attemptId: string,
  state: string,
  fields: { threadId?: string; reason?: string } & AttemptFailureFields = {},
): boolean {
  const now = Date.now();
  const before = db.prepare("SELECT state FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { state: string } | undefined;
  if (!before) return false;
  const settled = (FINAL_ATTEMPT_STATES as readonly string[]).includes(before.state);
  if (!settled && before.state !== state && !isLegalMove(before.state, state)) {
    db.prepare(`INSERT INTO lane_pilot_attempt_transition(attempt_id,from_state,to_state,reason,refused,at) VALUES(?,?,?,?,1,?)`)
      .run(attemptId, before.state, state, `illegal move: ${fields.reason ?? ""}`.trim(), now);
    const error = new IllegalTransitionError(attemptId, before.state, state);
    (illegalTransitionLogs.get(db) ?? ((message: string) => console.warn(message)))(`Lane Pilot refused ${error.message}${fields.reason ? `: ${fields.reason.slice(0, 200)}` : ""}`);
    throw error;
  }
  // A settled attempt keeps its state unless the move is a declared way out (canceled -> queued, the PM's replan).
  const reopen = settled && before.state !== state && isLegalMove(before.state, state) ? 1 : 0;
  const changed = db.prepare(`UPDATE lane_pilot_attempt SET state=?, thread_id=COALESCE(?,thread_id), reason=?, failure_code=?, check_name=?, timeout_sec=?, updated_at=?,
    wake_at=CASE WHEN ?<>'queued' THEN NULL ELSE wake_at END
    WHERE id=? AND (state NOT IN (${FINAL_ATTEMPT_STATES.map(() => "?").join(",")}) OR state=? OR ?)`)
    .run(state, fields.threadId ?? null, fields.reason ?? null, fields.failureCode ?? null,
      fields.checkName ?? null, fields.timeoutSec ?? null,
      now, state, attemptId, ...FINAL_ATTEMPT_STATES, state, reopen).changes === 1;
  db.prepare(`INSERT INTO lane_pilot_attempt_transition(attempt_id,from_state,to_state,reason,refused,at) VALUES(?,?,?,?,?,?)`)
    .run(attemptId, before.state, state, fields.reason ?? null, changed ? 0 : 1, now);
  if (changed && before.state !== state) attemptChanged(db, attemptId, state, fields.reason);
  return changed;
}

/**
 * Ends an attempt whose writer could not be started (or found again). The PM's stop can land while the spawn is still
 * being made: `cancel_requested` has only canceled, blocked and accepted to go to, and the owner asked for the stop,
 * so that attempt ends «canceled» whatever failed; any other attempt is «spawn_rejected» and retries.
 */
export function endSpawnFailure(db: LanePilotDatabase, attemptId: string, reason: string, threadId?: string): "canceled" | "spawn_rejected" {
  const stopped = (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { state: string } | undefined)?.state === "cancel_requested";
  const state = stopped ? "canceled" : "spawn_rejected";
  transitionAttempt(db, attemptId, state, { reason: stopped ? `writer stop observed after: ${reason}`.slice(0, 500) : reason, ...(threadId ? { threadId } : {}) });
  return state;
}

/**
 * An attempt whose work ran before it was recorded (a native CLI run: the command has finished when the attempt is
 * written): journals the steps it went through, then its outcome. A blocked outcome needs no steps.
 */
export function recordFinishedAttempt(db: LanePilotDatabase, attemptId: string, status: "accepted" | "blocked" | "running", reason?: string): void {
  if (status !== "blocked") {
    transitionAttempt(db, attemptId, "spawn_requested");
    transitionAttempt(db, attemptId, "running");
  }
  if (status !== "running") transitionAttempt(db, attemptId, status, { reason });
}

/**
 * One page of a project's state for `bb lane-pilot state`: the newest runs first, their attempts in short rows. The whole history with
 * every column was 147 MB for one project (the dirt snapshots alone 126 MB) against the CLI bridge's 1 MB (audit 2026-10-28); the
 * heavy columns of one attempt come from `state <project> --attempt <id>` (inspectAttempt).
 */
export const STATE_REASON_CHARS = 300;
export function inspectState(db: LanePilotDatabase, projectId: string, page: { limit?: number; before?: number; beforeId?: string } = {}): Record<string,unknown> {
  const limit = Math.max(1, Math.min(page.limit ?? 10, 100));
  const runs = db.prepare(`SELECT id,state,kind,pm_thread_id,created_at,updated_at,closed_at,closed_by,writer_host_id,writer_workspace_path,run_gate,objective
    FROM lane_pilot_run WHERE project_id=? AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(projectId, page.before ?? Number.MAX_SAFE_INTEGER, page.before ?? Number.MAX_SAFE_INTEGER, page.beforeId ?? "", limit + 1) as Array<{ id: string; created_at: number }>;
  const more = runs.length > limit;
  const shown = runs.slice(0, limit);
  const ids = shown.map((run) => run.id);
  const attempts = ids.length ? db.prepare(`SELECT id,run_id,task_id,attempt_no,state,
      CASE WHEN length(reason) > ${STATE_REASON_CHARS} THEN substr(reason,1,${STATE_REASON_CHARS}) || '…' ELSE reason END AS reason,
      thread_id,holder_thread_id,created_at,updated_at
    FROM lane_pilot_attempt WHERE run_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`).all(...ids) : [];
  const settings = db.prepare(`SELECT project_id,binding_id,key,version,updated_at
    FROM lane_pilot_project_settings WHERE project_id=? ORDER BY binding_id,key`).all(projectId);
  const totals = db.prepare(`SELECT (SELECT count(*) FROM lane_pilot_run WHERE project_id=?) AS runs,
    (SELECT count(*) FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.project_id=?) AS attempts`).get(projectId, projectId);
  return { projectId, totals, settings, runs: shown, attempts,
    ...(more ? { next: `bb lane-pilot state ${projectId} --before ${shown[shown.length - 1]!.created_at}:${encodeURIComponent(shown[shown.length - 1]!.id)}${page.limit ? ` --limit ${limit}` : ""}` } : {}),
    detail: `bb lane-pilot state ${projectId} --attempt <attempt-id>` };
}

/** One attempt: at most 200 dirt entries and one page of its failure reason, with a command to read the rest. */
export const STATE_REASON_PAGE_CHARS = 16_384;
export function inspectAttempt(db: LanePilotDatabase, projectId: string, attemptId: string, reasonOffset = 0): Record<string,unknown> | null {
  const row = db.prepare(`SELECT a.* FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.project_id=? AND a.id=?`).get(projectId, attemptId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const { dirt_before_json, workspace_decision_json, ...rest } = row;
  const dirt = parseDirtSnapshots(typeof dirt_before_json === "string" ? dirt_before_json : "[]");
  let workspace_decision: unknown = null;
  if (typeof workspace_decision_json === "string") { try { workspace_decision = JSON.parse(workspace_decision_json); } catch { workspace_decision = { invalidStoredDecision: true }; } }
  const reason = typeof rest.reason === "string" ? rest.reason : null;
  const end = reasonOffset + STATE_REASON_PAGE_CHARS;
  return { ...rest, reason: reason?.slice(reasonOffset, end) ?? null,
    reason_offset: reasonOffset, reason_chars: reason?.length ?? 0, reason_truncated: reason !== null && (reasonOffset > 0 || reason.length > end),
    ...(reason && reason.length > end ? { reason_next: `bb lane-pilot state ${projectId} --attempt ${attemptId} --reason-offset ${end}` } : {}),
    workspace_decision, dirt_before: dirt.slice(0, 200), dirt_before_count: dirt.length };
}

export function getAttempt(db: LanePilotDatabase, attemptId: string): {
  id:string; run_id:string; task_id:string; thread_id:string|null; holder_thread_id:string|null; state:string; reason:string|null;
  failure_code:string|null; check_name:string|null; timeout_sec:number|null; attempt_no:number; dirt_before:DirtSnapshot[];
  workspace_path:string|null;environment_id:string|null;workspace_decision:unknown|null;harness_version:string|null;
}|undefined {
  const row = db.prepare("SELECT id,run_id,task_id,thread_id,holder_thread_id,state,reason,failure_code,check_name,timeout_sec,attempt_no,dirt_before_json,workspace_path,environment_id,workspace_decision_json,harness_version FROM lane_pilot_attempt WHERE id=?").get(attemptId) as
    {id:string; run_id:string; task_id:string; thread_id:string|null; holder_thread_id:string|null; state:string; reason:string|null; failure_code:string|null; check_name:string|null; timeout_sec:number|null; attempt_no:number; dirt_before_json?:string;workspace_path:string|null;environment_id:string|null;workspace_decision_json:string|null;harness_version:string|null}|undefined;
  if (!row) return undefined;
  const dirt_before = parseDirtSnapshots(row.dirt_before_json ?? "[]");
  let workspace_decision:unknown|null=null;
  if(row.workspace_decision_json){try{workspace_decision=JSON.parse(row.workspace_decision_json);}catch{workspace_decision={invalidStoredDecision:true};}}
  return { id:row.id, run_id:row.run_id, task_id:row.task_id, thread_id:row.thread_id, holder_thread_id:row.holder_thread_id, state:row.state, reason:row.reason ?? null,
    failure_code:row.failure_code ?? null, check_name:row.check_name ?? null, timeout_sec:row.timeout_sec ?? null, attempt_no:row.attempt_no, dirt_before,
    workspace_path:row.workspace_path,environment_id:row.environment_id,workspace_decision,harness_version:row.harness_version ?? null };
}

export type ReasoningTrace = {
  planSha256:string;
  sentPlanSha256:string|null;
  sourceLength:number;
  sentLength:number|null;
  jevStatus:"ok"|"disabled"|"timeout"|"error";
  jevDecision:string|null;
  requestedReasoningLevel:string;
  effectiveReasoningLevel:string;
  retryEffort?:{enabled:boolean;retryIndex:number;before:string;after:string;changed:boolean};
  fallbackReason:string|null;
  providerId:string;
  model:string;
  serviceTier:"default"|"fast"|null;
  requestedServiceTier:"default"|"fast";
  runId:string;
  attemptId:string;
  threadId:string|null;
  effortMode?:"automatic"|"manual";
  dispatchContext?:{
    memoryText:string;
    /** Ids of the memory notes mixed into this brief; an accepted attempt credits each (`accepted_count`). Absent before K8. */
    memoryPicked?:string[];
    /** Owner-confirmed project rules; absent in traces written before 0.1.37. */
    rulesText?:string;
    /** Which accepted rules System One picked for this task (ids), out of how many. */
    rulesPicked?:{total:number;picked:string[]};
    executionPacket:string;
    executionPacketSha256:string;
    pmReadContext:string;
    agent:string;
    helperMode:string;
    helperRequired:boolean;
    /** Characters of the brief the writer got; absent before 0.1.90. */
    promptChars?:number;
  };
  selectionSource?:{
    providerId:string;
    model:string;
    reasoningLevel:string;
    serviceTier:"default"|"fast"|null;
    reasoningLevelSource:"explicit"|"client-preference";
  };
};

export function saveReasoningTrace(db: LanePilotDatabase, trace: ReasoningTrace): void {
  db.prepare(`INSERT INTO lane_pilot_attempt_reasoning(attempt_id,trace_json) VALUES(?,?)
    ON CONFLICT(attempt_id) DO UPDATE SET trace_json=excluded.trace_json`).run(trace.attemptId, JSON.stringify(trace));
}

export function setReasoningThread(db: LanePilotDatabase, attemptId:string, threadId:string): void {
  const trace = getReasoningTrace(db, attemptId);
  if (trace) saveReasoningTrace(db, { ...trace, threadId });
}

export function getReasoningTrace(db: LanePilotDatabase, attemptId: string): ReasoningTrace|null {
  const row = db.prepare("SELECT trace_json FROM lane_pilot_attempt_reasoning WHERE attempt_id=?").get(attemptId) as {trace_json:string}|undefined;
  if (!row) return null;
  try { return JSON.parse(row.trace_json) as ReasoningTrace; } catch { return null; }
}

export function setAttemptDirtBefore(db: LanePilotDatabase, attemptId: string, files: DirtSnapshot[] | string[]): void {
  db.prepare("UPDATE lane_pilot_attempt SET dirt_before_json=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(files), Date.now(), attemptId);
}

export type AcceptedFactRow = { taskId: string; runId: string; fact: unknown; summarizedAt: number | null; createdAt: number };

/** J-002: the append-only fact of one accepted task. INSERT OR IGNORE keeps the first write: a fact is never overwritten. */
export function appendAcceptedFact(db: LanePilotDatabase, input: { projectId: string; runId: string; taskId: string; fact: unknown; at?: number }): void {
  db.prepare("INSERT OR IGNORE INTO lane_pilot_accepted_fact (project_id,run_id,task_id,fact_json,created_at) VALUES(?,?,?,?,?)")
    .run(input.projectId, input.runId, input.taskId, JSON.stringify(input.fact ?? {}), input.at ?? Date.now());
}

const factRow = (row: { task_id: string; run_id: string; fact_json: string; summarized_at: number | null; created_at: number }): AcceptedFactRow => {
  let fact: unknown = {};
  try { fact = JSON.parse(row.fact_json) as unknown; } catch { /* a broken row is still a row: the task stays covered */ }
  return { taskId: row.task_id, runId: row.run_id, fact, summarizedAt: row.summarized_at, createdAt: row.created_at };
};

export function listAcceptedFacts(db: LanePilotDatabase, runId: string): AcceptedFactRow[] {
  return (db.prepare("SELECT task_id,run_id,fact_json,summarized_at,created_at FROM lane_pilot_accepted_fact WHERE run_id=? ORDER BY created_at")
    .all(runId) as Array<{ task_id: string; run_id: string; fact_json: string; summarized_at: number | null; created_at: number }>).map(factRow);
}

/** Facts of this run no wave-idle summary has covered yet — the batch the next idle memory maintainer gets. */
export function listPendingAcceptedFacts(db: LanePilotDatabase, runId: string): AcceptedFactRow[] {
  return (db.prepare("SELECT task_id,run_id,fact_json,summarized_at,created_at FROM lane_pilot_accepted_fact WHERE run_id=? AND summarized_at IS NULL ORDER BY created_at")
    .all(runId) as Array<{ task_id: string; run_id: string; fact_json: string; summarized_at: number | null; created_at: number }>).map(factRow);
}

export function markAcceptedFactsSummarized(db: LanePilotDatabase, runId: string, taskIds: readonly string[], at = Date.now()): void {
  if (!taskIds.length) return;
  const stamp = db.prepare("UPDATE lane_pilot_accepted_fact SET summarized_at=? WHERE run_id=? AND task_id=? AND summarized_at IS NULL");
  db.transaction(() => { for (const taskId of taskIds) stamp.run(at, runId, taskId); })();
}
