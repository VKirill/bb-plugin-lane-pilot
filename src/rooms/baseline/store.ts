import type Database from "better-sqlite3";
import type { BaselineCheck, BaselineVerdict } from "./logic";

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

// ---- regressions ----

export type RegressionRecord = {
  id: number; foundAt: number; updatedAt: number; projectId: string; runId: string; taskId: string; attemptId: string | null; command: string;
  kind: "regression" | "unstable"; state: "open" | "closed"; greenAt: string | null; redAt: string | null;
  bisectStatus: "found" | "none" | "failed" | "skipped"; culpritCommit: string | null; culpritTask: string | null; culpritSubject: string | null;
  note: string | null; evidence: unknown; closedAt: number | null; closedReason: string | null;
};

type RawRegression = {
  id: number; found_at: number; updated_at: number; project_id: string; run_id: string; task_id: string; attempt_id: string | null; command: string;
  kind: RegressionRecord["kind"]; state: RegressionRecord["state"]; green_at: string | null; red_at: string | null; bisect_status: RegressionRecord["bisectStatus"];
  culprit_commit: string | null; culprit_task: string | null; culprit_subject: string | null; note: string | null; evidence_json: string; closed_at: number | null; closed_reason: string | null;
};

const regressionFrom = (row: RawRegression): RegressionRecord => ({
  id: row.id, foundAt: row.found_at, updatedAt: row.updated_at, projectId: row.project_id, runId: row.run_id, taskId: row.task_id, attemptId: row.attempt_id, command: row.command,
  kind: row.kind, state: row.state, greenAt: row.green_at, redAt: row.red_at, bisectStatus: row.bisect_status, culpritCommit: row.culprit_commit, culpritTask: row.culprit_task,
  culpritSubject: row.culprit_subject, note: row.note, evidence: parse<unknown>(row.evidence_json, {}), closedAt: row.closed_at, closedReason: row.closed_reason,
});

export type NewRegression = Omit<RegressionRecord, "id" | "foundAt" | "updatedAt" | "state" | "closedAt" | "closedReason"> & { at?: number };

export function insertRegression(db: BaselineDb, input: NewRegression): number {
  const at = input.at ?? Date.now();
  const ran = db.prepare(`INSERT INTO lane_pilot_regression(found_at,updated_at,project_id,run_id,task_id,attempt_id,command,kind,state,green_at,red_at,bisect_status,culprit_commit,culprit_task,culprit_subject,note,evidence_json)
    VALUES(?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?)`).run(at, at, input.projectId, input.runId, input.taskId, input.attemptId, input.command, input.kind, input.greenAt, input.redAt,
    input.bisectStatus, input.culpritCommit, input.culpritTask, input.culpritSubject, input.note, JSON.stringify(input.evidence ?? {}));
  return Number(ran.lastInsertRowid);
}

export function openRegression(db: BaselineDb, taskId: string, command: string): RegressionRecord | undefined {
  const row = db.prepare("SELECT * FROM lane_pilot_regression WHERE task_id=? AND command=? AND state='open'").get(taskId, command) as RawRegression | undefined;
  return row ? regressionFrom(row) : undefined;
}

export function touchRegression(db: BaselineDb, id: number, redAt: string | null, evidence: unknown, at = Date.now()): void {
  db.prepare("UPDATE lane_pilot_regression SET updated_at=?, red_at=COALESCE(?,red_at), evidence_json=? WHERE id=? AND state='open'").run(at, redAt, JSON.stringify(evidence ?? {}), id);
}

export function closeRegression(db: BaselineDb, id: number, reason: string, at = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_regression SET state='closed', closed_at=?, closed_reason=?, updated_at=? WHERE id=? AND state='open'").run(at, reason.slice(0, 500), at, id).changes > 0;
}

/**
 * A finding the PM or the owner settled by hand (the check was removed, the break was meant) stays settled while the check stays red: the
 * nightly pass does not open it again. Once the check is green, the settlement is released and a later red is a new finding.
 */
export function settledByHand(db: BaselineDb, taskId: string, command: string): RegressionRecord | undefined {
  const row = db.prepare("SELECT * FROM lane_pilot_regression WHERE task_id=? AND command=? AND state='closed' ORDER BY id DESC LIMIT 1").get(taskId, command) as RawRegression | undefined;
  const found = row ? regressionFrom(row) : undefined;
  return found && !/green again|the task was reverted/.test(found.closedReason ?? "") ? found : undefined;
}

export function releaseSettlement(db: BaselineDb, taskId: string, command: string, head: string): void {
  const settled = settledByHand(db, taskId, command);
  if (settled) db.prepare("UPDATE lane_pilot_regression SET closed_reason=? WHERE id=?").run(`${settled.closedReason ?? ""} | green again on main ${head.slice(0, 10)}`.slice(0, 500), settled.id);
}

export function getRegression(db: BaselineDb, id: number): RegressionRecord | undefined {
  const row = db.prepare("SELECT * FROM lane_pilot_regression WHERE id=?").get(id) as RawRegression | undefined;
  return row ? regressionFrom(row) : undefined;
}

export function listRegressions(db: BaselineDb, options: { projectId?: string | undefined; includeClosed?: boolean; kind?: RegressionRecord["kind"] } = {}): RegressionRecord[] {
  const where = [options.includeClosed ? "1=1" : "state='open'"];
  const params: unknown[] = [];
  if (options.projectId) { where.push("project_id=?"); params.push(options.projectId); }
  if (options.kind) { where.push("kind=?"); params.push(options.kind); }
  return (db.prepare(`SELECT * FROM lane_pilot_regression WHERE ${where.join(" AND ")} ORDER BY id`).all(...params) as RawRegression[]).map(regressionFrom);
}

// ---- passes ----

export function insertPass(db: BaselineDb, input: { projectId: string; headSha: string | null; dryRun: boolean; durationMs: number; summary: unknown; at?: number }): number {
  const ran = db.prepare("INSERT INTO lane_pilot_regress_pass(at,project_id,head_sha,dry_run,duration_ms,summary_json) VALUES(?,?,?,?,?,?)")
    .run(input.at ?? Date.now(), input.projectId, input.headSha, input.dryRun ? 1 : 0, input.durationMs, JSON.stringify(input.summary ?? {}));
  return Number(ran.lastInsertRowid);
}

export function lastPass(db: BaselineDb, projectId: string): { at: number; headSha: string | null; summary: unknown } | undefined {
  const row = db.prepare("SELECT at, head_sha, summary_json FROM lane_pilot_regress_pass WHERE project_id=? AND dry_run=0 ORDER BY id DESC LIMIT 1").get(projectId) as
    { at: number; head_sha: string | null; summary_json: string } | undefined;
  return row ? { at: row.at, headSha: row.head_sha, summary: parse<unknown>(row.summary_json, {}) } : undefined;
}
