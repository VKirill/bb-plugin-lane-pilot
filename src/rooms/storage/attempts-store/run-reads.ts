import type { LanePilotDatabase } from "../database";

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

export function listAcceptedJoinRows(db: LanePilotDatabase, input: { since: number; until: number; projectId?: string | null }): Array<{ attemptId: string; taskId: string; projectId: string; hostId: string | null; workspace: string | null; contract: string }> {
  return db.prepare(`SELECT a.id AS attemptId, a.task_id AS taskId, r.project_id AS projectId, r.writer_host_id AS hostId, r.writer_workspace_path AS workspace,
      t.contract_json AS contract
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id = a.run_id JOIN lane_pilot_task t ON t.id = a.task_id
    WHERE a.state = 'accepted' AND a.updated_at >= ? AND a.updated_at < ? AND (? IS NULL OR r.project_id = ?)`)
    .all(input.since, input.until, input.projectId ?? null, input.projectId ?? null) as
    Array<{ attemptId: string; taskId: string; projectId: string; hostId: string | null; workspace: string | null; contract: string }>;
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

export function listAttemptTracesForRun(db: LanePilotDatabase, runId: string): Array<{ trace: string | null }> {
  return db.prepare(`SELECT t.trace_json AS trace FROM lane_pilot_attempt a
    LEFT JOIN lane_pilot_attempt_reasoning t ON t.attempt_id=a.id WHERE a.run_id=?`).all(runId) as Array<{ trace: string | null }>;
}

export function listAttemptIdsInStates(db: LanePilotDatabase, runId: string, taskId: string, states: readonly string[]): Array<{ id: string }> {
  return db.prepare(`SELECT id FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND state IN (${states.map(() => "?").join(",")})`)
    .all(runId, taskId, ...states) as Array<{ id: string }>;
}

export function countHarnessArmAttempts(db: LanePilotDatabase, since: number, treeIds: readonly [string, string]): number {
  return (db.prepare("SELECT count(*) AS n FROM lane_pilot_attempt WHERE harness_arm IN ('new','old') AND created_at>=? AND harness_tree_id IN (?,?)")
    .get(since, treeIds[0], treeIds[1]) as { n: number }).n;
}

export function attemptHarnessTreeId(db: LanePilotDatabase, attemptId: string): string | null {
  return (db.prepare("SELECT harness_tree_id AS id FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { id: string | null } | undefined)?.id ?? null;
}

export function latestAttemptIdForThread(db: LanePilotDatabase, runId: string, taskId: string, threadId: string): string | null {
  return (db.prepare("SELECT id FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND thread_id=? ORDER BY created_at DESC LIMIT 1")
    .get(runId, taskId, threadId) as { id: string } | undefined)?.id ?? null;
}

export function listAttemptEvidenceRows(db: LanePilotDatabase, input: { projectId: string; sinceMs: number; area: string; writerKey: string; attemptIds?: readonly string[]; limit: number }): Array<{
  id: string; taskId: string; attemptNo: number; state: string; reason: string | null; createdAt: number; threadId: string | null; runId: string; contract: string | null; trace: string | null;
}> {
  const ids = input.attemptIds?.length ? `AND a.id IN (${input.attemptIds.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT a.id, a.task_id AS taskId, a.attempt_no AS attemptNo, a.state, a.reason, a.created_at AS createdAt, a.thread_id AS threadId, a.run_id AS runId,
      t.contract_json AS contract, x.trace_json AS trace
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id JOIN lane_pilot_task t ON t.id=a.task_id LEFT JOIN lane_pilot_attempt_reasoning x ON x.attempt_id=a.id
    WHERE r.project_id=? AND a.created_at>=? AND a.task_id NOT LIKE 'drill-%' AND a.state IN ('accepted','blocked','validation_failed','empty_output')
      AND COALESCE(json_extract(t.contract_json,'$.area'),'')=?
      AND (?='*' OR COALESCE(json_extract(x.trace_json,'$.dispatchContext.writerKey'),'*') IN (?, '*'))
      ${ids}
    ORDER BY a.created_at DESC LIMIT ?`)
    .all(input.projectId, input.sinceMs, input.area, input.writerKey, input.writerKey, ...(input.attemptIds ?? []), input.limit) as
    Array<{ id: string; taskId: string; attemptNo: number; state: string; reason: string | null; createdAt: number; threadId: string | null; runId: string; contract: string | null; trace: string | null }>;
}

export function listTeachingKeys(db: LanePilotDatabase, projectId: string, since: number, minAttempts: number, minSpanMs: number): Array<{ area: string; writerKey: string; attempts: number }> {
  const rows = db.prepare(`SELECT COALESCE(json_extract(t.contract_json,'$.area'),'') AS area,
      COALESCE(json_extract(x.trace_json,'$.dispatchContext.writerKey'), '*') AS writerKey, count(*) AS attempts, max(a.created_at) AS last
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id JOIN lane_pilot_task t ON t.id=a.task_id
    LEFT JOIN lane_pilot_attempt_reasoning x ON x.attempt_id=a.id
    WHERE r.project_id=? AND a.created_at>=? AND a.task_id NOT LIKE 'drill-%' AND a.state IN ('accepted','blocked','validation_failed','empty_output')
    GROUP BY 1,2 HAVING count(*)>=? AND max(a.created_at)-min(a.created_at)>=? ORDER BY last DESC`).all(projectId, since, minAttempts, minSpanMs) as
    Array<{ area: string; writerKey: string; attempts: number }>;
  return rows.map((row) => ({ area: row.area ?? "", writerKey: row.writerKey ?? "*", attempts: row.attempts }));
}

export function assignAttemptHarness(db: LanePilotDatabase, attemptId: string, harnessId: string, arm: "new" | "old" | null): void {
  db.prepare("UPDATE lane_pilot_attempt SET harness_tree_id=?, harness_arm=? WHERE id=?").run(harnessId, arm, attemptId);
}

export function listHarnessTrialAttempts(db: LanePilotDatabase, input: { since: number; trialId: string; parentId: string | null }): Array<{ attemptId: string; taskId: string; state: string; attemptNo: number; arm: "new" | "old"; createdAt: number; runId: string }> {
  return db.prepare(`SELECT a.id AS attemptId, a.task_id AS taskId, a.state, a.attempt_no AS attemptNo, a.harness_arm AS arm, a.created_at AS createdAt, a.run_id AS runId
    FROM lane_pilot_attempt a WHERE a.created_at>=? AND ((a.harness_tree_id=? AND a.harness_arm='new') OR (a.harness_tree_id=? AND a.harness_arm='old'))
    ORDER BY a.created_at`).all(input.since, input.trialId, input.parentId ?? "") as
    Array<{ attemptId: string; taskId: string; state: string; attemptNo: number; arm: "new" | "old"; createdAt: number; runId: string }>;
}
