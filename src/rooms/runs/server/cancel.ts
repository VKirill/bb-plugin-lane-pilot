import { getAttempt, getTask, getTaskPlan, listStageReceipts, transitionAttempt } from "../../storage";
import { cancelRejection } from "./run-finish";
import { closeHelperStages, recordStage } from "./stage-records";
import { valueAt } from "../../core/server";
import { confirmWriterStopped } from "./writer-stop";
import type { ServerCore } from "../../core/server";

/** Stops the task's helper threads still running and closes their receipts canceled, so a canceled task leaves no helper running. */
async function cancelStageHelpers(ctx: Pick<ServerCore, "bb" | "db">, attempt: NonNullable<ReturnType<typeof getAttempt>>): Promise<void> {
  const task = getTask(ctx.db, attempt.task_id);
  const plan = getTaskPlan(ctx.db, attempt.task_id) ?? (task?.kind === "bb" ? valueAt(task.contract, "objective") : "") as string;
  await closeHelperStages(ctx.db, (threadId) => ctx.bb.sdk.threads.stop({ threadId }), { runId:attempt.run_id, taskId:attempt.task_id, plan,
    attempt:attempt.attempt_no, state:"canceled", reason:"task canceled" });
}

/** Cancels one attempt: a queued one at once, a running one once its writer's stop is observed. */
export async function cancelAttemptById(ctx: Pick<ServerCore, "bb" | "db" | "cancelQueuedAttempt">, attemptId: string, rollback?: { noteStopped(attemptId: string): Promise<{ recorded: boolean; error?: string } | void> }): Promise<{ ok:boolean; state:string; reason:string | null }> {
  const { bb, db } = ctx;
  const attempt = getAttempt(db, attemptId);
  if (!attempt) return { ok: false, state: "missing", reason: "attempt does not exist" };
  if (!attempt.thread_id) {
    const canceled = ctx.cancelQueuedAttempt(attempt);
    if (canceled.ok) await cancelStageHelpers(ctx, attempt);
    return canceled;
  }
  const rejection = cancelRejection(db, attempt);
  if (rejection) return { ok:false, state:attempt.state, reason:rejection };
  transitionAttempt(db, attempt.id, "cancel_requested", { threadId: attempt.thread_id });
  await bb.sdk.threads.stop({ threadId: attempt.thread_id });
  // Condition one of a stop: the writer is confirmed gone, waiting a bounded time for it (writer-stop.ts).
  const confirmed = await confirmWriterStopped(bb, attempt.thread_id);
  if (!confirmed.stopped) return { ok: false, state: "cancel_requested", reason: `writer stop was not independently observed (status=${confirmed.status ?? "unknown"}, waited ${Math.round(confirmed.waitedMs / 1000)}s)` };
  // Condition two: its work is back before anything is cleaned up, i.e. what its worktree holds is on record. A failed read is tried
  // once more; the writer is gone either way and is not started again, but the stop is not reported complete (2026-10-29 audit A-004).
  const record = async () => ((await rollback?.noteStopped(attempt.id).catch((cause: unknown) => ({ recorded: false, error: cause instanceof Error ? cause.message : String(cause) }))) as { recorded: boolean; error?: string } | undefined) ?? { recorded: true };
  let noted = await record();
  if (!noted.recorded) noted = await record();
  transitionAttempt(db, attempt.id, "canceled", { threadId: attempt.thread_id });
  const task = getTask(db, attempt.task_id);
  const plan = getTaskPlan(db, attempt.task_id) ?? (task?.kind === "bb" ? valueAt(task.contract, "objective") : "") as string;
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
    const current = listStageReceipts(db, attempt.run_id, attempt.task_id).find((row) => row.stageId === stageId);
    if (current && (current.state === "pending" || current.state === "running")) {
      recordStage(db, { runId:attempt.run_id, taskId:attempt.task_id, stageId, state:"canceled", input:plan,
        attempt:attempt.attempt_no, threadId:attempt.thread_id, reason:"writer stop observed" });
    }
  }
  await cancelStageHelpers(ctx, attempt);
  if (!noted.recorded) return { ok: false, state: "canceled", reason: `writer stopped, but what its worktree holds is not on record: ${noted.error ?? "unknown"}` };
  return { ok: true, state: "canceled", reason: null };
}
