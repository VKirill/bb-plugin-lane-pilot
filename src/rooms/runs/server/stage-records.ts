import { appendGateEvaluation, getTaskPlan, listStageReceipts, openDatabase, saveStageReceipt, transitionAttempt } from "../../storage";
import { RETRY_ELIGIBLE } from "../state-machine";
import type { AttemptState } from "../state-machine";
import { sha256, stageTransition, validateStageReceipt } from "../../tasks";
import type { StageId, StageState } from "../../tasks";
export function recordStage(db:ReturnType<typeof openDatabase>, input:{runId:string;taskId:string;stageId:StageId;state:StageState;input:string;attempt?:number;
  providerId?:string|null;model?:string|null;threadId?:string|null;result?:unknown|null;reason?:string|null;replaceOnNewInput?:boolean;
  /** Starts a stage over from blocked or skipped; only for a stage whose work never ran, so no verdict is lost. */
  restart?:boolean;
  /** Opens a writer stage that ended failed again, for a parked task restarting after a Lane Pilot or machine fault. */
  reopen?:boolean}): void {
  const previous = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === input.stageId);
  // A cancel is final and wins over a stage that was still working: the result it hands in late is dropped. It used to
  // throw, and the dispatch of a task the PM had canceled ended «dispatch_failed:illegal stage transition writer-agent:
  // canceled -> skipped» and blocked the run (live 2026-10-09).
  if (previous?.state === "canceled" && input.state !== "canceled") return;
  const nextInputSha = sha256(input.input);
  const replace = Boolean(input.replaceOnNewInput && previous && previous.inputSha256 !== nextInputSha
    && ["passed", "failed", "blocked", "skipped"].includes(previous.state) && input.state === "pending");
  const restart = Boolean(previous && input.state === "pending" && ((input.restart && ["blocked", "skipped"].includes(previous.state))
    || (input.reopen && ["failed", "blocked", "skipped"].includes(previous.state))));
  if (previous && !replace && !restart && !stageTransition(previous.state, input.state)) {
    throw new Error(`illegal stage transition ${input.stageId}: ${previous.state} -> ${input.state}`);
  }
  const result = input.result ?? null;
  const output = result === null ? null : JSON.stringify(result);
  saveStageReceipt(db, validateStageReceipt({
    contractVersion:1, runId:input.runId, taskId:input.taskId, stageId:input.stageId,
    state:input.state, inputSha256:sha256(input.input), outputSha256:output === null ? null : sha256(output),
    // The receipt keeps 0-2; fallback writers (models 3 and 4 of the chain) made it 4 and the task ended internal_error.
    attempt:Math.min(input.attempt ?? 0, 2), providerId:input.providerId ?? null, model:input.model ?? null,
    threadId:input.threadId ?? null, result, reason:input.reason ?? null, updatedAt:Date.now(),
  }));
}

export function recordGateEvaluation(db:ReturnType<typeof openDatabase>,input:{projectId:string;runId:string;taskId:string;gate:"owns-paths"|"validate"|"accept"|"verification";status:"passed"|"rejected"|"failed"|"skipped";attempt:number;input:string;summary?:unknown}):void {
  const output=input.summary===undefined?null:JSON.stringify(input.summary);
  appendGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:input.gate,status:input.status,
    inputSha256:sha256(input.input),outputSha256:output===null?null:sha256(output),attempt:Math.min(input.attempt,2),occurredAt:Date.now()});
}

const WRITER_STAGES = ["writer-agent", "verification", "acceptance-receipt"] as const;

/** Sets a task's writer stages back to pending so a parked task can run its writer again from there. */
export function reopenWriterStages(db:ReturnType<typeof openDatabase>, runId:string, taskId:string, reason:string):void {
  const plan = getTaskPlan(db, taskId) ?? "";
  for (const stageId of WRITER_STAGES) {
    const current = listStageReceipts(db, runId, taskId).find((row) => row.stageId === stageId);
    if (current && ["failed", "blocked", "skipped"].includes(current.state)) recordStage(db, { runId, taskId, stageId, state:"pending", input:plan, reason, reopen:true });
  }
}

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
 * closed from that attempt's state. Runs after start-up recovery, which resumes the attempts still in flight, and
 * before the parking of faulted tasks (task-reconcile.ts), so a lost retry is parked in the same pass. `idleMs` keeps
 * an attempt that moved more recently than that alone: the periodic pass must not meet a loop between two attempts.
 */
export function closeOrphanWriterStages(db:ReturnType<typeof openDatabase>, active:ReadonlySet<string>, idleMs = 0, now = Date.now()): number {
  const rows = db.prepare(`SELECT DISTINCT s.run_id, s.task_id FROM lane_pilot_stage_receipt s
    WHERE s.stage_id IN ('writer-agent','verification','acceptance-receipt') AND s.state IN ('pending','running')`).all() as Array<{ run_id:string; task_id:string }>;
  let closed = 0;
  for (const row of rows) {
    if (active.has(`${row.run_id}:${row.task_id}`)) continue;
    const latest = db.prepare(`SELECT id, state, reason, thread_id, updated_at FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC, attempt_no DESC LIMIT 1`)
      .get(row.run_id, row.task_id) as { id:string; state:string; reason:string|null; thread_id:string|null; updated_at:number } | undefined;
    if (!latest || now - latest.updated_at < idleMs) continue;
    // A failed attempt waiting for its retry: the loop that would retry it died with a reload, and start-up recovery
    // resumes only attempts in flight. Nobody retries it, so it ends here and the PM decides.
    if (RETRY_ELIGIBLE.includes(latest.state as AttemptState)) {
      const reason = `${latest.reason ?? latest.state}; its retry was lost in a plugin reload`;
      transitionAttempt(db, latest.id, "blocked", { reason });
      latest.state = "blocked";
      latest.reason = reason;
    }
    if (!["accepted", "blocked", "canceled"].includes(latest.state)) continue;
    const terminal = latest.state === "accepted" ? "passed" : latest.state === "canceled" ? "canceled" : "failed";
    const attempts = (db.prepare("SELECT count(*) AS n FROM lane_pilot_attempt WHERE run_id=? AND task_id=?").get(row.run_id, row.task_id) as { n:number }).n;
    closed += closeWriterStages(db, { runId:row.run_id, taskId:row.task_id, plan:getTaskPlan(db, row.task_id) ?? "", terminal, attempt:attempts,
      reason:latest.reason ?? `attempt ${latest.state}`, threadId:latest.thread_id });
  }
  return closed;
}

