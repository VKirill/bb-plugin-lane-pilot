import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ResultRow } from "./score";
import type { CheckerId, DefectClass, Outcome } from "./types";

export type CheckerDb = Pick<Database.Database, "prepare" | "transaction">;

export type CheckerRun = { id: string; source: string; state: "running" | "done" | "stopped_budget" | "failed"; config: Record<string, unknown>; spentTokens: number; startedAt: number; finishedAt: number | null };
export type StoredRow = ResultRow & { summary: string };

type RunRow = { id: string; source: string; state: CheckerRun["state"]; config_json: string; spent_tokens: number; started_at: number; finished_at: number | null };
const runFrom = (row: RunRow): CheckerRun => ({ id: row.id, source: row.source, state: row.state, config: JSON.parse(row.config_json) as Record<string, unknown>, spentTokens: row.spent_tokens, startedAt: row.started_at, finishedAt: row.finished_at });

export function startRun(db: CheckerDb, input: { source: string; config: Record<string, unknown>; now?: number }): CheckerRun {
  const run: CheckerRun = { id: `chk_${randomUUID().slice(0, 12)}`, source: input.source, state: "running", config: input.config, spentTokens: 0, startedAt: input.now ?? Date.now(), finishedAt: null };
  db.prepare("INSERT INTO lane_pilot_checker_run(id,source,state,config_json,spent_tokens,started_at) VALUES(?,?,?,?,?,?)").run(run.id, run.source, run.state, JSON.stringify(run.config), 0, run.startedAt);
  return run;
}

export function saveRow(db: CheckerDb, runId: string, row: StoredRow, now = Date.now()): void {
  db.prepare(`INSERT OR REPLACE INTO lane_pilot_checker_result(run_id,defect_id,task_id,defect_class,checker,outcome,flagged,expected,summary,detail,tokens,cost_usd,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, row.defectId, row.taskId, row.defectClass, row.checker, row.outcome, row.flagged ? 1 : 0, row.expected ? 1 : 0, row.summary, row.detail.slice(0, 600), row.tokens, row.costUsd, now);
}

export function finishRun(db: CheckerDb, runId: string, state: CheckerRun["state"], spentTokens: number, now = Date.now()): void {
  db.prepare("UPDATE lane_pilot_checker_run SET state=?, spent_tokens=?, finished_at=? WHERE id=?").run(state, spentTokens, now, runId);
}

export function getRun(db: CheckerDb, id: string): CheckerRun | null {
  const row = db.prepare("SELECT * FROM lane_pilot_checker_run WHERE id=?").get(id) as RunRow | undefined;
  return row ? runFrom(row) : null;
}

export function latestRun(db: CheckerDb, source?: string): CheckerRun | null {
  const row = (source
    ? db.prepare("SELECT * FROM lane_pilot_checker_run WHERE source=? AND state<>'running' ORDER BY started_at DESC LIMIT 1").get(source)
    : db.prepare("SELECT * FROM lane_pilot_checker_run WHERE state<>'running' ORDER BY started_at DESC LIMIT 1").get()) as RunRow | undefined;
  return row ? runFrom(row) : null;
}

export function listRuns(db: CheckerDb, limit = 20): CheckerRun[] {
  return (db.prepare("SELECT * FROM lane_pilot_checker_run ORDER BY started_at DESC LIMIT ?").all(limit) as RunRow[]).map(runFrom);
}

type ResultDbRow = { defect_id: string; task_id: string; defect_class: string; checker: string; outcome: string; flagged: number; expected: number; summary: string; detail: string; tokens: number | null; cost_usd: number | null };

export function listRows(db: CheckerDb, runId: string): StoredRow[] {
  return (db.prepare("SELECT * FROM lane_pilot_checker_result WHERE run_id=? ORDER BY task_id, defect_id, checker").all(runId) as ResultDbRow[]).map((row) => ({
    defectId: row.defect_id, taskId: row.task_id, defectClass: row.defect_class as DefectClass | "control", checker: row.checker as CheckerId, outcome: row.outcome as Outcome,
    flagged: row.flagged === 1, expected: row.expected === 1, summary: row.summary, detail: row.detail, tokens: row.tokens, costUsd: row.cost_usd,
  }));
}
