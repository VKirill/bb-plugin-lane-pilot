import type Database from "better-sqlite3";
import type { BaselineCheck, BaselineVerdict } from "../../models/logic";

export type BaselineDb = Pick<Database.Database, "prepare">;

// ---- the baseline of a task start ----

export type BaselineAfter = { at: number; mergeCommit: string | null; turnedRed: string[]; checked: number };

export type BaselineRecord = {
  id: number; at: number; projectId: string; runId: string; taskId: string; attemptId: string | null; baseSha: string | null;
  state: "ran" | "skipped" | "error"; verdict: BaselineVerdict; mode: string; action: "proceed" | "notified" | "stopped";
  summary: string; checks: BaselineCheck[]; durationMs: number; after: BaselineAfter | null;
};

type RawBaseline = {
  id: number; at: number; project_id: string; run_id: string; task_id: string; attempt_id: string | null; base_sha: string | null; state: BaselineRecord["state"];
  verdict: BaselineVerdict; mode: string; action: BaselineRecord["action"]; summary: string; checks_json: string; duration_ms: number; after_json: string | null;
};

const parse = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

const baselineFrom = (row: RawBaseline): BaselineRecord => ({
  id: row.id, at: row.at, projectId: row.project_id, runId: row.run_id, taskId: row.task_id, attemptId: row.attempt_id, baseSha: row.base_sha, state: row.state,
  verdict: row.verdict, mode: row.mode, action: row.action, summary: row.summary, checks: parse<BaselineCheck[]>(row.checks_json, []), durationMs: row.duration_ms,
  after: parse<BaselineAfter | null>(row.after_json, null),
});

export function insertBaseline(db: BaselineDb, input: Omit<BaselineRecord, "id" | "after" | "at"> & { at?: number }): number {
  const ran = db.prepare(`INSERT INTO lane_pilot_baseline(at,project_id,run_id,task_id,attempt_id,base_sha,state,verdict,mode,action,summary,checks_json,duration_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.at ?? Date.now(), input.projectId, input.runId, input.taskId, input.attemptId, input.baseSha, input.state, input.verdict, input.mode,
    input.action, input.summary.slice(0, 2000), JSON.stringify(input.checks), input.durationMs);
  return Number(ran.lastInsertRowid);
}

/** The task's latest baseline. */
export function getBaseline(db: BaselineDb, runId: string, taskId: string): BaselineRecord | undefined {
  const row = db.prepare("SELECT * FROM lane_pilot_baseline WHERE run_id=? AND task_id=? ORDER BY id DESC LIMIT 1").get(runId, taskId) as RawBaseline | undefined;
  return row ? baselineFrom(row) : undefined;
}

export function listBaselines(db: BaselineDb, taskId: string): BaselineRecord[] {
  return (db.prepare("SELECT * FROM lane_pilot_baseline WHERE task_id=? ORDER BY id").all(taskId) as RawBaseline[]).map(baselineFrom);
}

export function setBaselineAfter(db: BaselineDb, id: number, after: BaselineAfter): void {
  db.prepare("UPDATE lane_pilot_baseline SET after_json=? WHERE id=?").run(JSON.stringify(after), id);
}

/**
 * What earlier baselines of this project already learned about this base: a check's answer on a commit does not change, so a retry
 * or a sibling task starting from the same commit does not run it again. Keyed by command and folder.
 */
export function cachedChecks(db: BaselineDb, projectId: string, baseSha: string): Map<string, BaselineCheck> {
  const cache = new Map<string, BaselineCheck>();
  const rows = db.prepare("SELECT checks_json FROM lane_pilot_baseline WHERE project_id=? AND base_sha=? AND state='ran' ORDER BY id DESC LIMIT 50").all(projectId, baseSha) as Array<{ checks_json: string }>;
  for (const row of rows) {
    for (const check of parse<BaselineCheck[]>(row.checks_json, [])) {
      if (check.status !== "green" && check.status !== "red") continue;
      const key = checkKey(check.command, check.cwd);
      if (!cache.has(key)) cache.set(key, check);
    }
  }
  return cache;
}

export const checkKey = (command: string, cwd: string): string => `${cwd}\u0000${command}`;

// ---- cross-room readers ----

/** The task's baseline entries, oldest first (the task timeline's baseline lines). */
export function taskBaselineEntries(db: BaselineDb, runId: string, taskId: string): Array<{ at: number; attempt_id: string | null; verdict: string; action: string; summary: string }> {
  return db.prepare("SELECT at, attempt_id, verdict, action, summary FROM lane_pilot_baseline WHERE run_id=? AND task_id=? ORDER BY at")
    .all(runId, taskId) as Array<{ at: number; attempt_id: string | null; verdict: string; action: string; summary: string }>;
}
