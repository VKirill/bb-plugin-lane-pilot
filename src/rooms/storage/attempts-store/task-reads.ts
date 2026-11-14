import type { LanePilotDatabase } from "../database";

/** Tasks of the run whose latest attempt ended (accepted, blocked or canceled). */
export function listEndedTaskIds(db: LanePilotDatabase, runId: string): string[] {
  return (db.prepare(`SELECT DISTINCT task_id AS taskId FROM lane_pilot_attempt a WHERE run_id=? AND state IN ('accepted','blocked','canceled')
    AND attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)`)
    .all(runId) as Array<{ taskId: string }>).map((row) => row.taskId);
}

/** Live attempts of other tasks in this task's contract area (an area copy stays while it holds work). */
export function countOtherLiveAttemptsInArea(db: LanePilotDatabase, taskId: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM lane_pilot_attempt a JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested')
      AND a.task_id<>? AND json_extract(t.contract_json,'$.area')=(SELECT json_extract(contract_json,'$.area') FROM lane_pilot_task WHERE id=?)`)
    .get(taskId, taskId) as { n: number }).n;
}

/** When the task's first attempt was created (the age of its work). */
export function firstAttemptAt(db: LanePilotDatabase, taskId: string): number | null {
  return (db.prepare("SELECT MIN(created_at) AS c FROM lane_pilot_attempt WHERE task_id=?").get(taskId) as { c?: number } | undefined)?.c ?? null;
}

/** The task's attempts, newest first, for its failure history. */
export function listTaskAttemptRows(db: LanePilotDatabase, runId: string, taskId: string): Array<{ id: string; state: string; reason: string | null; check_name: string | null }> {
  return db.prepare("SELECT id, state, reason, check_name FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC, rowid DESC")
    .all(runId, taskId) as Array<{ id: string; state: string; reason: string | null; check_name: string | null }>;
}

/** Attempts of a run in the given states, oldest first. */
export function listAttemptsInStates(db: LanePilotDatabase, runId: string, states: readonly string[]): Array<{ task_id: string; state: string; reason: string | null }> {
  return db.prepare(`SELECT task_id, state, reason FROM lane_pilot_attempt WHERE run_id=? AND state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`)
    .all(runId, ...states) as Array<{ task_id: string; state: string; reason: string | null }>;
}

/** Attempts of a project since a time, with their stored model pick trace. */
export function listTracedAttemptsSince(db: LanePilotDatabase, projectId: string, sinceMs: number): Array<{ trace_json: string; state: string }> {
  return db.prepare(`SELECT t.trace_json, a.state FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id JOIN lane_pilot_attempt_reasoning t ON t.attempt_id=a.id
    WHERE r.project_id=? AND a.created_at>=?`).all(projectId, sinceMs) as Array<{ trace_json: string; state: string }>;
}


/** The task's attempts before this one, newest first. */
export function priorAttemptStates(db: LanePilotDatabase, runId: string, taskId: string, excludeAttemptId: string): Array<{ state: string; reason: string | null }> {
  return db.prepare("SELECT state, reason FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND id!=? ORDER BY updated_at DESC")
    .all(runId, taskId, excludeAttemptId) as Array<{ state: string; reason: string | null }>;
}

/** Every attempt reason of the task, in row order. */
export function attemptReasonsForTask(db: LanePilotDatabase, runId: string, taskId: string): Array<string | null> {
  return (db.prepare("SELECT reason FROM lane_pilot_attempt WHERE run_id=? AND task_id=?").all(runId, taskId) as Array<{ reason: string | null }>)
    .map((row) => row.reason);
}

/** Attempts of a run touched since a time, oldest first. */
export function listAttemptsUpdatedSince(db: LanePilotDatabase, runId: string, sinceMs: number): Array<{ task_id: string; state: string; reason: string | null; updated_at: number; created_at: number }> {
  return db.prepare("SELECT task_id, state, reason, updated_at, created_at FROM lane_pilot_attempt WHERE run_id=? AND updated_at>=? ORDER BY created_at")
    .all(runId, sinceMs) as Array<{ task_id: string; state: string; reason: string | null; updated_at: number; created_at: number }>;
}

/** Attempt rows of a project for question answering: optionally only some states, only recent ones, newest first. */
export function listAttemptRowsForProject(db: LanePilotDatabase, input: { projectId: string; states?: readonly string[]; updatedSince?: number; limit: number }): Array<{ taskId: string; runId: string; state: string; reason: string | null; failureCode: string | null; at: number }> {
  const where = ["r.project_id=?"];
  const args: unknown[] = [input.projectId];
  if (input.states?.length) { where.push(`a.state IN (${input.states.map(() => "?").join(",")})`); args.push(...input.states); }
  if (input.updatedSince !== undefined) { where.push("a.updated_at>=?"); args.push(input.updatedSince); }
  args.push(input.limit);
  return db.prepare(`SELECT a.task_id AS taskId, a.run_id AS runId, a.state, a.reason, a.failure_code AS failureCode, a.updated_at AS at FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE ${where.join(" AND ")} ORDER BY a.updated_at DESC LIMIT ?`).all(...args) as
    Array<{ taskId: string; runId: string; state: string; reason: string | null; failureCode: string | null; at: number }>;
}

/** Each task's latest attempt in a project (the dead-letter scan reads it). */
export function latestAttemptsForProject(db: LanePilotDatabase, projectId: string): Array<{ taskId: string; state: string; reason: string | null; failureCode: string | null; updatedAt: number }> {
  return db.prepare(`SELECT a.task_id AS taskId, a.state, a.reason, a.failure_code AS failureCode, a.updated_at AS updatedAt FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.task_id=a.task_id) ORDER BY a.updated_at DESC LIMIT 500`)
    .all(projectId) as Array<{ taskId: string; state: string; reason: string | null; failureCode: string | null; updatedAt: number }>;
}

/** Attempt task_id/state pairs of a run, oldest first. */
export function listRunAttemptStates(db: LanePilotDatabase, runId: string): Array<{ task_id: string; state: string }> {
  return db.prepare("SELECT task_id, state FROM lane_pilot_attempt WHERE run_id=? ORDER BY created_at, attempt_no").all(runId) as
    Array<{ task_id: string; state: string }>;
}

/** Attempts of a run in the given states. */
export function countAttemptsInStates(db: LanePilotDatabase, runId: string, states: readonly string[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM lane_pilot_attempt WHERE run_id=? AND state IN (${states.map(() => "?").join(",")})`)
    .get(runId, ...states) as { n: number }).n;
}

