import type { LanePilotDatabase } from "../database";

/** Candidates only: the caller still checks open state and host identity before reconciling a removed environment. */
export function attemptEnvironmentCandidates(db: LanePilotDatabase, environmentId: string, ownedPath: string | null): Array<{ id: string; run_id: string; environment_id: string | null }> {
  return (ownedPath
    ? db.prepare("SELECT id, run_id, environment_id FROM lane_pilot_attempt WHERE environment_id=? OR workspace_path=?").all(environmentId, ownedPath)
    : db.prepare("SELECT id, run_id, environment_id FROM lane_pilot_attempt WHERE environment_id=?").all(environmentId)) as Array<{ id: string; run_id: string; environment_id: string | null }>;
}

/** Attempt ids that ever ran on a thread (thread-window attribution for usage). */
export function attemptIdsOfThread(db: LanePilotDatabase, threadId: string): string[] {
  return (db.prepare("SELECT id FROM lane_pilot_attempt WHERE thread_id=?").all(threadId) as Array<{ id: string }>).map((row) => row.id);
}

/** Writer and holder thread ids of a run's attempts (usage attribution marks them all as Lane Pilot's). */
export function attemptThreadsOfRun(db: LanePilotDatabase, runId: string): string[] {
  return (db.prepare("SELECT thread_id, holder_thread_id FROM lane_pilot_attempt WHERE run_id=?").all(runId) as Array<{ thread_id: string | null; holder_thread_id: string | null }>)
    .flatMap((row) => [row.thread_id, row.holder_thread_id]).filter((id): id is string => Boolean(id));
}

/** Task/state/reason/failure_code of every attempt of a run, oldest first (the topic-loop guard's history). */
export function runAttemptOutcomeRows(db: LanePilotDatabase, runId: string): Array<{ task_id: string; state: string; reason: string | null; failure_code: string | null }> {
  return db.prepare("SELECT task_id, state, reason, failure_code FROM lane_pilot_attempt WHERE run_id=? ORDER BY created_at")
    .all(runId) as Array<{ task_id: string; state: string; reason: string | null; failure_code: string | null }>;
}

/** Task ids with an accepted attempt in the run, oldest first (a redo family's earlier merged member). */
export function acceptedTaskIdsOfRun(db: LanePilotDatabase, runId: string): string[] {
  return (db.prepare("SELECT DISTINCT task_id FROM lane_pilot_attempt WHERE run_id=? AND state='accepted' ORDER BY created_at")
    .all(runId) as Array<{ task_id: string }>).map((row) => row.task_id);
}

/** The attempt's workspace path and last touch (retry safety reads where the diff runs). */
export function attemptWorkspaceRow(db: LanePilotDatabase, attemptId: string): { workspace_path: string | null; updated_at: number } | undefined {
  return db.prepare("SELECT workspace_path, updated_at FROM lane_pilot_attempt WHERE id=?").get(attemptId) as
    { workspace_path: string | null; updated_at: number } | undefined;
}

/** The run's other attempts (the family-produced-files check excludes the attempt itself). */
export function otherAttemptsOfRun(db: LanePilotDatabase, runId: string, attemptId: string): Array<{ id: string; task_id: string }> {
  return db.prepare("SELECT id, task_id FROM lane_pilot_attempt WHERE run_id=? AND id<>?")
    .all(runId, attemptId) as Array<{ id: string; task_id: string }>;
}

/** Task ids any attempt of the run touched (the owns-paths scope only covers tasks that actually ran). */
export function attemptedTaskIdsOfRun(db: LanePilotDatabase, runId: string): string[] {
  return (db.prepare("SELECT DISTINCT task_id FROM lane_pilot_attempt WHERE run_id=?").all(runId) as Array<{ task_id: string }>).map((row) => row.task_id);
}

/** The task's newest attempt by dispatch order (a writer-question item asks whether the task moved on). */
export function latestTaskAttemptRow(db: LanePilotDatabase, runId: string, taskId: string): { state: string; created_at: number } | undefined {
  return db.prepare("SELECT state, created_at FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC, attempt_no DESC LIMIT 1")
    .get(runId, taskId) as { state: string; created_at: number } | undefined;
}

