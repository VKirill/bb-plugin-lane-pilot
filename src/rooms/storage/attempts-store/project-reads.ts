import { OPEN_ATTEMPT_STATES, RETRY_ELIGIBLE } from "../../contracts/state-machine";
import type { LanePilotDatabase } from "../database";

export function latestAttemptEnvironmentId(db: LanePilotDatabase, runId: string, taskId: string, workspacePath: string): string | null {
  return (db.prepare(`SELECT environment_id AS environmentId FROM lane_pilot_attempt
    WHERE run_id=? AND task_id=? AND workspace_path=? AND environment_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
    .get(runId, taskId, workspacePath) as { environmentId: string } | undefined)?.environmentId ?? null;
}

export function listAttemptsForProjectOrdered(db: LanePilotDatabase, projectId: string): Array<{ task_id: string; state: string; reason: string | null; created_at: number }> {
  return db.prepare(`SELECT a.task_id, a.state, a.reason, a.created_at FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? ORDER BY a.created_at`).all(projectId) as Array<{ task_id: string; state: string; reason: string | null; created_at: number }>;
}

export function countAcceptedForProject(db: LanePilotDatabase, projectId: string, since: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.project_id=? AND a.state='accepted' AND a.updated_at>=?")
    .get(projectId, since) as { n: number }).n;
}

export function listCheckFailureRows(db: LanePilotDatabase, projectId: string, since: number): Array<{ taskId: string; checkName: string }> {
  return db.prepare(`SELECT a.task_id AS taskId, a.check_name AS checkName FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? AND a.created_at>=? AND a.failure_code IN ('verification_failed','verification_timeout') AND a.check_name IS NOT NULL`)
    .all(projectId, since) as Array<{ taskId: string; checkName: string }>;
}

export function listFailedAttemptRows(db: LanePilotDatabase, states: readonly string[], updatedAfter: number): Array<{ id: string; run_id: string; task_id: string; thread_id: string | null; reason: string | null; updated_at: number; project_id: string }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.thread_id, a.reason, a.updated_at, r.project_id FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state IN (${states.map(() => "?").join(",")}) AND a.updated_at > ?`)
    .all(...states, updatedAfter) as Array<{ id: string; run_id: string; task_id: string; thread_id: string | null; reason: string | null; updated_at: number; project_id: string }>;
}

export function listStaleAttemptsInState(db: LanePilotDatabase, state: string, updatedBefore: number): Array<{ id: string; run_id: string; task_id: string; thread_id: string | null; updated_at: number; project_id: string }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.thread_id, a.updated_at, r.project_id FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state=? AND a.updated_at < ?`)
    .all(state, updatedBefore) as Array<{ id: string; run_id: string; task_id: string; thread_id: string | null; updated_at: number; project_id: string }>;
}

export function listStaleQueuedAttempts(db: LanePilotDatabase, updatedBefore: number, workingStates: readonly string[]): Array<{ id: string; run_id: string; task_id: string; updated_at: number; project_id: string; contract_json: string | null }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.updated_at, r.project_id, t.contract_json FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id LEFT JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.state='queued' AND a.updated_at < ? AND r.state='running'
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.state IN (${workingStates.map(() => "?").join(",")}))
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.state<>'queued' AND b.updated_at >= ?)`)
    .all(updatedBefore, ...workingStates, updatedBefore) as Array<{ id: string; run_id: string; task_id: string; updated_at: number; project_id: string; contract_json: string | null }>;
}

export function listRecentFailedAttemptRows(db: LanePilotDatabase, states: readonly string[], updatedAfter: number): Array<{ id: string; run_id: string; task_id: string; thread_id: string | null; reason: string | null; failure_code: string | null; updated_at: number; project_id: string; contract_json: string | null }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.thread_id, a.reason, a.failure_code, a.updated_at, r.project_id, t.contract_json FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id LEFT JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.state IN (${states.map(() => "?").join(",")}) AND a.updated_at > ?`)
    .all(...states, updatedAfter) as Array<{ id: string; run_id: string; task_id: string; thread_id: string | null; reason: string | null; failure_code: string | null; updated_at: number; project_id: string; contract_json: string | null }>;
}

export function listJournalAttemptRows(db: LanePilotDatabase, states: readonly string[], since: number, until: number): Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; failure_code: string | null; updated_at: number; harness_version: string | null; project_id: string }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.failure_code, a.updated_at, a.harness_version, r.project_id
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.updated_at>=? AND a.updated_at<? AND a.state IN (${states.map(() => "?").join(",")})
    ORDER BY a.updated_at`).all(since, until, ...states) as
    Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; failure_code: string | null; updated_at: number; harness_version: string | null; project_id: string }>;
}

