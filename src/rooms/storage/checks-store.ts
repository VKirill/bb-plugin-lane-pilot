import { isAbsolute, relative, resolve } from "node:path";
import { sha256Hex } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "./database";

const CHECK_DURATION_KEPT = 100;

export type SecretIssuance = {
  id: number; at: number; projectId: string; runId: string | null; taskId: string | null; consumer: string; threadId: string | null;
  checkCommand: string | null; secretName: string; hostId: string | null; network: string | null;
};

/**
 * One Env Catalog name handed to a consumer: a check of a task (`check`, the value goes into its sandbox), or access a
 * browser check or an errand was cleared to read (`qa`, `errand`). The name only, never the value.
 */
export function recordSecretIssuance(db: LanePilotDatabase, input: {
  projectId: string; runId?: string; taskId?: string; consumer: "check" | "qa" | "errand" | "schedule"; threadId?: string; checkCommand?: string;
  secretName: string; hostId?: string; now?: number;
}): void {
  db.prepare(`INSERT INTO lane_pilot_secret_issuance(at,project_id,run_id,task_id,consumer,thread_id,check_command,secret_name,host_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(input.now ?? Date.now(), input.projectId, input.runId ?? null, input.taskId ?? null, input.consumer,
    input.threadId ?? null, input.checkCommand ? input.checkCommand.slice(0, 300) : null, input.secretName, input.hostId ?? null);
}

/** The issuance journal of a project, newest first. */
export function listSecretIssuance(db: LanePilotDatabase, projectId: string, limit = 100): SecretIssuance[] {
  return (db.prepare("SELECT * FROM lane_pilot_secret_issuance WHERE project_id=? ORDER BY at DESC, id DESC LIMIT ?").all(projectId, Math.min(500, Math.max(1, limit))) as Array<Record<string, unknown>>)
    .map((row) => ({ id: row.id as number, at: row.at as number, projectId: row.project_id as string, runId: (row.run_id as string | null) ?? null, taskId: (row.task_id as string | null) ?? null,
      consumer: row.consumer as string, threadId: (row.thread_id as string | null) ?? null, checkCommand: (row.check_command as string | null) ?? null,
      secretName: row.secret_name as string, hostId: (row.host_id as string | null) ?? null, network: (row.network as string | null) ?? null }));
}

/** A verification check as the contract names it: its command, the folder it starts in, and the project root that folder is read against (the task's project_cwd). */
export type CheckRef = { command: string; cwd: string; root?: string };

const CD_PREFIX = /^cd\s+("[^"$`\\]+"|'[^']+'|[^\s&|;<>()$`"'\\~*?]+)\s*&&\s*/;
const NO_ROOT = "/.lane-pilot-no-root";

/**
 * Where a check really runs and what it really runs: a leading `cd <dir> &&` moves into the folder (relative to the check's cwd), and the folder
 * is read relative to the project root, so a check started from another worktree of the same project is the same check. The rest of the command
 * is kept as written (only its outer whitespace goes): a quoted literal is never rewritten.
 */
export function checkIdentity(ref: CheckRef): { cwd: string; command: string } {
  const root = resolve(ref.root ?? NO_ROOT);
  let dir = resolve(root, ref.cwd);
  let command = ref.command.trim();
  for (let found = CD_PREFIX.exec(command); found; found = CD_PREFIX.exec(command)) {
    dir = resolve(dir, found[1]!.replace(/^(["'])(.*)\1$/, "$2"));
    command = command.slice(found[0].length);
  }
  const inside = relative(root, dir);
  const logical = inside === "" ? "." : inside === ".." || inside.startsWith("../") || isAbsolute(inside) ? dir : inside;
  return { cwd: logical, command: command.trim() };
}

/**
 * One check is (logical folder, command): `cd game && python3 -I scripts/studio_test.py` from the root and `python3 -I scripts/studio_test.py` from game/
 * time out alike, yet as two keys the second had no history and was killed five times at 120 s (Vampirism Fire, wc35ef88c-T1);
 * `cd appA && npm test` and `cd appB && npm test` are two checks, and so are two commands that differ inside a quoted literal.
 */
export const checkHistoryKey = (ref: CheckRef): string => { const { cwd, command } = checkIdentity(ref); return JSON.stringify([cwd, command]); };

/** Rows written before the folder joined the key were keyed by the trimmed command alone: still read, for that exact command string. */
const legacyCheckKey = (command: string): string => sha256Hex(command.trim());

/** One finished verification command run. The command is keyed by its hash: it can be long and may carry a secret name. */
export function recordCheckDuration(db: LanePilotDatabase, input: CheckRef & { projectId: string; durationMs: number; exitCode: number; now?: number }): void {
  const key = sha256Hex(checkHistoryKey(input));
  db.prepare("INSERT INTO lane_pilot_check_duration(project_id,command_key,duration_ms,exit_code,at) VALUES (?,?,?,?,?)")
    .run(input.projectId, key, Math.max(0, Math.round(input.durationMs)), input.exitCode, input.now ?? Date.now());
  db.prepare(`DELETE FROM lane_pilot_check_duration WHERE project_id=? AND command_key=? AND rowid NOT IN
    (SELECT rowid FROM lane_pilot_check_duration WHERE project_id=? AND command_key=? ORDER BY at DESC, rowid DESC LIMIT ?)`)
    .run(input.projectId, key, input.projectId, key, CHECK_DURATION_KEPT);
}

/**
 * The limits (seconds) one check timed out at in one project, newest first. A timeout is not kept in lane_pilot_check_duration
 * (it says nothing about how long the check takes), so its trace is the attempt's `failure_code`/`check_name`/`timeout_sec`
 * (live 2026-10-26, Vampirism Fire: the whole Studio suite, no timeout_sec, killed five times at 120 s).
 * The fields carry no folder, so the command is joined to the attempt's task contract: the contract's check with that command
 * string gives the folder (task level: two checks of one task with the same command at different folders count for neither);
 * a command the contract does not list is a harness check, which runs at the task root; an attempt whose task is gone cannot be
 * placed and is left out.
 */
export function listCheckTimeouts(db: LanePilotDatabase, projectId: string, check: CheckRef, limit = 20): number[] {
  const want = checkHistoryKey(check);
  const rows = db.prepare(`SELECT a.check_name AS checkName, a.timeout_sec AS timeoutSec, t.contract_json AS contract FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
      LEFT JOIN lane_pilot_task t ON t.id=a.task_id AND t.run_id=a.run_id
      WHERE r.project_id=? AND a.failure_code=? ORDER BY a.created_at DESC, a.attempt_no DESC LIMIT ?`)
    .all(projectId, "verification_timeout", limit * 10) as Array<{ checkName: string | null; timeoutSec: number | null; contract: string | null }>;
  return rows.flatMap((row) => {
    const checkName = row.checkName;
    const timeoutSec = row.timeoutSec;
    if (!checkName || timeoutSec === null || !row.contract) return [];
    let task: { project_cwd?: unknown; verification?: unknown };
    try { task = JSON.parse(row.contract) as typeof task; } catch { return []; }
    if (typeof task.project_cwd !== "string") return [];
    const root = task.project_cwd;
    const listed = (Array.isArray(task.verification) ? task.verification : [])
      .filter((entry): entry is { command: string; cwd: string } => typeof entry?.command === "string" && typeof entry?.cwd === "string" && entry.command.trim() === checkName.trim());
    const keys = new Set((listed.length ? listed : [{ command: checkName, cwd: root }]).map((entry) => checkHistoryKey({ command: entry.command, cwd: entry.cwd, root })));
    return keys.size === 1 && keys.has(want) ? [timeoutSec] : [];
  }).slice(0, limit);
}

/**
 * The last runs of one check in one project, newest first, every exit code kept. Exit 124 rows are censored durations:
 * the check was killed at its limit, so duration_ms is the timeout, not its cost — ordering and the timeout escalator
 * read them separately (checks.fail_fast, rank-12 timeout escalation).
 */
export function listCheckRuns(db: LanePilotDatabase, projectId: string, check: CheckRef, limit = 20): Array<{ durationMs: number; exitCode: number }> {
  return (db.prepare("SELECT duration_ms, exit_code FROM lane_pilot_check_duration WHERE project_id=? AND command_key IN (?,?) ORDER BY at DESC, rowid DESC LIMIT ?")
    .all(projectId, sha256Hex(checkHistoryKey(check)), legacyCheckKey(check.command), limit) as Array<{ duration_ms: number; exit_code: number }>)
    .map((row) => ({ durationMs: row.duration_ms, exitCode: row.exit_code }));
}

/** Durations (ms) of the last green runs of one check in one project, newest first (rows of the old command-only key included). */
export function listCheckDurations(db: LanePilotDatabase, projectId: string, check: CheckRef, limit = 20): number[] {
  return (db.prepare("SELECT duration_ms FROM lane_pilot_check_duration WHERE project_id=? AND command_key IN (?,?) AND exit_code=0 ORDER BY at DESC, rowid DESC LIMIT ?")
    .all(projectId, sha256Hex(checkHistoryKey(check)), legacyCheckKey(check.command), limit) as Array<{ duration_ms: number }>).map((row) => row.duration_ms);
}

/** Whether any Env Catalog secret was ever handed to this task (a retry then scans its diff for a leaked value). */
export function secretIssuedForTask(db: LanePilotDatabase, taskId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_secret_issuance WHERE task_id=? LIMIT 1").get(taskId));
}

/** One skill-switch metric row of an attempt (which skills the writer was offered, how many it swapped, the outcome). */
export function recordSkillMetric(db: LanePilotDatabase, record: {
  id: string; attemptId: string; taskId: string; runId: string | null; projectId: string;
  skillCount: number; switchCount: number; skillsJson: string; outcome: string; recordedAt: number;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO lane_pilot_skill_metric
      (id, attempt_id, task_id, run_id, project_id, skill_count, switch_count, skills_json, outcome, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.attemptId, record.taskId, record.runId, record.projectId,
    record.skillCount, record.switchCount, record.skillsJson, record.outcome, record.recordedAt,
  );
}

/** Skill-switch rows of a window (switch count + outcome feed the "does switching hurt" stat). */
export function listSkillMetrics(db: LanePilotDatabase, sinceMs: number, untilMs: number): Array<{ switch_count: number; outcome: string }> {
  return db.prepare(`
    SELECT switch_count, outcome
    FROM lane_pilot_skill_metric
    WHERE recorded_at >= ? AND recorded_at <= ?
  `).all(sinceMs, untilMs) as Array<{ switch_count: number; outcome: string }>;
}

/** How many lane_pilot_* tables the database carries (the manifest's table count). */
export function countLanePilotTables(db: LanePilotDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'lane_pilot_%'").get() as { n: number }).n;
/** One profile-check report row (the native agent's daily verdict). */
export function saveProfileCheckReport(db: LanePilotDatabase, at: number, reportJson: string): void {
  db.prepare("INSERT INTO lane_pilot_profile_check(at, report_json) VALUES (?, ?)").run(at, reportJson);
}

/** The last profile-check report JSON, or undefined before the first run. */
export function latestProfileCheckReportJson(db: LanePilotDatabase): string | undefined {
  return (db.prepare("SELECT report_json FROM lane_pilot_profile_check ORDER BY at DESC LIMIT 1").get() as { report_json: string } | undefined)?.report_json;
}
