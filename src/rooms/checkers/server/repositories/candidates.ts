import type Database from "better-sqlite3";
import { emptyCheckReason } from "../../../tasks/server";
import { getRunWriterHost, listCandidateTaskRows } from "../../../storage";
import type { ShellResult } from "../services/workspace";

type Db = Pick<Database.Database, "prepare">;

/** Runs a shell command on a BB machine (`cwd` must exist there). */
export interface HostPort {
  run(hostId: string, cwd: string, command: string, timeoutSec?: number): Promise<ShellResult>;
}

export type Risk = "low" | "medium" | "high" | "critical";

export type VerificationItem = { command: string; cwd: string; timeout_sec?: number; secrets?: string[] };

export type CandidateProject = { projectId: string; name: string; cwdPrefixes: readonly string[] };

/** Projects whose accepted tasks can enter the checker scorecard (no client or IP folders except cakekeeper). */
export const CANDIDATE_PROJECTS: readonly CandidateProject[] = [
  { projectId: "proj_acpiaqf4wq", name: "SelfyStudio", cwdPrefixes: ["/home/ubuntu/apps/selfystudio"] },
  { projectId: "proj_ejbam66722", name: "BB-сервис", cwdPrefixes: ["/Users/vechkasov/Documents/BB-сервис/plugins/"] },
  { projectId: "proj_a35nni238u", name: "cakekeeper", cwdPrefixes: ["/Users/vechkasov/Documents/Клиенты/cakekeeper.ru"] },
];

export type Candidate = {
  taskId: string; runId: string; projectId: string; projectName: string;
  attemptId: string; attemptNo: number; hard: boolean;
  risk: Risk; area: string; repoPath: string; hostId: string;
  acceptedAt?: number;
  initialHeadSha: string; baseSha: string | null;
  contract: Record<string, unknown>;
};

export type Rejection = { taskId: string; stratum: string; reason: string; detail?: string };

type Row = {
  task_id: string; run_id: string; project_id: string; contract_json: string; initial_head_sha: string; base_sha: string | null;
  attempt_id: string; attempt_no: number; accepted_at: number;
};

/** A check that needs the network, a login or the machine outside the checkout cannot be replayed on a clone. */
const OUTSIDE_WORLD = /\b(curl|wget|ssh|scp|rsync|nc|ncat|telnet|docker|docker-compose|kubectl|psql|mysql|redis-cli|mongosh|aws|gcloud|az|bb|pm2|systemctl|sudo)\b|https?:\/\/|\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|publish)\b|\bplaywright\b|\bcypress\b|\bchromium\b|\bsecrets?\./i;

/** Why a stored contract cannot enter the candidate pool, or null. Pure: it reads the contract only. */
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
  /** The projects and folders the owner allows (default CANDIDATE_PROJECTS) and the machine a folder lives on (default: the run's writer host). */
  projects?: readonly CandidateProject[];
  hostFor?: (path: string) => string | null;
};

/**
 * The accepted tasks eligible for checker scoring: each one's first accepted attempt, `initial_head_sha` known,
 * at least two checks, no `depends_on`, no secrets or network in the checks, not a drill or sandbox project.
 */
export function loadCandidates(db: Db, input: CandidateInput): { candidates: Candidate[]; rejected: Rejection[]; counts: Record<string, number> } {
  const rows = listCandidateTaskRows(db as never) as unknown as Row[];
  const candidates: Candidate[] = [], rejected: Rejection[] = [];
  const counts: Record<string, number> = {};
  const reject = (taskId: string, reason: string) => { counts[reason] = (counts[reason] ?? 0) + 1; rejected.push({ taskId, stratum: "", reason }); };
  for (const row of rows) {
    const project = (input.projects ?? CANDIDATE_PROJECTS).find((entry) => entry.projectId === row.project_id);
    const name = input.projectNames.get(row.project_id);
    if (!project || name === undefined) { reject(row.task_id, "project_not_allowed"); continue; }
    if (input.isSandboxName(name)) { reject(row.task_id, "sandbox_project"); continue; }
    let contract: Record<string, unknown>;
    try { contract = JSON.parse(row.contract_json) as Record<string, unknown>; } catch { reject(row.task_id, "contract_unreadable"); continue; }
    const cwd = typeof contract.project_cwd === "string" ? contract.project_cwd : "";
    if (!project.cwdPrefixes.some((prefix) => cwd === prefix.replace(/\/$/, "") || cwd.startsWith(prefix))) { reject(row.task_id, "folder_not_allowed"); continue; }
    const hostId = input.hostFor ? input.hostFor(cwd) : getRunWriterHost(db as never, row.run_id);
    if (!hostId) { reject(row.task_id, "host_unknown"); continue; }
    const why = contractRejection(contract);
    if (why) { reject(row.task_id, why); continue; }
    candidates.push({
      taskId: row.task_id, runId: row.run_id, projectId: row.project_id, projectName: project.name, attemptId: row.attempt_id, attemptNo: row.attempt_no,
      hard: row.attempt_no > 1, risk: contract.risk as Risk, area: typeof contract.area === "string" ? contract.area : "", repoPath: cwd, hostId, acceptedAt: row.accepted_at,
      initialHeadSha: row.initial_head_sha, baseSha: row.base_sha, contract,
    });
  }
  return { candidates, rejected, counts };
}