export function listFinishedAttemptRows(db: LanePilotDatabase, notStates: readonly string[], before: number, limit: number): Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; failure_code: string | null; updated_at: number; project_id: string }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.failure_code, a.updated_at, r.project_id
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.updated_at<=? AND a.state NOT IN (${notStates.map(() => "?").join(",")})
    ORDER BY a.updated_at DESC LIMIT ?`).all(before, ...notStates, limit) as
    Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; failure_code: string | null; updated_at: number; project_id: string }>;
}

export function listFailedAttemptsSinceDesc(db: LanePilotDatabase, states: readonly string[], since: number, limit: number): Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; failure_code: string | null; updated_at: number; project_id: string }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.failure_code, a.updated_at, r.project_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.updated_at>=? AND a.state IN (${states.map(() => "?").join(",")})
    ORDER BY a.updated_at DESC LIMIT ?`).all(since, ...states, limit) as
    Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; failure_code: string | null; updated_at: number; project_id: string }>;
}

export function listHarnessVersionTimeline(db: LanePilotDatabase, until: number, limit: number): Array<{ created_at: number; harness_version: string }> {
  return (db.prepare("SELECT created_at, harness_version FROM lane_pilot_attempt WHERE harness_version IS NOT NULL AND created_at<=? ORDER BY created_at DESC LIMIT ?")
    .all(until, limit) as Array<{ created_at: number; harness_version: string }>).reverse();
}

export function listAttemptBriefRows(db: LanePilotDatabase, projectId: string, since: number, until: number): Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; attempt_no: number; trace_json: string | null }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.attempt_no, t.trace_json FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id LEFT JOIN lane_pilot_attempt_reasoning t ON t.attempt_id=a.id
    WHERE r.project_id=? AND a.created_at>=? AND a.created_at<? ORDER BY a.created_at`).all(projectId, since, until) as
    Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; attempt_no: number; trace_json: string | null }>;
}

export function listTaskAcceptanceRows(db: LanePilotDatabase, projectId: string, since: number): Array<{ id: string; createdAt: number; area: string | null; acceptedAt: number | null }> {
  return db.prepare(`SELECT t.id, t.created_at AS createdAt, json_extract(t.contract_json,'$.area') AS area,
      (SELECT MIN(a.updated_at) FROM lane_pilot_attempt a WHERE a.task_id=t.id AND a.run_id=t.run_id AND a.state='accepted') AS acceptedAt
    FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id=t.run_id
    WHERE r.project_id=? AND t.kind='bb' AND t.created_at>=?`).all(projectId, since) as Array<{ id: string; createdAt: number; area: string | null; acceptedAt: number | null }>;
}

export function listWriterThreadTurns(db: LanePilotDatabase, projectId: string, since: number): Array<{ threadId: string; turns: number }> {
  return db.prepare(`SELECT a.thread_id AS threadId, COUNT(*) AS turns FROM lane_pilot_attempt a
    JOIN lane_pilot_task t ON t.id=a.task_id AND t.run_id=a.run_id JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? AND t.kind='bb' AND t.created_at>=? AND a.thread_id IS NOT NULL GROUP BY a.thread_id`).all(projectId, since) as Array<{ threadId: string; turns: number }>;
}

export function cancelCodeCounts(db: LanePilotDatabase, since: number, limit: number): Array<{ code: string; n: number }> {
  return db.prepare(`SELECT COALESCE(cancel_code, 'unknown') AS code, COUNT(*) AS n FROM lane_pilot_attempt
    WHERE state='canceled' AND updated_at>=? GROUP BY code ORDER BY n DESC, code LIMIT ?`).all(since, limit) as Array<{ code: string; n: number }>;
}

export function attemptRowWithProject(db: LanePilotDatabase, id: string): { id: string; run_id: string; task_id: string; state: string; reason: string | null; updated_at: number; harness_version: string | null; project_id: string } | undefined {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.updated_at, a.harness_version, r.project_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.id=?`)
    .get(id) as { id: string; run_id: string; task_id: string; state: string; reason: string | null; updated_at: number; harness_version: string | null; project_id: string } | undefined;
}

