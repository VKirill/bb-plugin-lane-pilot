import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { manifestHash, type ManifestTask, type Rejection } from "./types";

export type BenchDb = Pick<Database.Database, "prepare" | "transaction">;

export type BenchSet = { id: string; version: string; manifestSha256: string; taskCount: number; candidateCount: number; rejected: Rejection[]; config: Record<string, unknown>; createdAt: number };
export type StoredSet = BenchSet & { tasks: ManifestTask[] };

const json = <T>(text: string | null | undefined, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };

type SetRow = { id: string; version: string; manifest_sha256: string; task_count: number; candidate_count: number; rejected_json: string; config_json: string; created_at: number };
type TaskRow = {
  task_id: string; position: number; project_id: string; project_name: string; host_id: string; repo_path: string; stratum: string; hard: number; risk: string; area: string;
  initial_head_sha: string; solution_commit: string; solution_patch_sha256: string; contract_json: string; warm_json: string;
};

const setFrom = (row: SetRow): BenchSet => ({ id: row.id, version: row.version, manifestSha256: row.manifest_sha256, taskCount: row.task_count, candidateCount: row.candidate_count, rejected: json(row.rejected_json, []), config: json(row.config_json, {}), createdAt: row.created_at });
const taskFrom = (row: TaskRow): ManifestTask => ({
  taskId: row.task_id, position: row.position, projectId: row.project_id, projectName: row.project_name, hostId: row.host_id, repoPath: row.repo_path, stratum: row.stratum,
  hard: row.hard === 1, risk: row.risk as ManifestTask["risk"], area: row.area, initialHeadSha: row.initial_head_sha, solutionCommit: row.solution_commit,
  solutionPatchSha256: row.solution_patch_sha256, contract: json(row.contract_json, {}), warm: json(row.warm_json, { base: [], solution: [], discriminating: [], applied: "apply", files: [] }),
});