/** Attempts in the given states untouched since a time (the orphan-stage sweep reads them). */
export function listIdleAttemptsInStates(db: LanePilotDatabase, states: readonly string[], updatedBefore: number): Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; failure_code: string | null; check_name: string | null; timeout_sec: number | null; updated_at: number }> {
  return db.prepare(`SELECT id, run_id, task_id, state, reason, failure_code, check_name, timeout_sec, updated_at FROM lane_pilot_attempt
    WHERE state IN (${states.map(() => "?").join(",")}) AND updated_at < ?`).all(...states, updatedBefore) as
    Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; failure_code: string | null; check_name: string | null; timeout_sec: number | null; updated_at: number }>;
}

/** The task's latest attempt row, or null. */
export function latestAttemptRow(db: LanePilotDatabase, runId: string, taskId: string): { id: string; state: string; reason: string | null; failure_code: string | null; check_name: string | null; timeout_sec: number | null; thread_id: string | null; updated_at: number } | undefined {
  return db.prepare("SELECT id, state, reason, failure_code, check_name, timeout_sec, thread_id, updated_at FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC, attempt_no DESC LIMIT 1")
    .get(runId, taskId) as { id: string; state: string; reason: string | null; failure_code: string | null; check_name: string | null; timeout_sec: number | null; thread_id: string | null; updated_at: number } | undefined;
}

