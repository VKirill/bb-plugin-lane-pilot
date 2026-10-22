import { RESTARTABLE_STAGES, affectedFrom, type Affected, type HeadPart, type ReceiptSummary, type TaskStage } from "@lane-pilot/contracts";
import { globMatch, type ChangeDescriptor } from "../policy";
import type { WallDb } from "./journal";
import { FAILED_STATES } from "./journal";
import { wallSignature } from "./signature";

/**
 * «Change the head and re-run from the earliest affected stage» (Maslov, 2026-10-22: «гонит поезд на голове A, дальше возникает проблема
 * в 6, он меняет голову и гонит на новой голове начиная со 2, пропускает 4-5»; atlas delta D1-1). When a night repair lands, the attempts of
 * its class that failed on the old head are planned for a re-run: the stages before the earliest affected one are reused (their receipts
 * passed and their input hashes still hold, `affectedFrom` in packages/contracts/src/stage-inputs.ts), the rest are stale.
 *
 * What runs: a task of a sandbox or bench project whose earliest affected stage is one Lane Pilot restarts in place (the writer's stages:
 * `reopenWriterStages` + a resumed writer, the way stability restarts a parked task). A task of a real project is only listed for the
 * morning list. A stage before the writer needs the return-to-stage operation (not built yet): such a task is listed too, with the plan.
 */

/** The parts of the head a change touches, from the same descriptor vocabulary the night policy reads (files and settings). */
const HEAD_FILES: ReadonlyArray<readonly [string, HeadPart]> = [
  ["src/rooms/critique/code-critique.ts", "code_critic"],
  ["src/rooms/critique/critique.ts", "plan_critic"],
  ["src/rooms/critique/specialist.ts", "plan_critic"],
  ["src/rooms/critique/critique-coverage.ts", "plan_critic"],
  ["src/rooms/critique/server/critique-runs.ts", "plan_critic"],
  ["src/rooms/critique/role-method.ts", "plan_critic"],
  ["src/rooms/critique/role-method.ts", "code_critic"],
  ["src/rooms/tasks/server/lint-task.ts", "lint"],
  ["src/rooms/tasks/contract-lint*", "lint"],
  ["src/rooms/verification/**", "gates"],
  ["src/rooms/writer/server/verify.ts", "gates"],
  ["src/rooms/writer/server/finish.ts", "gates"],
  ["src/rooms/acceptance/**", "plan_fact"],
  ["src/rooms/harness/**", "writer_harness"],
  ["src/rooms/self-repair/server/rule-scan.ts", "rules"],
  ["src/rooms/rule-forms/**", "rules"],
  ["src/rooms/memory/**", "memory"],
  ["packages/memory-core/**", "memory"],
  ["packages/models/**", "writer_key"],
  ["src/rooms/writer/**", "stage_prompts"],
  ["src/rooms/critique/pm-read.ts", "pm_read_settings"],
];
const HEAD_SETTINGS: ReadonlyArray<readonly [RegExp, HeadPart]> = [
  [/^(critic\.code|code_critic)/, "code_critic"],
  [/^(plan_critique|specialist)\./, "plan_critic"],
  [/^pm_read\./, "pm_read_settings"],
  [/^(writer|harness)\./, "writer_key"],
  [/^memory\./, "memory"],
];

export function headPartsOf(change: Pick<ChangeDescriptor, "files" | "settings">): HeadPart[] {
  const parts = new Set<HeadPart>();
  for (const file of change.files ?? []) for (const [glob, part] of HEAD_FILES) if (globMatch(glob, file)) parts.add(part);
  for (const key of change.settings ?? []) for (const [pattern, part] of HEAD_SETTINGS) if (pattern.test(key)) parts.add(part);
  return [...parts];
}

export type RerunScope = "sandbox" | "bench" | "real";
export type RerunPlan = {
  classKey: string; projectId: string; runId: string; taskId: string; attemptId: string; scope: RerunScope;
  affected: Affected; head: HeadPart[]; failedStage: string | null;
};