/** Writes a set once. A version that exists is refused: a set is never changed, a different one is a new version. */
export function insertSet(db: BenchDb, input: { version: string; tasks: ManifestTask[]; rejected: Rejection[]; candidateCount: number; config: Record<string, unknown>; now?: number }): BenchSet {
  if (db.prepare("SELECT 1 FROM lane_pilot_bench_set WHERE version=?").get(input.version)) throw new Error(`bench set ${input.version} exists; a set is never changed, build a new version`);
  const id = `benchset_${input.version}`;
  const hash = manifestHash(input.tasks);
  const now = input.now ?? Date.now();
  db.transaction(() => {
    db.prepare("INSERT INTO lane_pilot_bench_set(id,version,manifest_sha256,task_count,candidate_count,rejected_json,config_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, input.version, hash, input.tasks.length, input.candidateCount, JSON.stringify(input.rejected), JSON.stringify(input.config), now);
    const insert = db.prepare(`INSERT INTO lane_pilot_bench_task(set_id,task_id,position,project_id,project_name,host_id,repo_path,stratum,hard,risk,area,initial_head_sha,solution_commit,solution_patch_sha256,contract_json,warm_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const task of input.tasks) insert.run(id, task.taskId, task.position, task.projectId, task.projectName, task.hostId, task.repoPath, task.stratum, task.hard ? 1 : 0, task.risk, task.area,
      task.initialHeadSha, task.solutionCommit, task.solutionPatchSha256, JSON.stringify(task.contract), JSON.stringify(task.warm));
  })();
  return { id, version: input.version, manifestSha256: hash, taskCount: input.tasks.length, candidateCount: input.candidateCount, rejected: input.rejected, config: input.config, createdAt: now };
}

export function getSet(db: BenchDb, version: string): StoredSet | null {
  const row = db.prepare("SELECT * FROM lane_pilot_bench_set WHERE version=?").get(version) as SetRow | undefined;
  if (!row) return null;
  const tasks = (db.prepare("SELECT * FROM lane_pilot_bench_task WHERE set_id=? ORDER BY position").all(row.id) as TaskRow[]).map(taskFrom);
  return { ...setFrom(row), tasks };
}

export function listSets(db: BenchDb): BenchSet[] {
  return (db.prepare("SELECT * FROM lane_pilot_bench_set ORDER BY created_at DESC").all() as SetRow[]).map(setFrom);
}

/** The set as stored must still hash to the value written with it: a hand-edited row is caught before a run spends money on it. */
export function verifySet(set: StoredSet): { ok: true } | { ok: false; reason: string } {
  const now = manifestHash(set.tasks);
  return now === set.manifestSha256 ? { ok: true } : { ok: false, reason: `manifest hash ${now.slice(0, 12)} differs from the stored ${set.manifestSha256.slice(0, 12)}` };
}

export type BenchRun = {
  id: string; setId: string; arm: string; repeat: number; state: "running" | "done" | "stopped_budget" | "failed"; stopReason: string | null;
  config: Record<string, unknown>; budgetTokens: number | null; budgetHours: number | null; spentTokens: number; startedAt: number; finishedAt: number | null;
};
type RunRow = { id: string; set_id: string; arm: string; repeat_no: number; state: BenchRun["state"]; stop_reason: string | null; config_json: string; budget_tokens: number | null; budget_hours: number | null; spent_tokens: number; started_at: number; finished_at: number | null };
const runFrom = (row: RunRow): BenchRun => ({ id: row.id, setId: row.set_id, arm: row.arm, repeat: row.repeat_no, state: row.state, stopReason: row.stop_reason, config: json(row.config_json, {}), budgetTokens: row.budget_tokens, budgetHours: row.budget_hours, spentTokens: row.spent_tokens, startedAt: row.started_at, finishedAt: row.finished_at });

export function getRun(db: BenchDb, setId: string, arm: string, repeat: number): BenchRun | null {
  const row = db.prepare("SELECT * FROM lane_pilot_bench_run WHERE set_id=? AND arm=? AND repeat_no=?").get(setId, arm, repeat) as RunRow | undefined;
  return row ? runFrom(row) : null;
}

export function listRuns(db: BenchDb, setId?: string): BenchRun[] {
  const rows = (setId ? db.prepare("SELECT * FROM lane_pilot_bench_run WHERE set_id=? ORDER BY started_at").all(setId) : db.prepare("SELECT * FROM lane_pilot_bench_run ORDER BY started_at").all()) as RunRow[];
  return rows.map(runFrom);
}

export function startRunRow(db: BenchDb, input: { setId: string; arm: string; repeat: number; config: Record<string, unknown>; budgetTokens: number | null; budgetHours: number | null; now?: number }): BenchRun {
  const existing = getRun(db, input.setId, input.arm, input.repeat);
  if (existing) {
    // A series is resumed, never restarted: the finished tasks keep their rows, the config must be the same arm.
    if (JSON.stringify(existing.config) !== JSON.stringify(input.config)) throw new Error(`arm ${input.arm} repeat ${input.repeat} already ran with another configuration; use a new arm name`);
    db.prepare("UPDATE lane_pilot_bench_run SET state='running', stop_reason=NULL, finished_at=NULL, budget_tokens=?, budget_hours=? WHERE id=?").run(input.budgetTokens, input.budgetHours, existing.id);
    return { ...existing, state: "running", stopReason: null, finishedAt: null, budgetTokens: input.budgetTokens, budgetHours: input.budgetHours };
  }
  const id = `benchrun_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const now = input.now ?? Date.now();
  db.prepare("INSERT INTO lane_pilot_bench_run(id,set_id,arm,repeat_no,state,config_json,budget_tokens,budget_hours,started_at) VALUES(?,?,?,?, 'running',?,?,?,?)")
    .run(id, input.setId, input.arm, input.repeat, JSON.stringify(input.config), input.budgetTokens, input.budgetHours, now);
  return { id, setId: input.setId, arm: input.arm, repeat: input.repeat, state: "running", stopReason: null, config: input.config, budgetTokens: input.budgetTokens, budgetHours: input.budgetHours, spentTokens: 0, startedAt: now, finishedAt: null };
}

export function finishRunRow(db: BenchDb, runId: string, state: BenchRun["state"], stopReason: string | null, now = Date.now()): void {
  db.prepare("UPDATE lane_pilot_bench_run SET state=?, stop_reason=?, finished_at=? WHERE id=?").run(state, stopReason, now, runId);
}

export function addSpent(db: BenchDb, runId: string, tokens: number): void {
  db.prepare("UPDATE lane_pilot_bench_run SET spent_tokens=spent_tokens+? WHERE id=?").run(Math.max(0, Math.round(tokens)), runId);
}

export type BenchResult = {
  runId: string; taskId: string; position: number; state: "accepted" | "not_accepted" | "error" | "skipped_budget"; accepted: boolean;
  benchTaskId: string | null; lpRunId: string | null; attempts: number; stagesPassed: number; stagesFailed: number;
  tokens: number | null; costUsd: number | null; costState: "measured" | "partial" | "not_measured"; seconds: number | null; reason: string | null; recordedAt: number;
};
type ResultRow = { run_id: string; task_id: string; position: number; state: BenchResult["state"]; accepted: number; bench_task_id: string | null; lp_run_id: string | null; attempts: number; stages_passed: number; stages_failed: number; tokens: number | null; cost_usd: number | null; cost_state: BenchResult["costState"]; seconds: number | null; reason: string | null; recorded_at: number };
const resultFrom = (row: ResultRow): BenchResult => ({ runId: row.run_id, taskId: row.task_id, position: row.position, state: row.state, accepted: row.accepted === 1, benchTaskId: row.bench_task_id, lpRunId: row.lp_run_id, attempts: row.attempts, stagesPassed: row.stages_passed, stagesFailed: row.stages_failed, tokens: row.tokens, costUsd: row.cost_usd, costState: row.cost_state, seconds: row.seconds, reason: row.reason, recordedAt: row.recorded_at });

export function saveResult(db: BenchDb, result: BenchResult, metrics: unknown[] = []): void {
  db.prepare(`INSERT OR REPLACE INTO lane_pilot_bench_result(run_id,task_id,position,state,accepted,bench_task_id,lp_run_id,attempts,stages_passed,stages_failed,tokens,cost_usd,cost_state,seconds,reason,metrics_json,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(result.runId, result.taskId, result.position, result.state, result.accepted ? 1 : 0, result.benchTaskId, result.lpRunId, result.attempts, result.stagesPassed, result.stagesFailed,
    result.tokens, result.costUsd, result.costState, result.seconds, result.reason, JSON.stringify(metrics), result.recordedAt);
}

export function listResults(db: BenchDb, runId: string): BenchResult[] {
  return (db.prepare("SELECT * FROM lane_pilot_bench_result WHERE run_id=? ORDER BY position").all(runId) as ResultRow[]).map(resultFrom);
}

export type NoiseRecord = {
  id: string; setId: string; armA: string; armB: string; createdAt: number;
  noise: { unstableTasks: string[]; flipShare: number; costRel: number | null; secondsRel: number | null; stagesSlack: number; tasks: number };
};
export function saveNoise(db: BenchDb, input: Omit<NoiseRecord, "id" | "createdAt"> & { now?: number }): NoiseRecord {
  const id = `benchnoise_${randomUUID().replaceAll("-", "").slice(0, 12)}`, now = input.now ?? Date.now();
  db.prepare("INSERT INTO lane_pilot_bench_noise(id,set_id,arm_a,arm_b,noise_json,created_at) VALUES(?,?,?,?,?,?)").run(id, input.setId, input.armA, input.armB, JSON.stringify(input.noise), now);
  return { id, setId: input.setId, armA: input.armA, armB: input.armB, noise: input.noise, createdAt: now };
}
export function latestNoise(db: BenchDb, setId: string, arms?: [string, string]): NoiseRecord | null {
  const row = (arms
    ? db.prepare("SELECT * FROM lane_pilot_bench_noise WHERE set_id=? AND arm_a=? AND arm_b=? ORDER BY created_at DESC LIMIT 1").get(setId, arms[0], arms[1])
    : db.prepare("SELECT * FROM lane_pilot_bench_noise WHERE set_id=? ORDER BY created_at DESC LIMIT 1").get(setId)) as { id: string; set_id: string; arm_a: string; arm_b: string; noise_json: string; created_at: number } | undefined;
  return row ? { id: row.id, setId: row.set_id, armA: row.arm_a, armB: row.arm_b, noise: json(row.noise_json, {} as NoiseRecord["noise"]), createdAt: row.created_at } : null;
}

export type BenchVerdict = { id: string; setId: string; armA: string; armB: string; harnessId: string | null; passed: boolean; report: unknown; createdAt: number };
export function saveVerdict(db: BenchDb, input: Omit<BenchVerdict, "id" | "createdAt"> & { now?: number }): BenchVerdict {
  const id = `benchverdict_${randomUUID().replaceAll("-", "").slice(0, 12)}`, now = input.now ?? Date.now();
  db.prepare("INSERT INTO lane_pilot_bench_verdict(id,set_id,arm_a,arm_b,harness_id,passed,report_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, input.setId, input.armA, input.armB, input.harnessId, input.passed ? 1 : 0, JSON.stringify(input.report), now);
  return { id, setId: input.setId, armA: input.armA, armB: input.armB, harnessId: input.harnessId, passed: input.passed, report: input.report, createdAt: now };
}
/** The newest bench verdict for a harness tree, or null when no comparison has decided on it. */
export function verdictForHarness(db: BenchDb, harnessId: string): BenchVerdict | null {
  const row = db.prepare("SELECT * FROM lane_pilot_bench_verdict WHERE harness_id=? ORDER BY created_at DESC LIMIT 1").get(harnessId) as { id: string; set_id: string; arm_a: string; arm_b: string; harness_id: string | null; passed: number; report_json: string; created_at: number } | undefined;
  return row ? { id: row.id, setId: row.set_id, armA: row.arm_a, armB: row.arm_b, harnessId: row.harness_id, passed: row.passed === 1, report: json(row.report_json, null), createdAt: row.created_at } : null;
}

/** What a bench sandbox project runs under: `none` (no harness tree), `tree` (the source project's active tree for the task's area) or a harness id. */
export type BenchProjectControl = { projectId: string; harness: string; sourceProjectId: string | null };
export function setBenchProject(db: BenchDb, input: BenchProjectControl, now = Date.now()): void {
  db.prepare(`INSERT INTO lane_pilot_bench_project(project_id,harness,source_project_id,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET harness=excluded.harness, source_project_id=excluded.source_project_id, updated_at=excluded.updated_at`).run(input.projectId, input.harness, input.sourceProjectId, now);
}
export function getBenchProject(db: BenchDb, projectId: string): BenchProjectControl | null {
  const row = db.prepare("SELECT project_id, harness, source_project_id FROM lane_pilot_bench_project WHERE project_id=?").get(projectId) as { project_id: string; harness: string; source_project_id: string | null } | undefined;
  return row ? { projectId: row.project_id, harness: row.harness, sourceProjectId: row.source_project_id } : null;
}