/** The board's task rows: latest attempt of each task joined to its run and contract (the Tasks board query). */
export function listBoardAttemptRows(db: LanePilotDatabase, input: { projectId?: string | null; runIds?: readonly string[]; doneSince: number; limit: number }): Array<{
  attempt_id: string; run_id: string; task_id: string; state: string; reason: string | null; thread_id: string | null; attempt_no: number;
  updated_at: number; created_at: number; contract_json: string | null; project_id: string; pm_thread_id: string | null; closed_at: number | null; objective: string | null;
}> {
  const runs = input.runIds?.length ? `AND a.run_id IN (${input.runIds.map(() => "?").join(",")})` : "";
  const scope = `${input.projectId ? "AND r.project_id=?" : ""} ${runs}`;
  const args = [...(input.projectId ? [input.projectId] : []), ...(input.runIds?.length ? input.runIds : [])];
  return db.prepare(`SELECT a.id AS attempt_id, a.run_id, a.task_id, a.state, a.reason, a.thread_id, a.attempt_no, a.updated_at, a.created_at,
      t.contract_json, r.project_id, r.pm_thread_id, r.closed_at, r.objective
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    LEFT JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
      AND ((a.state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested') AND r.closed_at IS NULL) OR a.updated_at>=?) ${scope}
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt c JOIN lane_pilot_run rc ON rc.id=c.run_id
        WHERE rc.project_id=r.project_id AND c.created_at>=a.created_at AND substr(c.task_id,1,length(a.task_id)+1)=a.task_id || '.')
    ORDER BY a.updated_at DESC LIMIT ?`).all(input.doneSince, ...args, input.limit) as Array<{
    attempt_id: string; run_id: string; task_id: string; state: string; reason: string | null; thread_id: string | null; attempt_no: number;
    updated_at: number; created_at: number; contract_json: string | null; project_id: string; pm_thread_id: string | null; closed_at: number | null; objective: string | null;
  }>;
}

/** Task ids of a project with an attempt newer than a time, matching a task-id LIKE (the board's replaced-version check). */
export function laterFamilyAttemptTaskIds(db: LanePilotDatabase, input: { projectId: string; createdAfter: number; excludeTaskId: string; taskIdLike: string }): string[] {
  return (db.prepare(`SELECT c.task_id AS taskId FROM lane_pilot_attempt c JOIN lane_pilot_run rc ON rc.id=c.run_id
    WHERE rc.project_id=? AND c.created_at>? AND c.task_id<>? AND c.task_id LIKE ? ESCAPE '\\'`)
    .all(input.projectId, input.createdAfter, input.excludeTaskId, input.taskIdLike) as Array<{ taskId: string }>).map((row) => row.taskId);
}

/** The task's attempts in dispatch order, for its card and its work graph. */
export function listAttemptHistory(db: LanePilotDatabase, runId: string, taskId: string): Array<{ id: string; attempt_no: number; state: string; reason: string | null; thread_id: string | null; created_at: number; updated_at: number }> {
  return db.prepare("SELECT id, attempt_no, state, reason, thread_id, created_at, updated_at FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY attempt_no")
    .all(runId, taskId) as Array<{ id: string; attempt_no: number; state: string; reason: string | null; thread_id: string | null; created_at: number; updated_at: number }>;
}

/** Open attempts of a project (or of all), newest first: queued, running, failed validation or half-spawned. */
export function openAttemptBriefs(db: LanePilotDatabase, input: { projectId?: string | null; limit?: number } = {}): Array<{ taskId: string; state: string }> {
  const where = input.projectId ? "AND r.project_id=?" : "";
  return db.prepare(`SELECT a.task_id AS taskId, a.state FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state IN ('queued','running','validation_failed','spawn_unknown') ${where} ORDER BY a.updated_at DESC LIMIT ?`)
    .all(...(input.projectId ? [input.projectId] : []), input.limit ?? 50) as Array<{ taskId: string; state: string }>;
}

