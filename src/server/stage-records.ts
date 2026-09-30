import { appendGateEvaluation, listStageReceipts, openDatabase, saveStageReceipt } from "../database";
import { sha256, stageTransition, validateStageReceipt } from "../stages/contract";
import type { StageId, StageState } from "../stages/contract";
export function recordStage(db:ReturnType<typeof openDatabase>, input:{runId:string;taskId:string;stageId:StageId;state:StageState;input:string;attempt?:number;
  providerId?:string|null;model?:string|null;threadId?:string|null;result?:unknown|null;reason?:string|null;replaceOnNewInput?:boolean}): void {
  const previous = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === input.stageId);
  const nextInputSha = sha256(input.input);
  const replace = Boolean(input.replaceOnNewInput && previous && previous.inputSha256 !== nextInputSha
    && ["passed", "failed", "blocked", "skipped"].includes(previous.state) && input.state === "pending");
  if (previous && !replace && !stageTransition(previous.state, input.state)) {
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