/** Attempts that ever ran on the thread (a sticky writer's turn count). */
export function countThreadAttempts(db: LanePilotDatabase, threadId: string): number {
  return (db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE thread_id=?").get(threadId) as { count: number }).count;
}

/** Attempts of one task that ran on the thread (a feedback session's turn count). */
export function countThreadTaskAttempts(db: LanePilotDatabase, threadId: string, taskId: string): number {
  return (db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE thread_id=? AND task_id=?").get(threadId, taskId) as { count: number }).count;
}

/** The trace context a memory effect reads for an attempt: its run's project and reasoning trace. */
export function attemptTraceContext(db: LanePilotDatabase, attemptId: string): { projectId: string; trace: string } | undefined {
  return db.prepare(`SELECT r.project_id AS projectId, t.trace_json AS trace FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id JOIN lane_pilot_attempt_reasoning t ON t.attempt_id=a.id WHERE a.id=?`).get(attemptId) as { projectId: string; trace: string } | undefined;
}

/** The newest accepted attempt of a task (id and number). */
export function latestAcceptedAttemptRef(db: LanePilotDatabase, runId: string, taskId: string): { id: string; attempt_no: number } | undefined {
  return db.prepare("SELECT id, attempt_no FROM lane_pilot_attempt WHERE run_id = ? AND task_id = ? AND state = 'accepted' ORDER BY updated_at DESC LIMIT 1")
    .get(runId, taskId) as { id: string; attempt_no: number } | undefined;
}

/** task_id/state of a project's attempts, newest first (the relay's family lookup). */
export function listProjectAttemptStates(db: LanePilotDatabase, projectId: string): Array<{ task_id: string; state: string }> {
  return db.prepare(`SELECT a.task_id, a.state FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? ORDER BY a.created_at DESC, a.attempt_no DESC`).all(projectId) as Array<{ task_id: string; state: string }>;
}

/** Attempts touched since a time in a failed-ish state (the overnight summary). */
export function listFailedAttemptsSince(db: LanePilotDatabase, sinceMs: number): Array<{ state: string; id: string }> {
  return db.prepare("SELECT state, id FROM lane_pilot_attempt WHERE updated_at>=? AND (state LIKE '%failed%' OR state IN ('blocked','provider_error')) ORDER BY state, updated_at DESC")
    .all(sinceMs) as Array<{ state: string; id: string }>;
}

/** Whether an attempt ever ran in a workspace path without an environment (the provider-removal guard). */
export function bareWorkspaceAttemptExists(db: LanePilotDatabase, workspacePath: string): boolean {
  return db.prepare("SELECT 1 FROM lane_pilot_attempt WHERE workspace_path=? AND environment_id IS NULL LIMIT 1").get(workspacePath) !== undefined;
}

/** A run's attempts for queue-wait math: id, state, creation. */
export function listRunQueueAttempts(db: LanePilotDatabase, runId: string): Array<{ id: string; state: string; created_at: number }> {
  return db.prepare("SELECT id, state, created_at FROM lane_pilot_attempt WHERE run_id=?").all(runId) as Array<{ id: string; state: string; created_at: number }>;
}

/** A run's unrefused transitions in order (queue-wait math). */
export function listRunTransitions(db: LanePilotDatabase, runId: string): Array<{ attempt_id: string; from_state: string; to_state: string; at: number }> {
  return db.prepare(`SELECT t.attempt_id, t.from_state, t.to_state, t.at FROM lane_pilot_attempt_transition t
    JOIN lane_pilot_attempt a ON a.id=t.attempt_id WHERE a.run_id=? AND t.refused=0 ORDER BY t.attempt_id, t.at, t.rowid`).all(runId) as
    Array<{ attempt_id: string; from_state: string; to_state: string; at: number }>;
}

/** A project's attempts since a time, optionally one task's (the metrics report). */
/** Every attempt since `sinceMs` that started a writer thread, with its task's contract (the spend-estimate reads both). */
export function attemptContractRowsSince(db: LanePilotDatabase, sinceMs: number): Array<{ attempt_id: string; task_id: string; run_id: string; thread_id: string; contract_json: string; created_at: number }> {
  return db.prepare(`SELECT a.id AS attempt_id, a.task_id, a.run_id, a.thread_id, t.contract_json, a.created_at
    FROM lane_pilot_attempt a JOIN lane_pilot_task t ON t.run_id=a.run_id AND t.id=a.task_id
    WHERE a.created_at >= ? AND a.thread_id IS NOT NULL AND a.state NOT IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested')`).all(sinceMs) as Array<{ attempt_id: string; task_id: string; run_id: string; thread_id: string; contract_json: string; created_at: number }>;
}

export function listProjectAttemptsSince(db: LanePilotDatabase, input: { projectId: string; sinceMs: number; taskId?: string }): Array<{ id: string; run_id: string; task_id: string; attempt_no: number; state: string; thread_id: string | null; created_at: number; updated_at: number }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.attempt_no, a.state, a.thread_id, a.created_at, a.updated_at
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id = a.run_id
    WHERE r.project_id = ? AND a.created_at >= ? ${input.taskId ? "AND a.task_id = ?" : ""} ORDER BY a.run_id, a.task_id, a.created_at, a.attempt_no`)
    .all(input.projectId, input.sinceMs, ...(input.taskId ? [input.taskId] : [])) as
    Array<{ id: string; run_id: string; task_id: string; attempt_no: number; state: string; thread_id: string | null; created_at: number; updated_at: number }>;
}

/** A project's unrefused attempt transitions since a time, optionally one task's (the metrics report). */
export function listProjectTransitionsSince(db: LanePilotDatabase, input: { projectId: string; sinceMs: number; taskId?: string }): Array<{ attempt_id: string; from_state: string; to_state: string; at: number; reason: string | null }> {
  return db.prepare(`SELECT t.attempt_id, t.from_state, t.to_state, t.at, t.reason FROM lane_pilot_attempt_transition t
    JOIN lane_pilot_attempt a ON a.id = t.attempt_id JOIN lane_pilot_run r ON r.id = a.run_id
    WHERE r.project_id = ? AND a.created_at >= ? AND t.refused = 0 ${input.taskId ? "AND a.task_id = ?" : ""} ORDER BY t.attempt_id, t.at, t.rowid`)
    .all(input.projectId, input.sinceMs, ...(input.taskId ? [input.taskId] : [])) as
    Array<{ attempt_id: string; from_state: string; to_state: string; at: number; reason: string | null }>;
}

export function listCandidateTaskRows(db: LanePilotDatabase): Array<{ task_id: string; run_id: string; project_id: string; contract_json: string; initial_head_sha: string; base_sha: string | null; attempt_id: string; attempt_no: number; accepted_at: number }> {
  return db.prepare(`SELECT t.id AS task_id, t.run_id, r.project_id, t.contract_json, g.initial_head_sha, g.base_sha, a.id AS attempt_id, a.attempt_no, a.updated_at AS accepted_at
    FROM lane_pilot_task t
    JOIN lane_pilot_run r ON r.id = t.run_id
    JOIN lane_pilot_task_git_base g ON g.task_id = t.id
    JOIN lane_pilot_attempt a ON a.task_id = t.id AND a.state = 'accepted'
      AND a.attempt_no = (SELECT MIN(b.attempt_no) FROM lane_pilot_attempt b WHERE b.task_id = t.id AND b.state = 'accepted')
    WHERE t.id NOT LIKE 'drill-%' AND g.initial_head_sha <> ''
    GROUP BY t.id ORDER BY t.id`).all() as
    Array<{ task_id: string; run_id: string; project_id: string; contract_json: string; initial_head_sha: string; base_sha: string | null; attempt_id: string; attempt_no: number; accepted_at: number }>;
}
