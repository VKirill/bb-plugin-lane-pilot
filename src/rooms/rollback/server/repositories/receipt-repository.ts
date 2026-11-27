import type Database from "better-sqlite3";
import { getAttempt, getRun } from "../../../storage";
import { isSha, type RevertSettlement, type TaskReceipt, type TaskReceiptKind, type TaskReceiptState } from "../../models";
import { getAttemptChange, upsertAttemptChange, type RollbackDb } from "./attempt-change-repository";

export function appendTaskReceipt(db: RollbackDb, input: Omit<TaskReceipt, "id" | "at"> & { at?: number }): number {
  const ran = db.prepare(`INSERT INTO lane_pilot_task_receipt(at,kind,project_id,run_id,task_id,attempt_id,base_sha,change_sha,result_commit,state,summary,detail_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.at ?? Date.now(),
    input.kind,
    input.projectId,
    input.runId,
    input.taskId,
    input.attemptId,
    input.baseSha,
    input.changeSha,
    input.resultCommit,
    input.state,
    input.summary.slice(0, 2000),
    JSON.stringify(input.detail ?? {}),
  );
  return Number(ran.lastInsertRowid);
}

type RawReceipt = {
  id: number;
  at: number;
  kind: TaskReceiptKind;
  project_id: string;
  run_id: string;
  task_id: string;
  attempt_id: string | null;
  base_sha: string | null;
  change_sha: string | null;
  result_commit: string | null;
  state: TaskReceiptState;
  summary: string;
  detail_json: string;
};

const json = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

export function listTaskReceipts(db: RollbackDb, taskId: string, kind?: TaskReceiptKind): TaskReceipt[] {
  const rows = (kind
    ? db.prepare("SELECT * FROM lane_pilot_task_receipt WHERE task_id=? AND kind=? ORDER BY id").all(taskId, kind)
    : db.prepare("SELECT * FROM lane_pilot_task_receipt WHERE task_id=? ORDER BY id").all(taskId)) as RawReceipt[];
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    kind: row.kind,
    projectId: row.project_id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    baseSha: row.base_sha,
    changeSha: row.change_sha,
    resultCommit: row.result_commit,
    state: row.state,
    summary: row.summary,
    detail: json<unknown>(row.detail_json, {}),
  }));
}

/** Counts settled (`state='merged'`) revert receipts for a project since `sinceMs`. */
export function countRevertReceiptsSince(db: RollbackDb, projectId: string, sinceMs: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM lane_pilot_task_receipt WHERE project_id=? AND kind='revert' AND state='merged' AND at>=?")
    .get(projectId, sinceMs) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/** The receipt and all compensation outcomes become one SQLite commit. The intent is cleared only after this returns. */
export function settleRevert(db: RollbackDb, input: RevertSettlement): number {
  const settle = (db as Database.Database).transaction(() => {
    const commits = input.changeSha.split(",");
    if (commits.length !== input.attemptIds.length || commits.some((commit) => !isSha(commit))) {
      throw new Error("revert change provenance is malformed");
    }
    for (const [index, attemptId] of input.attemptIds.entries()) {
      const actual = getAttempt(db as never, attemptId);
      const run = actual ? getRun(db as never, actual.run_id) : undefined;
      const attempt = getAttemptChange(db, attemptId);
      if (!actual || actual.state !== "accepted" || actual.run_id !== input.runId || actual.task_id !== input.taskId || !run || run.project_id !== input.projectId
        || !attempt || attempt.runId !== input.runId || attempt.taskId !== input.taskId || attempt.mergeCommit !== commits[index] || attempt.outcome !== "merged") {
        throw new Error(`revert attempt ${attemptId} no longer matches its accepted change intent`);
      }
    }
    const id = appendTaskReceipt(db, {
      kind: "revert",
      projectId: input.projectId,
      runId: input.runId,
      taskId: input.taskId,
      state: "merged",
      summary: input.summary,
      attemptId: input.attemptIds[0] ?? null,
      baseSha: input.baseSha,
      changeSha: input.changeSha,
      resultCommit: input.resultCommit,
      detail: input.detail,
    });
    for (const attemptId of input.attemptIds) {
      const row = getAttemptChange(db, attemptId)!;
      upsertAttemptChange(db, { attemptId, runId: row.runId, taskId: row.taskId }, { outcome: "reverted" });
    }
    return id;
  });
  return settle();
}