export function listFamilyAttemptRows(db: LanePilotDatabase, runId: string, family: string): Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; updated_at: number; harness_version: string | null; project_id: string }> {
  return db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.updated_at, a.harness_version, r.project_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.run_id=? AND (a.task_id=? OR a.task_id LIKE ?) ORDER BY a.created_at`).all(runId, family, `${family}.%`) as
    Array<{ id: string; run_id: string; task_id: string; state: string; reason: string | null; updated_at: number; harness_version: string | null; project_id: string }>;
}

export function listAttemptReasonsLike(db: LanePilotDatabase, since: number, like: string, limit: number): Array<{ task_id: string; state: string; reason: string | null }> {
  return db.prepare("SELECT task_id, state, substr(reason,1,160) AS reason FROM lane_pilot_attempt WHERE updated_at>? AND reason LIKE ? ORDER BY updated_at DESC LIMIT ?")
    .all(since, like, limit) as Array<{ task_id: string; state: string; reason: string | null }>;
}

export function acceptedFamilyAttemptId(db: LanePilotDatabase, runId: string, family: string, updatedAfter: number): string | null {
  return (db.prepare("SELECT id FROM lane_pilot_attempt WHERE run_id=? AND (task_id=? OR task_id LIKE ?) AND state='accepted' AND updated_at>? LIMIT 1")
    .get(runId, family, `${family}.%`, updatedAfter) as { id: string } | undefined)?.id ?? null;
}

export function acceptedAttemptCiting(db: LanePilotDatabase, runId: string, updatedAfter: number, text: string): string | null {
  return (db.prepare("SELECT a.id FROM lane_pilot_attempt a JOIN lane_pilot_task t ON t.id=a.task_id WHERE t.run_id=? AND a.state='accepted' AND a.updated_at>? AND instr(t.contract_json, ?)>0 LIMIT 1")
    .get(runId, updatedAfter, text) as { id: string } | undefined)?.id ?? null;
}

export function listVersionedAttemptRows(db: LanePilotDatabase, version: string, since: number): Array<{ state: string; reason: string | null; failure_code: string | null; project_id: string }> {
  return db.prepare(`SELECT a.state, a.reason, a.failure_code, r.project_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.harness_version=? AND a.created_at>=? AND a.state NOT IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested','canceled')`)
    .all(version, since) as Array<{ state: string; reason: string | null; failure_code: string | null; project_id: string }>;
}

export function listAcceptedAttemptsWithThread(db: LanePilotDatabase, since: number): Array<{ id: string; threadId: string; projectId: string }> {
  return db.prepare(`SELECT a.id, a.thread_id AS threadId, r.project_id AS projectId FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state='accepted' AND a.thread_id IS NOT NULL AND a.updated_at>=?
    ORDER BY a.updated_at DESC`).all(since) as Array<{ id: string; threadId: string; projectId: string }>;
}

export function listComplexTaskRows(db: LanePilotDatabase, since: number): Array<{ id: string; contract: string; projectId: string; attempts: number; first: number; last: number }> {
  return db.prepare(`SELECT t.id, t.contract_json AS contract, r.project_id AS projectId, count(a.id) AS attempts, min(a.created_at) AS first, max(a.updated_at) AS last
    FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id=t.run_id JOIN lane_pilot_attempt a ON a.run_id=t.run_id AND a.task_id=t.id
    WHERE t.created_at>=?
      AND EXISTS (SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=t.run_id AND b.task_id=t.id AND b.state='accepted')
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt c WHERE c.run_id=t.run_id AND c.task_id=t.id AND c.state IN ('queued','spawn_requested','running','cancel_requested'))
    GROUP BY t.id ORDER BY t.created_at DESC`).all(since) as Array<{ id: string; contract: string; projectId: string; attempts: number; first: number; last: number }>;
}

export function attemptStateCounts(db: LanePilotDatabase, since: number): Array<{ state: string; n: number }> {
  return db.prepare("SELECT state, count(*) AS n FROM lane_pilot_attempt WHERE updated_at > ? GROUP BY state").all(since) as Array<{ state: string; n: number }>;
}

export function failedAttemptStateCounts(db: LanePilotDatabase, since: number): Array<{ state: string; n: number }> {
  return db.prepare("SELECT state, count(*) AS n FROM lane_pilot_attempt WHERE updated_at>=? AND (state LIKE '%failed%' OR state IN ('blocked','provider_error')) GROUP BY state ORDER BY state")
    .all(since) as Array<{ state: string; n: number }>;
}

