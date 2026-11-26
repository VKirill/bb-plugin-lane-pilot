import type Database from "better-sqlite3";
import { parseJsonOr } from "@lane-pilot/kit";
import { ATTEMPT_TABLE, RUN_TABLE } from "../../../storage";
import {
  LANDING_CLAIM_STALE_MS, LANDING_SUITE_TRIES,
  type AttemptChange, type AttemptChangePatch, type ChangedFile, type LandingPending, type LandingSuite, type WorktreeRecord,
} from "../../models";

export type RollbackDb = Pick<Database.Database, "prepare">;

type Raw = {
  attempt_id: string;
  run_id: string;
  task_id: string;
  base_sha: string | null;
  merge_parent: string | null;
  merge_commit: string | null;
  outcome: string | null;
  changed_json: string;
  worktree_json: string | null;
  recorded_at: number;
  updated_at: number;
  checks_green?: number | null;
  suite_json?: string | null;
};

const json = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

const fromRaw = (row: Raw): AttemptChange => ({
  attemptId: row.attempt_id,
  runId: row.run_id,
  taskId: row.task_id,
  baseSha: row.base_sha,
  mergeParent: row.merge_parent,
  mergeCommit: row.merge_commit,
  outcome: row.outcome,
  changed: json<ChangedFile[]>(row.changed_json, []),
  worktree: json<WorktreeRecord | null>(row.worktree_json, null),
  recordedAt: row.recorded_at,
  updatedAt: row.updated_at,
  checksGreen: row.checks_green ?? null,
  suite: parseJsonOr<LandingSuite | null>(row.suite_json ?? "null", null),
});

/**
 * Writes what is known about an attempt's change. The first base an attempt gets stays (it is where the attempt started);
 * every other field is replaced when the new value is given, and kept when it is not.
 */
export function upsertAttemptChange(db: RollbackDb, attempt: { attemptId: string; runId: string; taskId: string }, patch: AttemptChangePatch, now = Date.now()): void {
  db.prepare(`INSERT INTO lane_pilot_attempt_change(attempt_id,run_id,task_id,base_sha,merge_parent,merge_commit,outcome,changed_json,worktree_json,recorded_at,updated_at,checks_green)
      VALUES(@attemptId,@runId,@taskId,@baseSha,@mergeParent,@mergeCommit,@outcome,COALESCE(@changed,'[]'),@worktree,@now,@now,@checksGreen)
    ON CONFLICT(attempt_id) DO UPDATE SET
      base_sha=COALESCE(lane_pilot_attempt_change.base_sha,excluded.base_sha),
      merge_parent=COALESCE(excluded.merge_parent,lane_pilot_attempt_change.merge_parent),
      merge_commit=COALESCE(excluded.merge_commit,lane_pilot_attempt_change.merge_commit),
      outcome=COALESCE(excluded.outcome,lane_pilot_attempt_change.outcome),
      changed_json=CASE WHEN @changed IS NULL THEN lane_pilot_attempt_change.changed_json ELSE excluded.changed_json END,
      worktree_json=COALESCE(excluded.worktree_json,lane_pilot_attempt_change.worktree_json),
      checks_green=COALESCE(excluded.checks_green,lane_pilot_attempt_change.checks_green),
      updated_at=excluded.updated_at`).run({
    ...attempt,
    baseSha: patch.baseSha ?? null,
    mergeParent: patch.mergeParent ?? null,
    mergeCommit: patch.mergeCommit ?? null,
    outcome: patch.outcome ?? null,
    changed: patch.changed ? JSON.stringify(patch.changed.slice(0, 5000)) : null,
    worktree: patch.worktree ? JSON.stringify(patch.worktree) : null,
    checksGreen: patch.checksGreen ?? null,
    now,
  });
}

export function getAttemptChange(db: RollbackDb, attemptId: string): AttemptChange | undefined {
  const row = db.prepare("SELECT * FROM lane_pilot_attempt_change WHERE attempt_id=?").get(attemptId) as Raw | undefined;
  return row ? fromRaw(row) : undefined;
}

export function listAttemptChanges(db: RollbackDb, taskId: string): AttemptChange[] {
  return (db.prepare("SELECT * FROM lane_pilot_attempt_change WHERE task_id=? ORDER BY recorded_at, attempt_id").all(taskId) as Raw[]).map(fromRaw);
}

/** Reads minimal attempt fields needed to classify recovery state without requiring every column of the attempt row. */
export function readAttemptRecoveryRow(db: RollbackDb, attemptId: string): { state: string; reason: string | null; task_id: string } | undefined {
  return db.prepare(`SELECT state, reason, task_id FROM ${ATTEMPT_TABLE} WHERE id=?`).get(attemptId) as { state: string; reason: string | null; task_id: string } | undefined;
}

// ---- cross-room readers: the change ledger other rooms may only read through these ----

/** Merged change rows of a run (a redo family's earlier members' file lists). */
export function mergedAttemptChanges(db: RollbackDb, runId: string): Array<{ task_id: string; changed_json: string }> {
  return db.prepare("SELECT task_id, changed_json FROM lane_pilot_attempt_change WHERE run_id=? AND outcome='merged'")
    .all(runId) as Array<{ task_id: string; changed_json: string }>;
}

/** Merge commits of a run's accepted attempts (the phase's proof-of-work records). Outcome is exposed so start-time readers can
 * distinguish an active accepted merge from one historically accepted and later reverted; the historical row itself remains. */
