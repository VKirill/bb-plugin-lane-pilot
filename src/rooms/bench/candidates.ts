import type Database from "better-sqlite3";
import { emptyCheckReason } from "../tasks/server";
import { BENCH_PROJECTS, HOST_BY_PATH_PREFIX, type BenchProject, type Candidate, type Rejection, type Risk, type VerificationItem } from "./types";

type Db = Pick<Database.Database, "prepare">;

type Row = {
  task_id: string; run_id: string; project_id: string; contract_json: string; initial_head_sha: string; base_sha: string | null;
  attempt_id: string; attempt_no: number;
};

/** A check that needs the network, a login or the machine outside the checkout cannot be replayed on a clone. */
const OUTSIDE_WORLD = /\b(curl|wget|ssh|scp|rsync|nc|ncat|telnet|docker|docker-compose|kubectl|psql|mysql|redis-cli|mongosh|aws|gcloud|az|bb|pm2|systemctl|sudo)\b|https?:\/\/|\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|publish)\b|\bplaywright\b|\bcypress\b|\bchromium\b|\bsecrets?\./i;

export const hostForPath = (path: string): string | null => HOST_BY_PATH_PREFIX.find(([prefix]) => path.startsWith(prefix))?.[1] ?? null;

/** Why a stored contract cannot go into a set, or null. Pure: it reads the contract only. */
export function contractRejection(contract: Record<string, unknown>): string | null {
  const verification = Array.isArray(contract.verification) ? contract.verification as VerificationItem[] : [];
  if (verification.length < 2) return "fewer_than_2_checks";
  if (Array.isArray(contract.depends_on) && contract.depends_on.length > 0) return "depends_on";
  for (const item of verification) {
    if (typeof item?.command !== "string" || !item.command.trim()) return "empty_check";
    if (Array.isArray(item.secrets) && item.secrets.length > 0) return "check_needs_secrets";
    if (emptyCheckReason(item.command)) return "empty_check";
    if (OUTSIDE_WORLD.test(item.command)) return "check_needs_network_or_login";
  }
  const risk = contract.risk;
  if (risk !== "low" && risk !== "medium" && risk !== "high" && risk !== "critical") return "no_risk";
  return null;
}

export type CandidateInput = {
  /** Project id -> name, for the sandbox test and the label. A project missing here is skipped. */
  projectNames: ReadonlyMap<string, string>;
  isSandboxName: (name: string) => boolean;
  /** The projects and folders the owner allows (default BENCH_PROJECTS) and the machine a folder lives on (default by path prefix). */
  projects?: readonly BenchProject[];
  hostFor?: (path: string) => string | null;
};

/**
 * The accepted tasks that could enter a set: each one's first accepted attempt, `initial_head_sha` known, at least two checks,
 * no `depends_on`, no secrets or network in the checks, not a drill or a sandbox project, a project the owner allows (BENCH_PROJECTS).
 * `rejected` counts the reasons so the report can say where the 843 went.
 */
export function loadCandidates(db: Db, input: CandidateInput): { candidates: Candidate[]; rejected: Rejection[]; counts: Record<string, number> } {
  const rows = db.prepare(`SELECT t.id AS task_id, t.run_id, r.project_id, t.contract_json, g.initial_head_sha, g.base_sha, a.id AS attempt_id, a.attempt_no
    FROM lane_pilot_task t
    JOIN lane_pilot_run r ON r.id = t.run_id
    JOIN lane_pilot_task_git_base g ON g.task_id = t.id
    JOIN lane_pilot_attempt a ON a.task_id = t.id AND a.state = 'accepted'
      AND a.attempt_no = (SELECT MIN(b.attempt_no) FROM lane_pilot_attempt b WHERE b.task_id = t.id AND b.state = 'accepted')
    WHERE t.id NOT LIKE 'drill-%' AND g.initial_head_sha <> ''
    GROUP BY t.id ORDER BY t.id`).all() as Row[];
  const candidates: Candidate[] = [], rejected: Rejection[] = [];
  const counts: Record<string, number> = {};
  const reject = (taskId: string, reason: string) => { counts[reason] = (counts[reason] ?? 0) + 1; rejected.push({ taskId, stratum: "", reason }); };
  for (const row of rows) {
    const project = (input.projects ?? BENCH_PROJECTS).find((entry) => entry.projectId === row.project_id);
    const name = input.projectNames.get(row.project_id);
    if (!project || name === undefined) { reject(row.task_id, "project_not_allowed"); continue; }
    if (input.isSandboxName(name)) { reject(row.task_id, "sandbox_project"); continue; }
    let contract: Record<string, unknown>;
    try { contract = JSON.parse(row.contract_json) as Record<string, unknown>; } catch { reject(row.task_id, "contract_unreadable"); continue; }
    const cwd = typeof contract.project_cwd === "string" ? contract.project_cwd : "";
    if (!project.cwdPrefixes.some((prefix) => cwd === prefix.replace(/\/$/, "") || cwd.startsWith(prefix))) { reject(row.task_id, "folder_not_allowed"); continue; }
    const hostId = (input.hostFor ?? hostForPath)(cwd);
    if (!hostId) { reject(row.task_id, "host_unknown"); continue; }
    const why = contractRejection(contract);
    if (why) { reject(row.task_id, why); continue; }
    candidates.push({
      taskId: row.task_id, runId: row.run_id, projectId: row.project_id, projectName: project.name, attemptId: row.attempt_id, attemptNo: row.attempt_no,
      hard: row.attempt_no > 1, risk: contract.risk as Risk, area: typeof contract.area === "string" ? contract.area : "", repoPath: cwd, hostId,
      initialHeadSha: row.initial_head_sha, baseSha: row.base_sha, contract,
    });
  }
  return { candidates, rejected, counts };
}
