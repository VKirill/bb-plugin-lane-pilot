import type { ServerCore } from "../../contracts/server";
import { emitAttemptFinished, type AttemptFinished } from "./attempt-finished";
import { mountWriterAttemptFinished } from "./attempt-reactions";
import { mountVerificationAttemptFinished } from "./verification";
import { mountRuleFormsAttemptFinished } from "./rule-forms";
import type { FinishInput, Services } from "./finish-types";
import { finishWriterAttemptBody } from "./finish-attempt-body";

export { postMergeRepair } from "./verification";

export function createWriterFinish(ctx: ServerCore, services: Services) {
  // The attempt-finished reactions, in run order: the settle record, the landed check (verification's,
  // fire-and-forget), the skill metric and materialize, the finish scan (attempt-reactions.ts).
  mountRuleFormsAttemptFinished(ctx, services);
  const verification = mountVerificationAttemptFinished(ctx, services);
  mountWriterAttemptFinished(ctx, services);

  /** The attempt's end, whatever its outcome: the reactions on the attempt-finished bus run last (attempt-finished.ts). */
  async function finishWriterAttempt(input: FinishInput): Promise<Record<string,unknown>> {
    let result: Record<string, unknown> | null = null;
    // Facts the body learns on the way out, for the reactions: what landed, how far the gates passed.
    const facts: Pick<AttemptFinished, "writerStopped"> = {};
    try {
      result = await finishWriterAttemptBody(ctx, services, verification, input, facts);
      return result;
    } finally {
      try {
        await emitAttemptFinished(ctx, { scope:"attempt", projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          attemptId:input.attemptId, pmThreadId:input.pmThreadId, writerThreadId:input.writerThreadId,
          task:input.task, config:input.config, status:String(result?.status ?? "error"),
          reason:typeof result?.reason === "string" ? result.reason : null, result, ...facts });
      } catch (cause) {
        ctx.log(`attempt-finished: emit failed after ${input.attemptId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  return { finishWriterAttempt, ...verification };
}

export type WriterFinishApi = ReturnType<typeof createWriterFinish>;

export { barrierInputBody } from "./barrier-input";
export { executionChecklist } from "./execution-checklist";
