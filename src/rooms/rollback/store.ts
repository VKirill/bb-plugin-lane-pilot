import type Database from "better-sqlite3";
import { parseJsonOr } from "@lane-pilot/kit";
import { TASK_SIZE_MIN_SAMPLE, type TaskSizeMedian } from "../tasks";
import { ATTEMPT_TABLE, RUN_TABLE } from "../storage";

export type RollbackDb = Pick<Database.Database, "prepare">;

/** One file an attempt changed: A added, M modified, D deleted, T type changed. */
export type ChangedFile = { path: string; status: string };

/** What an attempt's worktree held when a stop was confirmed or the worktree was returned. */
export type WorktreeRecord = { head: string | null; dirty: number; ahead: number; savedAs: string | null; at: number };

export type AttemptChange = {
  attemptId: string; runId: string; taskId: string;
  baseSha: string | null; mergeParent: string | null; mergeCommit: string | null; outcome: string | null;
  changed: ChangedFile[]; worktree: WorktreeRecord | null; recordedAt: number; updatedAt: number;
};

type Raw = {
  attempt_id: string; run_id: string; task_id: string; base_sha: string | null; merge_parent: string | null; merge_commit: string | null; outcome: string | null;
  changed_json: string; worktree_json: string | null; recorded_at: number; updated_at: number;
};

const json = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

const fromRaw = (row: Raw): AttemptChange => ({
  attemptId: row.attempt_id, runId: row.run_id, taskId: row.task_id, baseSha: row.base_sha, mergeParent: row.merge_parent, mergeCommit: row.merge_commit,
  outcome: row.outcome, changed: json<ChangedFile[]>(row.changed_json, []), worktree: json<WorktreeRecord | null>(row.worktree_json, null),
  recordedAt: row.recorded_at, updatedAt: row.updated_at,
});

export type AttemptChangePatch = {
  baseSha?: string | null | undefined; mergeParent?: string | null | undefined; mergeCommit?: string | null | undefined; outcome?: string | undefined;
  changed?: ChangedFile[] | undefined; worktree?: WorktreeRecord | undefined;
};

/**
 * Writes what is known about an attempt's change. The first base an attempt gets stays (it is where the attempt started);
 * every other field is replaced when the new value is given, and kept when it is not.
 */
export function upsertAttemptChange(db: RollbackDb, attempt: { attemptId: string; runId: string; taskId: string }, patch: AttemptChangePatch, now = Date.now()): void {
  db.prepare(`INSERT INTO lane_pilot_attempt_change(attempt_id,run_id,task_id,base_sha,merge_parent,merge_commit,outcome,changed_json,worktree_json,recorded_at,updated_at)
      VALUES(@attemptId,@runId,@taskId,@baseSha,@mergeParent,@mergeCommit,@outcome,COALESCE(@changed,'[]'),@worktree,@now,@now)
    ON CONFLICT(attempt_id) DO UPDATE SET
      base_sha=COALESCE(lane_pilot_attempt_change.base_sha,excluded.base_sha),
      merge_parent=COALESCE(excluded.merge_parent,lane_pilot_attempt_change.merge_parent),
      merge_commit=COALESCE(excluded.merge_commit,lane_pilot_attempt_change.merge_commit),
      outcome=COALESCE(excluded.outcome,lane_pilot_attempt_change.outcome),
      changed_json=CASE WHEN @changed IS NULL THEN lane_pilot_attempt_change.changed_json ELSE excluded.changed_json END,
      worktree_json=COALESCE(excluded.worktree_json,lane_pilot_attempt_change.worktree_json),
      updated_at=excluded.updated_at`).run({
    ...attempt, baseSha: patch.baseSha ?? null, mergeParent: patch.mergeParent ?? null, mergeCommit: patch.mergeCommit ?? null, outcome: patch.outcome ?? null,
    changed: patch.changed ? JSON.stringify(patch.changed.slice(0, 5000)) : null, worktree: patch.worktree ? JSON.stringify(patch.worktree) : null, now,
  });
}

export function getAttemptChange(db: RollbackDb, attemptId: string): AttemptChange | undefined {
  const row = db.prepare("SELECT * FROM lane_pilot_attempt_change WHERE attempt_id=?").get(attemptId) as Raw | undefined;
  return row ? fromRaw(row) : undefined;
}

export function listAttemptChanges(db: RollbackDb, taskId: string): AttemptChange[] {
  return (db.prepare("SELECT * FROM lane_pilot_attempt_change WHERE task_id=? ORDER BY recorded_at, attempt_id").all(taskId) as Raw[]).map(fromRaw);
}

export type TaskReceiptKind = "reverify" | "revert";
export type TaskReceiptState = "passed" | "failed" | "merged" | "dry_run" | "refused" | "error";

export type TaskReceipt = {
  id: number; at: number; kind: TaskReceiptKind; projectId: string; runId: string; taskId: string; attemptId: string | null;
  baseSha: string | null; changeSha: string | null; resultCommit: string | null; state: TaskReceiptState; summary: string; detail: unknown;
};