/** Non-empty attempt reasons written since a time (the unknown-codes report). */
export function listAttemptReasonsSince(db: LanePilotDatabase, sinceMs: number): Array<{ reason: string | null; at: number }> {
  return db.prepare("SELECT reason, updated_at AS at FROM lane_pilot_attempt WHERE updated_at >= ? AND reason IS NOT NULL")
    .all(sinceMs) as Array<{ reason: string | null; at: number }>;
}

/** Tasks of the run whose latest attempt is canceled (a canceled attempt with none after it). */
export function canceledLatestTaskIds(db: LanePilotDatabase, runId: string): string[] {
  return (db.prepare(`SELECT task_id FROM lane_pilot_attempt a WHERE run_id=? AND state='canceled'
    AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id AND (b.created_at>a.created_at OR (b.created_at=a.created_at AND b.attempt_no>a.attempt_no)))`)
    .all(runId) as Array<{ task_id: string }>).map((row) => row.task_id);
}

/** The task's newest attempt's state by row order (the stray-check that a newer attempt exists), or null. */
export function newestAttemptState(db: LanePilotDatabase, runId: string, taskId: string): string | null {
  return (db.prepare("SELECT state FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY rowid DESC LIMIT 1")
    .get(runId, taskId) as { state: string } | undefined)?.state ?? null;
}

/** The raw stored reasoning trace JSON of an attempt (the passport's model cell parses it itself). */
export function getReasoningTraceJson(db: LanePilotDatabase, attemptId: string): string | null {
  return (db.prepare("SELECT trace_json FROM lane_pilot_attempt_reasoning WHERE attempt_id=?").get(attemptId) as { trace_json: string } | undefined)?.trace_json ?? null;
}

