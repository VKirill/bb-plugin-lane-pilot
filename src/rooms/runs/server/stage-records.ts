import { wfLiveRunWithIdem } from "@lane-pilot/workflow-engine";
import { setAttemptBarrier, appendGateEvaluation, countAttempts, deleteStageReceipt, failureFieldsOf, getTaskPlan, latestAttemptRow, listIdleAttemptsInStates, listOpenStageTasks, listStageReceipts, newestAttemptState, openDatabase, saveStageReceipt, stageReceiptState, transitionAttempt } from "../../storage";
import { RETRY_ELIGIBLE } from "../../contracts/state-machine";
import type { AttemptState } from "../../contracts/state-machine";
import { sha256Hex as sha256 } from "@lane-pilot/kit";
import { stageTransition, validateStageReceipt } from "@lane-pilot/contracts";
import type { StageId, StageState } from "@lane-pilot/contracts";
export function recordStage(db:ReturnType<typeof openDatabase>, input:{runId:string;taskId:string;stageId:StageId;state:StageState;input:string;attempt?:number;
  providerId?:string|null;model?:string|null;threadId?:string|null;result?:unknown|null;reason?:string|null;replaceOnNewInput?:boolean;
  /** Starts a stage over from blocked or skipped; only for a stage whose work never ran, so no verdict is lost. */
  restart?:boolean;
  /** Opens a writer stage that ended failed again, for a parked task restarting after a Lane Pilot or machine fault. */
  reopen?:boolean;
  /** A stage still running on an older input whose worker the caller stopped starts over as pending. */
  supersede?:boolean}): void {
  const previous = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === input.stageId);
  // A cancel is final and wins over a stage that was still working: the result it hands in late is dropped. It used to
  // throw, and the dispatch of a task the PM had canceled ended «dispatch_failed:illegal stage transition writer-agent:
  // canceled -> skipped» and blocked the run (live 2026-10-09).
  if (previous?.state === "canceled" && input.state !== "canceled") return;
  const nextInputSha = sha256(input.input);
  const replace = Boolean(input.replaceOnNewInput && previous && previous.inputSha256 !== nextInputSha
    && (["passed", "failed", "blocked", "skipped"].includes(previous.state) || (input.supersede && previous.state === "running")) && input.state === "pending");
  const restart = Boolean(previous && input.state === "pending" && ((input.restart && ["blocked", "skipped"].includes(previous.state))
    || (input.reopen && ["failed", "blocked", "skipped"].includes(previous.state))));
  // The writer's stage stays running between its sessions; when the next one has to wait (every writer held, the run paused) it is pending
  // again. It used to throw «illegal stage transition writer-agent: running -> pending» and park the task as Lane Pilot's fault (feed-gen 2026-11-10).
  const waitsAgain = input.stageId === "writer-agent" && previous?.state === "running" && input.state === "pending";
  if (previous && !replace && !restart && !waitsAgain && !stageTransition(previous.state, input.state)) {
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

export function recordGateEvaluation(db:ReturnType<typeof openDatabase>,input:{projectId:string;runId:string;taskId:string;gate:"owns-paths"|"validate"|"accept"|"verification";status:"passed"|"rejected"|"failed"|"skipped";attempt:number;input:string;summary?:unknown;
  /** The attempt the outcome lands on (sma av_record): its row keeps gate, status, why, tree and the verdict's summary. */
  attemptId?:string; tree?:string|null; verdict?:{status:string;summary:string}|null}):void {
  const output=input.summary===undefined?null:JSON.stringify(input.summary);
  appendGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:input.gate,status:input.status,
    inputSha256:sha256(input.input),outputSha256:output===null?null:sha256(output),attempt:Math.min(input.attempt,2),occurredAt:Date.now()});
  if (input.attemptId) {
    const summary=input.summary as Record<string, unknown>|undefined;
    const reason=typeof summary?.reason==="string" ? summary.reason : typeof summary?.writerStatus==="string" ? String(summary.writerStatus) : null;
    const barrier={gate:input.gate,status:input.status,reason,tree:input.tree??null,
      verdict:input.verdict?{status:input.verdict.status,summary:input.verdict.summary.slice(0,600)}:null,at:Date.now()};
    setAttemptBarrier(db,input.attemptId,barrier);
  }
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

const HELPER_STAGES = ["pm-read", "plan-critique", "specialist-review"] as const;

/**
 * Stops the task's helper threads still running (pm-read, plan critique, specialist review) and closes their receipts
 * with `state`, so an ended task leaves no helper running. A stop that fails is ignored; a late stage result cannot
 * reopen a canceled or blocked receipt (stageTransition has no way out of either).
 */
export async function closeHelperStages(db:ReturnType<typeof openDatabase>, stop:(threadId:string) => Promise<unknown>, input:{runId:string;taskId:string;
  plan:string;attempt:number;state:"canceled"|"blocked";reason:string}): Promise<void> {
  for (const row of listStageReceipts(db, input.runId, input.taskId)) {
    if (!(HELPER_STAGES as readonly string[]).includes(row.stageId) || (row.state !== "pending" && row.state !== "running")) continue;
    if (row.threadId) {
      try { await stop(row.threadId); } catch { /* an idle or missing helper thread: nothing to stop */ }
    }
    recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:row.stageId, state:input.state, input:input.plan,
      attempt:input.attempt, threadId:row.threadId, reason:input.reason });
  }
}

