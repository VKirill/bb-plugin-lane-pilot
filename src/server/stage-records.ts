import { appendGateEvaluation, getTaskPlan, listStageReceipts, openDatabase, saveStageReceipt } from "../database";
import { sha256, stageTransition, validateStageReceipt } from "../stages/contract";
import type { StageId, StageState } from "../stages/contract";
export function recordStage(db:ReturnType<typeof openDatabase>, input:{runId:string;taskId:string;stageId:StageId;state:StageState;input:string;attempt?:number;
  providerId?:string|null;model?:string|null;threadId?:string|null;result?:unknown|null;reason?:string|null;replaceOnNewInput?:boolean;
  /** Starts a stage over from blocked or skipped; only for a stage whose work never ran, so no verdict is lost. */
  restart?:boolean}): void {
  const previous = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === input.stageId);
  const nextInputSha = sha256(input.input);
  const replace = Boolean(input.replaceOnNewInput && previous && previous.inputSha256 !== nextInputSha
    && ["passed", "failed", "blocked", "skipped"].includes(previous.state) && input.state === "pending");
  const restart = Boolean(input.restart && previous && ["blocked", "skipped"].includes(previous.state) && input.state === "pending");
  if (previous && !replace && !restart && !stageTransition(previous.state, input.state)) {
    throw new Error(`illegal stage transition ${input.stageId}: ${previous.state} -> ${input.state}`);
  }
  const result = input.result ?? null;
  const output = result === null ? null : JSON.stringify(result);
  saveStageReceipt(db, validateStageReceipt({
    contractVersion:1, runId:input.runId, taskId:input.taskId, stageId:input.stageId,
    state:input.state, inputSha256:sha256(input.input), outputSha256:output === null ? null : sha256(output),
    attempt:input.attempt ?? 0, providerId:input.providerId ?? null, model:input.model ?? null,
    threadId:input.threadId ?? null, result, reason:input.reason ?? null, updatedAt:Date.now(),
  }));
}

export function recordGateEvaluation(db:ReturnType<typeof openDatabase>,input:{projectId:string;runId:string;taskId:string;gate:"owns-paths"|"validate"|"accept"|"verification";status:"passed"|"rejected"|"failed"|"skipped";attempt:number;input:string;summary?:unknown}):void {
  const output=input.summary===undefined?null:JSON.stringify(input.summary);
  appendGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:input.gate,status:input.status,
    inputSha256:sha256(input.input),outputSha256:output===null?null:sha256(output),attempt:Math.min(input.attempt,2),occurredAt:Date.now()});
}

const WRITER_STAGES = ["writer-agent", "verification", "acceptance-receipt"] as const;

/**
 * Closes the writer stages of a task that ended outside the start loop — an attempt finished after a reload, or
 * stages left open by an earlier version. Before, accepted tasks kept «writer-agent running» for good.
 */
export function closeWriterStages(db:ReturnType<typeof openDatabase>, input:{runId:string;taskId:string;plan:string;
  terminal:"passed"|"failed"|"canceled";attempt:number;reason?:string|null;threadId?:string|null;result?:unknown}): number {
  let closed = 0;
  for (const stageId of WRITER_STAGES) {
    const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
    if (!current || (current.state !== "pending" && current.state !== "running")) continue;
    if (current.state === "pending" && input.terminal !== "canceled") {
      recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
    }
    recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:input.terminal, input:input.plan,
      attempt:Math.min(input.attempt, 2), threadId:input.threadId ?? null,
      result:stageId === "writer-agent" ? input.result ?? null : null, reason:input.terminal === "passed" ? null : input.reason ?? null });
    closed += 1;
  }
  return closed;
}

/**
 * Writer stages left pending or running although the task's latest attempt has finished and nothing works on it:
 * closed from that attempt's state. Runs after start-up recovery, which resumes the attempts still in flight.
 */
export function closeOrphanWriterStages(db:ReturnType<typeof openDatabase>, active:ReadonlySet<string>): number {
  const rows = db.prepare(`SELECT DISTINCT s.run_id, s.task_id FROM lane_pilot_stage_receipt s
    WHERE s.stage_id IN ('writer-agent','verification','acceptance-receipt') AND s.state IN ('pending','running')`).all() as Array<{ run_id:string; task_id:string }>;
  let closed = 0;
  for (const row of rows) {
    if (active.has(`${row.run_id}:${row.task_id}`)) continue;
    const latest = db.prepare(`SELECT state, reason, thread_id FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC, attempt_no DESC LIMIT 1`)
      .get(row.run_id, row.task_id) as { state:string; reason:string|null; thread_id:string|null } | undefined;
    if (!latest || !["accepted", "blocked", "canceled"].includes(latest.state)) continue;
    const terminal = latest.state === "accepted" ? "passed" : latest.state === "canceled" ? "canceled" : "failed";
    const attempts = (db.prepare("SELECT count(*) AS n FROM lane_pilot_attempt WHERE run_id=? AND task_id=?").get(row.run_id, row.task_id) as { n:number }).n;
    closed += closeWriterStages(db, { runId:row.run_id, taskId:row.task_id, plan:getTaskPlan(db, row.task_id) ?? "", terminal, attempt:attempts,
      reason:latest.reason ?? `attempt ${latest.state}`, threadId:latest.thread_id });
  }
  return closed;
}

