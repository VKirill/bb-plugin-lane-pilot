import { createHash } from "node:crypto";

/** The name prefix of a bench sandbox project: «LP bench SelfyStudio». Sandbox detection (canary, metrics, harness, rule scan) treats it as sandbox traffic. */
export const BENCH_PROJECT_PREFIX = "LP bench";
export const benchProjectName = (projectName: string): string => `${BENCH_PROJECT_PREFIX} ${projectName}`;

/** Projects the bench may replay (owner default 2026-10-22): no client or IP folders. cakekeeper is the one client folder the owner named. */
export type BenchProject = { projectId: string; name: string; cwdPrefixes: readonly string[] };
export const BENCH_PROJECTS: readonly BenchProject[] = [
  { projectId: "proj_acpiaqf4wq", name: "SelfyStudio", cwdPrefixes: ["/home/ubuntu/apps/selfystudio"] },
  { projectId: "proj_ejbam66722", name: "BB-сервис", cwdPrefixes: ["/Users/vechkasov/Documents/BB-сервис/plugins/"] },
  { projectId: "proj_a35nni238u", name: "cakekeeper", cwdPrefixes: ["/Users/vechkasov/Documents/Клиенты/cakekeeper.ru"] },
];

/** Where a project's repository lives, by its path. A host is a BB machine id. */
export const HOST_BY_PATH_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["/home/ubuntu/", "host_rwrxyi39aw"],
  ["/Users/vechkasov/", "host_7sea4qaad8"],
];

export type Risk = "low" | "medium" | "high" | "critical";

/** A past task that could enter a set: accepted, with its first accepted attempt. */
export type Candidate = {
  taskId: string; runId: string; projectId: string; projectName: string;
  /** The first accepted attempt: its id and number (`hard` when it is not the first). */
  attemptId: string; attemptNo: number; hard: boolean;
  risk: Risk; area: string; repoPath: string; hostId: string;
  /** When the first accepted attempt was recorded. Absent on a hand-built candidate: not fresh. */
  acceptedAt?: number;
  initialHeadSha: string; baseSha: string | null;
  /** The stored task contract (task-v2), unparsed. */
  contract: Record<string, unknown>;
};

export type VerificationItem = { command: string; cwd: string; timeout_sec?: number; secrets?: string[] };

/** What the warm-up saw: exit codes of the checks on the bare base and on the base with the accepted solution. */
export type WarmRecord = {
  base: Array<{ command: string; exitCode: number; tail: string }>;
  solution: Array<{ command: string; exitCode: number; tail: string }>;
  discriminating: string[];
  applied: "apply" | "3way";
  files: string[];
};

export type ManifestTask = {
  taskId: string; position: number; projectId: string; projectName: string; hostId: string; repoPath: string;
  stratum: string; hard: boolean; risk: Risk; area: string;
  initialHeadSha: string; solutionCommit: string; solutionPatchSha256: string;
  contract: Record<string, unknown>; warm: WarmRecord;
};

export type Rejection = { taskId: string; stratum: string; reason: string; detail?: string };

/** Sorted-key JSON: the same value always gives the same text, so the same hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The hash of a set: its tasks in order, with contract, base commit and solution patch hash. Rejections and build notes are not part of it. */
export function manifestHash(tasks: readonly ManifestTask[]): string {
  const ordered = [...tasks].sort((a, b) => a.position - b.position);
  return sha256(canonicalJson(ordered.map((task) => ({
    taskId: task.taskId, position: task.position, projectId: task.projectId, repoPath: task.repoPath, stratum: task.stratum, hard: task.hard, risk: task.risk,
    initialHeadSha: task.initialHeadSha, solutionCommit: task.solutionCommit, solutionPatchSha256: task.solutionPatchSha256, contract: task.contract,
  }))));
}