/** The newest attempt that ran on a thread: a writer thread can carry several attempts (feedback turns), only the newest owns it. */
export function newestAttemptIdForThread(db: LanePilotDatabase, threadId: string): string | null {
  return (db.prepare("SELECT id FROM lane_pilot_attempt WHERE thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(threadId) as { id: string } | undefined)?.id ?? null;
}

/** When an attempt row last changed (a state change stamps it): how long it has stood in its state. */
export function attemptUpdatedAt(db: LanePilotDatabase, attemptId: string): number | null {
  return (db.prepare("SELECT updated_at FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { updated_at: number } | undefined)?.updated_at ?? null;
}

/** The work a thread last ran as an attempt, with its run's project and PM thread (the info panel's writer card). */
export function latestAttemptWorkForThread(db: LanePilotDatabase, threadId: string): { run_id: string; task_id: string; project_id: string; pm_thread_id: string | null } | undefined {
  return db.prepare(`SELECT a.run_id, a.task_id, r.project_id, r.pm_thread_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.thread_id=? ORDER BY a.updated_at DESC LIMIT 1`).get(threadId) as
    { run_id: string; task_id: string; project_id: string; pm_thread_id: string | null } | undefined;
}

/** Accepted attempts of a project with their task ids, newest first — the regression pass's candidate list. */
export function acceptedAttemptTaskRefs(db: LanePilotDatabase, projectId: string, filter: { runId: string } | { updatedSince: number }): Array<{ attempt_id: string; task_id: string }> {
  return ("runId" in filter
    ? db.prepare(`SELECT a.id AS attempt_id, a.task_id AS task_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
        WHERE r.project_id=? AND a.run_id=? AND a.state='accepted' ORDER BY a.updated_at DESC, a.rowid DESC`).all(projectId, filter.runId)
    : db.prepare(`SELECT a.id AS attempt_id, a.task_id AS task_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
        WHERE r.project_id=? AND a.state='accepted' AND a.updated_at>=? ORDER BY a.updated_at DESC, a.rowid DESC`).all(projectId, filter.updatedSince)) as Array<{ attempt_id: string; task_id: string }>;
}

/** Projects with an accepted attempt since a time (the regression sweep's project list). */
export function acceptedAttemptProjectIds(db: LanePilotDatabase, since: number): string[] {
  return (db.prepare("SELECT DISTINCT r.project_id AS id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state='accepted' AND a.updated_at>=? ORDER BY r.project_id")
    .all(since) as Array<{ id: string }>).map((row) => row.id);
}

/** Accepted tasks per project since a time (the cost-per-verified report). */
export function acceptedTaskCountsByProject(db: LanePilotDatabase, since: number): Array<{ projectId: string; n: number }> {
  return db.prepare(`SELECT r.project_id AS projectId, COUNT(DISTINCT a.task_id) AS n FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state='accepted' AND a.updated_at >= ? GROUP BY r.project_id`)
    .all(since) as Array<{ projectId: string; n: number }>;
}

/** Whether the task has an accepted attempt (an outcome sweep's "the work landed" check). */
export function hasAcceptedAttempt(db: LanePilotDatabase, runId: string, taskId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND state='accepted' LIMIT 1").get(runId, taskId));
}

/** Whether the task has an attempt still at work (an outcome sweep's "still undecided" check). */
export function hasLiveAttempt(db: LanePilotDatabase, runId: string, taskId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND task_id=?
    AND state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested') LIMIT 1`).get(runId, taskId));
}

/** The task's latest attempt by insertion order (a park sweep decides whether to block it). */
export function latestAttemptByRowid(db: LanePilotDatabase, runId: string, taskId: string): { id: string; state: string } | undefined {
  return db.prepare("SELECT id, state FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY rowid DESC LIMIT 1")
    .get(runId, taskId) as { id: string; state: string } | undefined;
}

/** Attempt rows of a project whose task id is the stem or starts with it (the "was this already done" check). */
export function stemAttemptRows(db: LanePilotDatabase, projectId: string, taskId: string, taskIdLike: string): Array<{ task_id: string; state: string; created_at: number }> {
  return db.prepare(`SELECT a.task_id, a.state, a.created_at FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? AND (a.task_id=? OR a.task_id LIKE ? ESCAPE '\\')`).all(projectId, taskId, taskIdLike) as
    Array<{ task_id: string; state: string; created_at: number }>;
}

/** Blocked latest-attempt rows of open runs, created recently (the parked-task adoption sweep). */
export function adoptableBlockedAttempts(db: LanePilotDatabase, since: number): Array<{ run_id: string; task_id: string; state: string; reason: string | null; created_at: number; updated_at: number; harness_version: string | null; project_id: string; pm_thread_id: string | null }> {
  return db.prepare(`SELECT a.run_id, a.task_id, a.state, a.reason, a.created_at, a.updated_at, a.harness_version, r.project_id, r.pm_thread_id
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state='blocked' AND a.created_at>? AND r.closed_at IS NULL
      AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)`)
    .all(since) as Array<{ run_id: string; task_id: string; state: string; reason: string | null; created_at: number; updated_at: number; harness_version: string | null; project_id: string; pm_thread_id: string | null }>;
}

/** The task's attempts, oldest first (the task timeline). */
export function attemptTimelineRows(db: LanePilotDatabase, runId: string, taskId: string): Array<{ id: string; attempt_no: number; created_at: number }> {
  return db.prepare("SELECT id, attempt_no, created_at FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at")
    .all(runId, taskId) as Array<{ id: string; attempt_no: number; created_at: number }>;
}

/** State transitions of the task's attempts, in order (the task timeline's moves). */
export function attemptTransitionsForTask(db: LanePilotDatabase, runId: string, taskId: string): Array<{ attempt_id: string; from_state: string; to_state: string; reason: string | null; refused: number; at: number }> {
  return db.prepare(`SELECT t.attempt_id, t.from_state, t.to_state, t.reason, t.refused, t.at FROM lane_pilot_attempt_transition t
    JOIN lane_pilot_attempt a ON a.id=t.attempt_id WHERE a.run_id=? AND a.task_id=? ORDER BY t.at, t.rowid`).all(runId, taskId) as
    Array<{ attempt_id: string; from_state: string; to_state: string; reason: string | null; refused: number; at: number }>;
}

/** Every attempt row the acceptance stats read, with the held flag from the transitions (projectId narrows to one project). */
export function acceptanceAttemptRows(db: LanePilotDatabase, since: number, projectId?: string): Array<{ projectId: string; runId: string; taskId: string; state: string; reason: string | null; at: number; held: number }> {
  return db.prepare(`SELECT r.project_id AS projectId, a.run_id AS runId, a.task_id AS taskId, a.state AS state, a.reason AS reason, a.created_at AS at,
      EXISTS(SELECT 1 FROM lane_pilot_attempt_transition t WHERE t.attempt_id=a.id AND t.reason LIKE 'waiting_writer:%') AS held
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.created_at>=? ${projectId ? "AND r.project_id=?" : ""}
    ORDER BY r.project_id, a.run_id, a.task_id, a.created_at`)
    .all(...(projectId ? [since, projectId] : [since])) as
    Array<{ projectId: string; runId: string; taskId: string; state: string; reason: string | null; at: number; held: number }>;
}

/** Finished attempts of one harness version since a time (the canary's own sample). */
export function canaryAttemptRows(db: LanePilotDatabase, failedStates: readonly string[], reasonScanChars: number, version: string, since: number): Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; project_id: string; pm_thread_id: string | null }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, substr(a.reason, 1, ${reasonScanChars}) AS reason, r.project_id, r.pm_thread_id FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state IN ('accepted',${failedStates.map(() => "?").join(",")}) AND a.harness_version=? AND a.created_at>=? ORDER BY a.created_at`)
    .all(...failedStates, version, since) as Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; project_id: string; pm_thread_id: string | null }>;
}

/** The harness version that ran right before `version` (the canary's rollback hint). */
export function previousHarnessVersion(db: LanePilotDatabase, version: string, before: number): string | null {
  return (db.prepare("SELECT harness_version FROM lane_pilot_attempt WHERE harness_version IS NOT NULL AND harness_version<>? AND created_at<? ORDER BY created_at DESC LIMIT 1")
    .get(version, before) as { harness_version: string } | undefined)?.harness_version ?? null;
}

/** Workspace paths of attempts in the given states, optionally only those touched since a time (the janitor's protected set). */
export function attemptWorkspacePaths(db: LanePilotDatabase, states: readonly string[], updatedSince?: number): string[] {
  const rows = updatedSince === undefined
    ? db.prepare(`SELECT workspace_path AS p FROM lane_pilot_attempt WHERE workspace_path IS NOT NULL AND state IN (${states.map(() => "?").join(",")})`).all(...states)
    : db.prepare(`SELECT workspace_path AS p FROM lane_pilot_attempt WHERE workspace_path IS NOT NULL AND state IN (${states.map(() => "?").join(",")}) AND updated_at>=?`).all(...states, updatedSince);
  return (rows as Array<{ p: string }>).map((row) => row.p);
}

/** The base checkout a workspace path came from (its attempt's run knows it). */
export function writerBaseForWorkspace(db: LanePilotDatabase, workspacePath: string): string | null {
  return (db.prepare("SELECT writer_workspace_path AS p FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.workspace_path=? LIMIT 1")
    .get(workspacePath) as { p?: string } | undefined)?.p ?? null;
}

/** Open attempt ids of a run (halt cancels each one). */
export function openAttemptIdsOfRun(db: LanePilotDatabase, runId: string): string[] {
  return (db.prepare(`SELECT id FROM lane_pilot_attempt WHERE run_id=? AND state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested')`)
    .all(runId) as Array<{ id: string }>).map((row) => row.id);
}

/** Open attempts of a run, oldest first (the pause report's running/waiting split). */
export function openAttemptsForPause(db: LanePilotDatabase, runId: string): Array<{ id: string; task_id: string; state: string }> {
  return db.prepare("SELECT id, task_id, state FROM lane_pilot_attempt WHERE run_id=? AND state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested') ORDER BY created_at")
    .all(runId) as Array<{ id: string; task_id: string; state: string }>;
}

/** The latest attempt of every task of a run (the PM status view). */
export function latestAttemptsPerTask(db: LanePilotDatabase, runId: string): Array<{ id: string; run_id: string; task_id: string; thread_id: string | null; state: string; reason: string | null }> {
  return db.prepare(`
    SELECT a.id, a.run_id, a.task_id, a.thread_id, a.state, a.reason
    FROM lane_pilot_attempt a
    WHERE a.run_id=?
      AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
  `).all(runId) as Array<{ id: string; run_id: string; task_id: string; thread_id: string | null; state: string; reason: string | null }>;
}

/** Environments the run's attempts used (the cleanup deletes each, except the run's own). */
export function runEnvironmentIds(db: LanePilotDatabase, runId: string): string[] {
  return (db.prepare("SELECT DISTINCT environment_id FROM lane_pilot_attempt WHERE run_id=? AND environment_id IS NOT NULL")
    .all(runId) as Array<{ environment_id: string }>).map((row) => row.environment_id);
}

/** Attempts that bound an environment or a holder thread, with the run's own env and whether a newer attempt of the task exists (the env cleanup). */
export function attemptEnvironmentRows(db: LanePilotDatabase): Array<{ environmentId: string | null; holderThreadId: string | null; state: string; updatedAt: number; runId: string; runEnvironmentId: string | null; superseded: number; area: string | null }> {
  return db.prepare(`SELECT a.environment_id AS environmentId, a.holder_thread_id AS holderThreadId, a.state, a.updated_at AS updatedAt, a.run_id AS runId,
      r.writer_environment_id AS runEnvironmentId, json_extract(t.contract_json,'$.area') AS area,
      EXISTS(SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id AND (b.created_at>a.created_at OR (b.created_at=a.created_at AND b.rowid>a.rowid))) AS superseded
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id LEFT JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.environment_id IS NOT NULL OR a.holder_thread_id IS NOT NULL`).all() as Array<{
    environmentId: string | null; holderThreadId: string | null; state: string; updatedAt: number; runId: string; runEnvironmentId: string | null; superseded: number; area: string | null }>;
}

/** Attempts parked in a workspace that is not the run's own (the sticky-worktree cleanup). */
export function stickyWorktreeAttemptRows(db: LanePilotDatabase): Array<{ path: string; base: string | null; hostId: string | null; state: string; updatedAt: number; area: number; superseded: number }> {
  return db.prepare(`SELECT a.workspace_path AS path, r.writer_workspace_path AS base, r.writer_host_id AS hostId, a.state, a.updated_at AS updatedAt,
      json_extract(t.contract_json,'$.area') IS NOT NULL AS area,
      EXISTS(SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id AND (b.created_at>a.created_at OR (b.created_at=a.created_at AND b.rowid>a.rowid))) AS superseded
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.environment_id IS NULL AND a.workspace_path IS NOT NULL AND a.workspace_path<>r.writer_workspace_path`).all() as Array<{
    path: string; base: string | null; hostId: string | null; state: string; updatedAt: number; area: number; superseded: number }>;
}


/**
 * The worktrees of attempts touched since `since`, with their run's machine, environment and close, and how many later attempts of the
 * same task the run made (the daily worktree pass decides «abandoned» and «BB environment» from these rows).
 */
export function recentAttemptWorkspaces(db: LanePilotDatabase, since: number): Array<{ path: string; env: string | null; state: string; updatedAt: number; host: string; runEnv: string | null; runClosed: number | null; later: number }> {
  return db.prepare(`SELECT a.workspace_path AS path, a.environment_id AS env, a.state, a.updated_at AS updatedAt, r.writer_host_id AS host, r.writer_environment_id AS runEnv, r.closed_at AS runClosed,
      (SELECT COUNT(*) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id AND b.created_at>a.created_at) AS later
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.workspace_path IS NOT NULL AND r.writer_host_id IS NOT NULL AND a.updated_at>=?`).all(since) as Array<{ path: string; env: string | null; state: string; updatedAt: number; host: string; runEnv: string | null; runClosed: number | null; later: number }>;
}
