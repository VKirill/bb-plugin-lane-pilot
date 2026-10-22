import type Database from "better-sqlite3";
import type { ReturnStage } from "@lane-pilot/contracts";

export type StageReturnDb = Pick<Database.Database, "prepare">;

export type ReturnState = "requested" | "restarted" | "handed_to_pm" | "failed";

export type StageReturnRecord = {
  id: string; at: number; projectId: string; runId: string; taskId: string; attemptId: string | null;
  to: ReturnStage; from: string | null; by: string; note: string;
  reused: string[]; stale: Array<{ stage: string; why: string }>;
  paused: string | null; state: ReturnState; detail: string | null; doneAt: number | null;
};

type Raw = {
  id: string; at: number; project_id: string; run_id: string; task_id: string; attempt_id: string | null; to_stage: ReturnStage; from_stage: string | null;
  by: string; note: string; reused_json: string; stale_json: string; paused: string | null; state: ReturnState; detail: string | null; done_at: number | null;
};

const parse = <T>(text: string, fallback: T): T => { try { return JSON.parse(text) as T; } catch { return fallback; } };

const recordOf = (row: Raw): StageReturnRecord => ({
  id: row.id, at: row.at, projectId: row.project_id, runId: row.run_id, taskId: row.task_id, attemptId: row.attempt_id, to: row.to_stage, from: row.from_stage,
  by: row.by, note: row.note, reused: parse<string[]>(row.reused_json, []), stale: parse<Array<{ stage: string; why: string }>>(row.stale_json, []),
  paused: row.paused, state: row.state, detail: row.detail, doneAt: row.done_at,
});

export function insertReturn(db: StageReturnDb, row: Omit<StageReturnRecord, "doneAt" | "detail" | "paused" | "state"> & { state?: ReturnState }): void {
  db.prepare(`INSERT INTO lane_pilot_stage_return(id,at,project_id,run_id,task_id,attempt_id,to_stage,from_stage,by,note,reused_json,stale_json,state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.at, row.projectId, row.runId, row.taskId, row.attemptId, row.to, row.from, row.by, row.note,
    JSON.stringify(row.reused), JSON.stringify(row.stale), row.state ?? "requested");
}

export function finishReturn(db: StageReturnDb, id: string, patch: { state: ReturnState; paused?: string | null; detail?: string | null; attemptId?: string | null }): void {
  db.prepare("UPDATE lane_pilot_stage_return SET state=?, paused=COALESCE(?,paused), detail=?, attempt_id=COALESCE(?,attempt_id), done_at=? WHERE id=?")
    .run(patch.state, patch.paused ?? null, patch.detail?.slice(0, 1000) ?? null, patch.attemptId ?? null, Date.now(), id);
}

export function listReturns(db: StageReturnDb, runId: string, taskId: string): StageReturnRecord[] {
  return (db.prepare("SELECT * FROM lane_pilot_stage_return WHERE run_id=? AND task_id=? ORDER BY at, rowid").all(runId, taskId) as Raw[]).map(recordOf);
}

export function getReturn(db: StageReturnDb, id: string): StageReturnRecord | undefined {
  const row = db.prepare("SELECT * FROM lane_pilot_stage_return WHERE id=?").get(id) as Raw | undefined;
  return row ? recordOf(row) : undefined;
}