export function acceptedChangeProofRows(db: RollbackDb, runId: string): Array<{ task_id: string; merge_commit: string; changed_json: string; outcome: string | null }> {
  return db.prepare(`SELECT c.task_id AS task_id, c.merge_commit AS merge_commit, c.changed_json AS changed_json, c.outcome AS outcome FROM lane_pilot_attempt_change c
    JOIN ${ATTEMPT_TABLE} a ON a.id=c.attempt_id WHERE c.run_id=? AND a.state='accepted' AND c.merge_commit IS NOT NULL ORDER BY a.updated_at, a.rowid`)
    .all(runId) as Array<{ task_id: string; merge_commit: string; changed_json: string; outcome: string | null }>;
}

/** Dependency admission's provenance-preserving view. It includes rows whose change and attempt ledgers disagree so callers can
 * refuse them; filtering those rows here would make the intentional no-merge exception fail open. */
export function dependencyChangeProofRows(db: RollbackDb, runId: string): Array<{ run_id: string; task_id: string; merge_commit: string; changed_json: string; outcome: string | null; attempt_run_id: string; attempt_task_id: string }> {
  return db.prepare(`SELECT c.run_id AS run_id, c.task_id AS task_id, c.merge_commit AS merge_commit, c.changed_json AS changed_json, c.outcome AS outcome,
    a.run_id AS attempt_run_id, a.task_id AS attempt_task_id FROM lane_pilot_attempt_change c
    JOIN ${ATTEMPT_TABLE} a ON a.id=c.attempt_id WHERE (c.run_id=? OR a.run_id=?) AND a.state='accepted' AND c.merge_commit IS NOT NULL ORDER BY a.updated_at, a.rowid`)
    .all(runId, runId) as Array<{ run_id: string; task_id: string; merge_commit: string; changed_json: string; outcome: string | null; attempt_run_id: string; attempt_task_id: string }>;
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

/** An attempt change's raw changed_json (the forecast report counts the files itself). */
export function attemptChangeJson(db: RollbackDb, attemptId: string): string | undefined {
  return (db.prepare("SELECT changed_json FROM lane_pilot_attempt_change WHERE attempt_id=?").get(attemptId) as { changed_json: string } | undefined)?.changed_json;
}

/**
 * Merged landings the suite sweep may take now (SMA k_lib_landing): recorded after `since` (the sweep's first pass on this
 * install — history is never swept), newest first, at most `limit`. A row is free when it has no verdict, when its
 * `error` verdict has tries left, or when its `running` claim is stale.
 */
export function listLandingSuitePending(db: RollbackDb, since: number, limit = 4, now = Date.now()): LandingPending[] {
  const rows = db.prepare(`SELECT attempt_id, run_id, task_id, merge_commit, suite_json FROM lane_pilot_attempt_change
    WHERE outcome='merged' AND recorded_at>? AND (suite_json IS NULL OR suite_json LIKE '%"running"%' OR suite_json LIKE '%"error"%')
    ORDER BY recorded_at DESC LIMIT 200`).all(since) as Array<{ attempt_id: string; run_id: string; task_id: string; merge_commit: string | null; suite_json: string | null }>;
  const free: LandingPending[] = [];
  for (const row of rows) {
    const suite = row.suite_json === null ? null : parseJsonOr<LandingSuite | null>(row.suite_json, null);
    if (row.suite_json !== null && !suite) continue;
    const tries = suite?.tries ?? 0;
    const open = !suite || (suite.suite === "running" && now - suite.at >= LANDING_CLAIM_STALE_MS && tries < LANDING_SUITE_TRIES)
      || (suite.suite === "error" && typeof suite.tries === "number" && tries < LANDING_SUITE_TRIES);
    if (!open) continue;
    free.push({
      attemptId: row.attempt_id,
      runId: row.run_id,
      taskId: row.task_id,
      mergeCommit: row.merge_commit,
      // A lost claim counts as a lost run.
      tries: suite?.suite === "running" ? tries + 1 : tries,
      raw: row.suite_json,
    });
    if (free.length >= limit) break;
  }
  return free;
}

/** Takes a row for one pass: the write succeeds only while suite_json is still what the pass read, so a second pass skips it. */
export function claimLandingSuite(db: RollbackDb, pending: Pick<LandingPending, "attemptId" | "raw" | "tries">, now = Date.now(), head: string | null = null): boolean {
  const claim: LandingSuite = { suite: "running", head, at: now, tries: pending.tries };
  const where = pending.raw === null ? "suite_json IS NULL" : "suite_json=?";
  const args = pending.raw === null ? [JSON.stringify(claim), now, pending.attemptId] : [JSON.stringify(claim), now, pending.attemptId, pending.raw];
  return db.prepare(`UPDATE lane_pilot_attempt_change SET suite_json=?, updated_at=? WHERE attempt_id=? AND ${where}`).run(...args).changes === 1;
}

/** The sweep's verdict on the change row: suite_json, never a write into the project's repository. */
export function noteLandingSuite(db: RollbackDb, attemptId: string, suite: LandingSuite): void {
  db.prepare("UPDATE lane_pilot_attempt_change SET suite_json=?, updated_at=? WHERE attempt_id=?").run(JSON.stringify(suite), Date.now(), attemptId);
}