export function listAcceptedAttemptsForTask(db: LanePilotDatabase, taskId: string): Array<{ id: string; updatedAt: number }> {
  return db.prepare("SELECT id, updated_at AS updatedAt FROM lane_pilot_attempt WHERE task_id=? AND state='accepted' ORDER BY updated_at DESC, rowid DESC")
    .all(taskId) as Array<{ id: string; updatedAt: number }>;
}

export function listAttemptStatesForTask(db: LanePilotDatabase, taskId: string): Array<{ id: string; state: string }> {
  return db.prepare("SELECT id, state FROM lane_pilot_attempt WHERE task_id=? ORDER BY attempt_no").all(taskId) as Array<{ id: string; state: string }>;
}

export function attemptRunAndThread(db: LanePilotDatabase, attemptId: string): { run_id: string | undefined; thread_id: string | null } | undefined {
  return db.prepare("SELECT run_id, thread_id FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { run_id: string | undefined; thread_id: string | null } | undefined;
}

export function attemptStateForTaskRun(db: LanePilotDatabase, taskId: string, runId: string | null): string | null {
  return (db.prepare(`SELECT a.state FROM lane_pilot_attempt a WHERE a.task_id = ? AND a.run_id = ?
     ORDER BY (a.state = 'accepted') DESC, a.created_at DESC LIMIT 1`).get(taskId, runId) as { state: string } | undefined)?.state ?? null;
}

export function latestAttemptStateCreated(db: LanePilotDatabase, runId: string, taskId: string): string | null {
  return (db.prepare("SELECT state FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC LIMIT 1")
    .get(runId, taskId) as { state: string } | undefined)?.state ?? null;
}

/**
 * Every failed task of every project, one row per task (its latest attempt in a failed state, SMA dt_bugs):
 * the single failure journal — project, run, task, state, reason, failure code and when it failed.
 */
export function failedTasksAllProjects(db: LanePilotDatabase, since = 0): Array<{
  attemptId: string; projectId: string; runId: string; taskId: string; state: string; reason: string | null; failureCode: string | null; failedAt: number;
}> {
  return db.prepare(`SELECT a.id AS attemptId, r.project_id AS projectId, a.run_id AS runId, a.task_id AS taskId, a.state, a.reason, a.failure_code AS failureCode, a.updated_at AS failedAt
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.task_id=a.task_id)
      AND a.state NOT IN ('accepted','canceled','queued','spawn_requested','spawn_unknown','running','cancel_requested')
      AND a.updated_at>=? ORDER BY a.updated_at DESC LIMIT 1000`).all(since) as
    Array<{ attemptId: string; projectId: string; runId: string; taskId: string; state: string; reason: string | null; failureCode: string | null; failedAt: number }>;
}

/** The newest accepted attempt of a task, whatever its run: where a similar past work's files are read from (SMA ap_similar). */
export function latestAcceptedAttemptOfTask(db: LanePilotDatabase, taskId: string): { run_id: string; id: string } | undefined {
  return db.prepare("SELECT run_id,id FROM lane_pilot_attempt WHERE task_id=? AND state='accepted' ORDER BY attempt_no DESC LIMIT 1").get(taskId) as { run_id: string; id: string } | undefined;
}

/** The attempts created since a moment, of one project or of all: the rows receipt coverage is counted over. */
export function listAttemptRefsSince(db: LanePilotDatabase, since: number, projectId?: string): Array<{ id: string; run_id: string; task_id: string }> {
  return (projectId
    ? db.prepare("SELECT a.id, a.run_id, a.task_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.project_id=? AND a.created_at>=?").all(projectId, since)
    : db.prepare("SELECT id, run_id, task_id FROM lane_pilot_attempt WHERE created_at>=?").all(since)) as Array<{ id: string; run_id: string; task_id: string }>;
}

/** The writer threads a run ever ran: a fresh run budget is seeded from their token cursors, so spend of attempts killed
 * with the previous plugin instance still counts (SMA dt_stopped_spend). */
export function listRunWriterThreadIds(db: LanePilotDatabase, runId: string): string[] {
  return (db.prepare("SELECT DISTINCT thread_id FROM lane_pilot_attempt WHERE run_id=? AND thread_id IS NOT NULL").all(runId) as Array<{ thread_id: string }>).map((row) => row.thread_id);
}

/** The barrier's outcome on the attempt row (sma av_record): the last gate that weighed this attempt, as JSON. */
export function setAttemptBarrier(db: LanePilotDatabase, attemptId: string, barrier: unknown): void {
  db.prepare("UPDATE lane_pilot_attempt SET barrier_json=? WHERE id=?").run(JSON.stringify(barrier), attemptId);
}

/** Attempts in a live state that have not moved since the cutoff: candidates for the lease take-back (SMA tr_claimed). */
export function listUnmovedLiveAttempts(db: LanePilotDatabase, cutoff: number): Array<{ id: string; run_id: string; task_id: string }> {
  return db.prepare(`SELECT id, run_id, task_id FROM lane_pilot_attempt WHERE state IN ('spawn_requested','spawn_unknown','running','cancel_requested') AND updated_at < ?`)
    .all(cutoff) as Array<{ id: string; run_id: string; task_id: string }>;
}

/** A project's live attempts with their task's claims, newest movement first (SMA k_hss_summary, k_hss_digest). */
export function projectLiveAttempts(db: LanePilotDatabase, projectId: string): Array<{ id: string; task_id: string; state: string; updated_at: number; owns_paths: string | null; workspace_path: string | null }> {
  return db.prepare(`SELECT a.id, a.task_id, a.state, a.updated_at, a.workspace_path, json_extract(t.contract_json,'$.owns_paths') AS owns_paths
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id LEFT JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE r.project_id=? AND a.state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested') ORDER BY a.updated_at DESC`)
    .all(projectId) as Array<{ id: string; task_id: string; state: string; updated_at: number; owns_paths: string | null; workspace_path: string | null }>;
}

/** The project a checkout belongs to: a run's own workspace or an attempt's worktree. */
export function projectIdForWorkspacePath(db: LanePilotDatabase, path: string): string | null {
  return (db.prepare(`SELECT p FROM (SELECT r.project_id AS p FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.workspace_path=?
      UNION ALL SELECT project_id FROM lane_pilot_run WHERE writer_workspace_path=?) LIMIT 1`)
    .get(path, path) as { p?: string } | undefined)?.p ?? null;
}

/** The section chain of the run a checkout belongs to (its settings scopes, outermost first); empty for a checkout no run owns: the project root. */
export function settingsScopesForWorkspacePath(db: LanePilotDatabase, path: string): string[] {
  const row = db.prepare(`SELECT scopes FROM (
      SELECT r.settings_scopes_json AS scopes, a.updated_at AS at FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.workspace_path=?
      UNION ALL SELECT r.settings_scopes_json, r.updated_at FROM lane_pilot_run r WHERE r.writer_workspace_path=?) ORDER BY at DESC LIMIT 1`)
    .get(path, path) as { scopes?: string | null } | undefined;
  try { const scopes = JSON.parse(row?.scopes ?? "[]"); return Array.isArray(scopes) ? scopes.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

/** The run's attempts still in flight, the one that moved last first. */
export function liveAttemptsOfRun(db: Pick<LanePilotDatabase, "prepare">, runId: string): Array<{ id: string; task_id: string }> {
  return db.prepare("SELECT id, task_id FROM lane_pilot_attempt WHERE run_id=? AND state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested') ORDER BY updated_at DESC")
    .all(runId) as Array<{ id: string; task_id: string }>;
}

/** What a machine worked on today: the projects whose runs write on this host and the attempts that moved in the window, by state (SMA m_sw_machines). */
export function hostActivityToday(db: LanePilotDatabase, hostId: string, since: number): { projects: string[]; accepted: number; blocked: number; running: number } {
  const rows = db.prepare(`SELECT r.project_id AS projectId, a.state AS state FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.writer_host_id=? AND a.updated_at>=?`).all(hostId, since) as Array<{ projectId: string; state: string }>;
  return {
    projects: [...new Set(rows.map((row) => row.projectId))].sort(),
    accepted: rows.filter((row) => row.state === "accepted").length,
    blocked: rows.filter((row) => row.state === "blocked").length,
    running: rows.filter((row) => row.state === "running").length,
  };
}

/** The latest accepted attempt of each task of the project's runs created since `sinceMs` (the project report's git and timeline rows). */
export function listAcceptedAttemptsSince(db: LanePilotDatabase, projectId: string, sinceMs: number): Array<{ runId: string; taskId: string; attemptId: string; createdAt: number }> {
  return db.prepare(`SELECT a.run_id AS runId, a.task_id AS taskId, a.id AS attemptId, a.created_at AS createdAt
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? AND r.created_at>=? AND a.state='accepted'
      AND a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id AND b.state='accepted')
    ORDER BY a.created_at`).all(projectId, sinceMs) as Array<{ runId: string; taskId: string; attemptId: string; createdAt: number }>;
}

/** The key of a task's throwaway codex home (helper-bb-shim's workerHome and the janitor's removal share it); null for a key the host refuses: empty or starting with a dot. */
export function workerHomeKey(id: string): string | null {
  const key = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return key === "" || key.startsWith(".") ? null : key;
}

/**
 * Tasks the codex-home sweep may clear (SMA m_ac_codex_home): the NEWEST attempt of the task is final (accepted|blocked|canceled) and ended at
 * least `quietMs` ago (a day: longer than the worktree grace and the sticky window, inside which the writer's thread may be resumed with its home), and no attempt of any run with that task id is open — a re-queued task that runs now keeps its home. Newest first.
 * Each row carries the project, and the keys the task's homes may sit under: its id (the key the worker home is made under) and its attempt ids.
 */
export function finalTaskIdsSince(db: LanePilotDatabase, since: number, limit = 300, now = Date.now(), quietMs = 24 * 3_600_000): Array<{ taskId: string; projectId: string; keys: string[] }> {
  const open = OPEN_ATTEMPT_STATES.map((state) => `'${state}'`).join(",");
  const rows = db.prepare(`SELECT a.task_id AS taskId, r.project_id AS projectId, MAX(a.updated_at) AS endedAt FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
      WHERE a.state IN ('accepted','blocked','canceled') AND a.updated_at >= ? AND a.updated_at <= ?
        AND a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
        AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt o WHERE o.task_id=a.task_id AND o.state IN (${open}))
      GROUP BY a.task_id, r.project_id ORDER BY endedAt DESC LIMIT ?`).all(since, now - quietMs, limit) as Array<{ taskId: string; projectId: string }>;
  return rows.map((row) => {
    const attempts = (db.prepare("SELECT id FROM lane_pilot_attempt WHERE task_id=?").all(row.taskId) as Array<{ id: string }>).map((attempt) => attempt.id);
    const keys = [row.taskId, ...attempts].map(workerHomeKey).filter((key): key is string => key !== null);
    return { taskId: row.taskId, projectId: row.projectId, keys: [...new Set(keys)] };
  });
}

/** A project's attempt outcome texts for the history search (the execution book), newest first. */
export function listProjectAttemptReasons(db: LanePilotDatabase, projectId: string, limit = 400): Array<{ taskId: string; state: string; reason: string | null; at: number }> {
  return db.prepare(`SELECT a.task_id AS taskId, a.state, a.reason, a.updated_at AS at FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.project_id=? AND a.reason IS NOT NULL ORDER BY a.updated_at DESC LIMIT ?`)
    .all(projectId, limit) as Array<{ taskId: string; state: string; reason: string | null; at: number }>;
}

export function listOpenAttempts(db: LanePilotDatabase): Array<{
  id:string; run_id:string; task_id:string; thread_id:string|null; state:string; project_id:string; created_at?:number;
}> {
  // A retry-eligible attempt with a saved reconcile page is still in flight: its scan died mid-page and the next
  // process continues it, so it is listed with the live states (fault-injection: a spawn rejected while its scan
  // was interrupted would otherwise sit open forever).
  const open = OPEN_ATTEMPT_STATES.map(() => "?").join(",");
  const retry = RETRY_ELIGIBLE.map(() => "?").join(",");
  return db.prepare(`SELECT a.id,a.run_id,a.task_id,a.thread_id,a.state,r.project_id,a.created_at
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state IN (${open})
       OR (a.state IN (${retry})
           AND EXISTS (SELECT 1 FROM lane_pilot_reconcile_cursor c WHERE c.attempt_id=a.id))
    ORDER BY a.created_at`).all(...OPEN_ATTEMPT_STATES, ...RETRY_ELIGIBLE) as Array<{
    id:string; run_id:string; task_id:string; thread_id:string|null; state:string; project_id:string; created_at?:number;
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