export function appendTaskReceipt(db: RollbackDb, input: Omit<TaskReceipt, "id" | "at"> & { at?: number }): number {
  const ran = db.prepare(`INSERT INTO lane_pilot_task_receipt(at,kind,project_id,run_id,task_id,attempt_id,base_sha,change_sha,result_commit,state,summary,detail_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.at ?? Date.now(), input.kind, input.projectId, input.runId, input.taskId, input.attemptId, input.baseSha, input.changeSha,
    input.resultCommit, input.state, input.summary.slice(0, 2000), JSON.stringify(input.detail ?? {}));
  return Number(ran.lastInsertRowid);
}

type RawReceipt = {
  id: number; at: number; kind: TaskReceiptKind; project_id: string; run_id: string; task_id: string; attempt_id: string | null; base_sha: string | null;
  change_sha: string | null; result_commit: string | null; state: TaskReceiptState; summary: string; detail_json: string;
};

export function listTaskReceipts(db: RollbackDb, taskId: string, kind?: TaskReceiptKind): TaskReceipt[] {
  const rows = (kind
    ? db.prepare("SELECT * FROM lane_pilot_task_receipt WHERE task_id=? AND kind=? ORDER BY id").all(taskId, kind)
    : db.prepare("SELECT * FROM lane_pilot_task_receipt WHERE task_id=? ORDER BY id").all(taskId)) as RawReceipt[];
  return rows.map((row) => ({
    id: row.id, at: row.at, kind: row.kind, projectId: row.project_id, runId: row.run_id, taskId: row.task_id, attemptId: row.attempt_id, baseSha: row.base_sha,
    changeSha: row.change_sha, resultCommit: row.result_commit, state: row.state, summary: row.summary, detail: json<unknown>(row.detail_json, {}),
  }));
}

// ---- cross-room readers: the change ledger other rooms may only read through these ----

/** Merged change rows of a run (a redo family's earlier members' file lists). */
export function mergedAttemptChanges(db: RollbackDb, runId: string): Array<{ task_id: string; changed_json: string }> {
  return db.prepare("SELECT task_id, changed_json FROM lane_pilot_attempt_change WHERE run_id=? AND outcome='merged'")
    .all(runId) as Array<{ task_id: string; changed_json: string }>;
}

/** Merge commits of a run's accepted attempts (the phase's proof-of-work records). */
export function acceptedChangeProofRows(db: RollbackDb, runId: string): Array<{ task_id: string; merge_commit: string; changed_json: string }> {
  return db.prepare(`SELECT c.task_id AS task_id, c.merge_commit AS merge_commit, c.changed_json AS changed_json FROM lane_pilot_attempt_change c
    JOIN ${ATTEMPT_TABLE} a ON a.id=c.attempt_id WHERE c.run_id=? AND a.state='accepted' AND c.merge_commit IS NOT NULL ORDER BY a.updated_at, a.rowid`)
    .all(runId) as Array<{ task_id: string; merge_commit: string; changed_json: string }>;
}

/** Accepted attempts' size evidence (created, finished, changed files, attempt count) for the median task size. */
export function acceptedAttemptSizeRows(db: RollbackDb, projectId: string): Array<{ created: number | null; finished: number; changed: string; attempts: number }> {
  return db.prepare(
    `SELECT a.created_at AS created, a.updated_at AS finished, c.changed_json AS changed,
       (SELECT count(*) FROM ${ATTEMPT_TABLE} x WHERE x.task_id=a.task_id) AS attempts
     FROM ${ATTEMPT_TABLE} a JOIN lane_pilot_attempt_change c ON c.attempt_id=a.id
     JOIN ${RUN_TABLE} r ON r.id=a.run_id
     WHERE a.state='accepted' AND r.project_id=? ORDER BY a.updated_at DESC LIMIT 200`,
  ).all(projectId) as Array<{ created: number | null; finished: number; changed: string; attempts: number }>;
}

/**
 * The median accepted-task size of the project, from `lane_pilot_attempt` joins `lane_pilot_attempt_change`
 * (accepted attempts only, finished last). Null under TASK_SIZE_MIN_SAMPLE: too few accepted tasks to judge a grain.
 */
export function medianTaskSize(db: RollbackDb, projectId: string): TaskSizeMedian | null {
  const rows = acceptedAttemptSizeRows(db, projectId);
  if (rows.length < TASK_SIZE_MIN_SAMPLE) return null;
  const files: number[] = [], minutes: number[] = [], attempts: number[] = [];
  for (const row of rows) {
    const changed = parseJsonOr(row.changed, []) as Array<{ path: string }>;
    files.push(changed.length);
    attempts.push(Math.max(1, row.attempts));
    if (row.created != null) minutes.push(Math.max(0, Math.round((row.finished - row.created) / 60_000)));
  }
  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
  };
  return { files: median(files), lines: 0, minutes: minutes.length ? median(minutes) : 0, attempts: median(attempts), n: rows.length };
/** An attempt change's raw changed_json (the forecast report counts the files itself). */
export function attemptChangeJson(db: RollbackDb, attemptId: string): string | undefined {
  return (db.prepare("SELECT changed_json FROM lane_pilot_attempt_change WHERE attempt_id=?").get(attemptId) as { changed_json: string } | undefined)?.changed_json;
}