/** The stage a failed attempt broke in: the first stage of its task that did not pass. */
export function failedStageOf(receipts: readonly ReceiptSummary[]): string | null {
  const order: readonly string[] = ["pm-read", "plan-critique", "specialist-review", "writer-agent", "verification", "code-critique", "plan-fact", "acceptance-receipt"];
  for (const stage of order) {
    const receipt = receipts.find((row) => row.stage === stage);
    if (receipt && ["failed", "blocked"].includes(receipt.state)) return stage;
  }
  return null;
}

type FailedAttempt = { id: string; run_id: string; task_id: string; state: string; reason: string | null; project_id: string; updated_at: number };

/**
 * The tasks that still wait on a class: the newest attempt of each task that failed with the class since `since`, for tasks whose newest attempt
 * overall is not accepted, canceled or at work (a retry that got through is done), each with the plan of its re-run. `scopeOf` says sandbox /
 * bench / real for a project.
 */
export function planClassRerun(db: WallDb, input: { classKey: string; since: number; head: readonly HeadPart[]; scopeOf: (projectId: string) => RerunScope; limit?: number }): RerunPlan[] {
  const rows = db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.updated_at, r.project_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.updated_at>=? AND a.state IN (${FAILED_STATES.map((state) => `'${state}'`).join(",")})
    ORDER BY a.updated_at DESC LIMIT 3000`).all(input.since) as FailedAttempt[];
  const newest = db.prepare("SELECT state FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC LIMIT 1");
  const receiptsOf = db.prepare("SELECT stage_id, state, input_sha256 FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=?");
  const done = new Set(["accepted", "canceled", "queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"]);
  const seen = new Set<string>();
  const plans: RerunPlan[] = [];
  for (const row of rows) {
    const key = `${row.run_id}:${row.task_id}`;
    if (seen.has(key) || wallSignature(row.state, row.reason).classKey !== input.classKey) continue;
    seen.add(key);
    if (done.has((newest.get(row.run_id, row.task_id) as { state: string } | undefined)?.state ?? "")) continue;
    const receipts = (receiptsOf.all(row.run_id, row.task_id) as Array<{ stage_id: string; state: string; input_sha256: string }>)
      .map((item) => ({ stage: item.stage_id, state: item.state, inputSha256: item.input_sha256 }));
    const failedStage = failedStageOf(receipts);
    const affected = affectedFrom({ receipts, headParts: input.head, failedStage });
    plans.push({ classKey: input.classKey, projectId: row.project_id, runId: row.run_id, taskId: row.task_id, attemptId: row.id, scope: input.scopeOf(row.project_id), affected, head: [...input.head], failedStage });
    if (plans.length >= (input.limit ?? 50)) break;
  }
  return plans;
}

/** Whether Lane Pilot can restart this plan in place today: a writer-stage start of a task in a sandbox or bench project. */
export const executable = (plan: RerunPlan, sandboxOnly: boolean): boolean =>
  plan.affected.from !== null && (RESTARTABLE_STAGES as readonly TaskStage[]).includes(plan.affected.from) && (!sandboxOnly || plan.scope !== "real");

export function recordRerun(db: WallDb, plan: RerunPlan, state: "planned" | "dispatched" | "listed" | "skipped", note: string, now: number): boolean {
  const id = `rr_${plan.classKey.slice(-8)}_${plan.attemptId.slice(-10)}_${now.toString(36)}`;
  const result = db.prepare(`INSERT OR IGNORE INTO lane_pilot_wall_rerun (id,class_key,project_id,run_id,task_id,attempt_id,scope,from_stage,reused_json,stale_json,head_json,state,note,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, plan.classKey, plan.projectId, plan.runId, plan.taskId, plan.attemptId, plan.scope, plan.affected.from,
    JSON.stringify(plan.affected.reused), JSON.stringify(plan.affected.stale), JSON.stringify(plan.head), state, note.slice(0, 500), now);
  return result.changes > 0;
}