/**
 * Clears the helper stages of a dispatch that starts again after a reload, so they run as for a new dispatch: a helper
 * thread still running works for a dead dispatch and is stopped, and every helper receipt goes. A pm-read that passed or
 * was skipped stays, and runPmRead takes its summary instead of reading again. A plan critique or specialist review that
 * passed stays too: each reuses it when its input is unchanged and replaces it when the task changed (2026-10-29 audit: a
 * reload bought both reviews again). The stage events keep the history.
 */
export async function resetHelperStages(db:ReturnType<typeof openDatabase>, stop:(threadId:string) => Promise<unknown>,
  input:{runId:string;taskId:string}): Promise<void> {
  for (const row of listStageReceipts(db, input.runId, input.taskId)) {
    if (!(HELPER_STAGES as readonly string[]).includes(row.stageId)) continue;
    if (row.stageId === "pm-read" && (row.state === "passed" || row.state === "skipped")) continue;
    if ((row.stageId === "plan-critique" || row.stageId === "specialist-review") && row.state === "passed") continue;
    if (row.threadId && (row.state === "pending" || row.state === "running")) {
      try { await stop(row.threadId); } catch { /* an idle or missing helper thread: nothing to stop */ }
    }
    deleteStageReceipt(db, input.runId, input.taskId, row.stageId);
  }
}

/**
 * Writer stages left pending or running although the task's latest attempt has finished and nothing works on it:
 * closed from that attempt's state. Runs after start-up recovery, which resumes the attempts still in flight, and
 * before the parking of faulted tasks (task-reconcile.ts), so a lost retry is parked in the same pass. `idleMs` keeps
 * an attempt that moved more recently than that alone: the periodic pass must not meet a loop between two attempts.
 */
export function closeOrphanWriterStages(db:ReturnType<typeof openDatabase>, active:ReadonlySet<string>, idleMs = 0, now = Date.now(), scanOpen:(attemptId:string)=>boolean = () => false): number {
  // A retry-eligible attempt whose loop died before its stage receipts exist (a failed spawn, a reload in the gap)
  // is visible to no receipt row: close it or nothing ever will (seed 14, fault-injection).
  for (const stray of listIdleAttemptsInStates(db, ["spawn_rejected","provider_error","timeout","empty_output","validation_failed"], now - idleMs)) {
    if (active.has(`${stray.run_id}:${stray.task_id}`)) continue;
    if (scanOpen(stray.id)) continue;
    const newer = newestAttemptState(db, stray.run_id, stray.task_id);
    if (newer && ["accepted","blocked","canceled","queued","spawn_requested","spawn_unknown","running","cancel_requested"].includes(newer)) continue;
    transitionAttempt(db, stray.id, "blocked", { reason:`${stray.reason ?? stray.state}; its retry was lost in a plugin reload`, ...failureFieldsOf({ failureCode: stray.failure_code, checkName: stray.check_name, timeoutSec: stray.timeout_sec }) });
  }
  const rows = listOpenStageTasks(db, ["writer-agent","verification","acceptance-receipt","docs-maintenance"], ["pending","running"]);
  let closed = 0;
  for (const row of rows) {
    if (active.has(`${row.run_id}:${row.task_id}`)) continue;
    const latest = latestAttemptRow(db, row.run_id, row.task_id);
    if (!latest || now - latest.updated_at < idleMs) continue;
    // A failed attempt waiting for its retry: the loop that would retry it died with a reload, and start-up recovery
    // resumes only attempts in flight. Nobody retries it, so it ends here and the PM decides.
    // A scan that died mid-page left its cursor. The next process continues it; ending the attempt here drops that retry.
    if (RETRY_ELIGIBLE.includes(latest.state as AttemptState) && !scanOpen(latest.id)) {
      const reason = `${latest.reason ?? latest.state}; its retry was lost in a plugin reload`;
      transitionAttempt(db, latest.id, "blocked", { reason, ...failureFieldsOf({ failureCode: latest.failure_code, checkName: latest.check_name, timeoutSec: latest.timeout_sec }) });
      latest.state = "blocked";
      latest.reason = reason;
    }
    if (!["accepted", "blocked", "canceled"].includes(latest.state)) continue;
    const terminal = latest.state === "accepted" ? "passed" : latest.state === "canceled" ? "canceled" : "failed";
    const attempts = countAttempts(db, row.run_id, row.task_id);
    closed += closeWriterStages(db, { runId:row.run_id, taskId:row.task_id, plan:getTaskPlan(db, row.task_id) ?? "", terminal, attempt:attempts,
      reason:latest.reason ?? `attempt ${latest.state}`, threadId:latest.thread_id });
    // A docs-maintenance receipt left open when its upkeep was lost (a reload mid-run, or a project whose schedule no
    // longer runs) ends, never as a success: pending -> canceled, running -> failed. A live lp.docs-maintenance graph
    // for the same run/task is joined by the hourly pass, so it is left alone.
    const docs = stageReceiptState(db, row.run_id, row.task_id, "docs-maintenance");
    if (docs && (docs.state === "pending" || docs.state === "running") && now - docs.updated_at >= idleMs) {
      if (!wfLiveRunWithIdem(db, `docs-maintenance:${row.run_id}:${row.task_id}:%`)) {
        const state = docs.state === "pending" ? "canceled" : "failed";
        recordStage(db, { runId:row.run_id, taskId:row.task_id, stageId:"docs-maintenance", state, input:state, threadId:docs.thread_id,
          reason:"the docs upkeep was lost in a plugin reload; the hourly pass resumes it" });
        closed += 1;
      }
    }
  }
  return closed;
}

