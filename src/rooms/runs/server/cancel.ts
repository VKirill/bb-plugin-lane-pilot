import { getAttempt, getTask, getTaskPlan, listStageReceipts, transitionAttempt } from "../../storage";
import { cancelRejection } from "./run-finish";
import { recordStage } from "./stage-records";
import { stringAt, valueAt } from "../../core/server";
import type { ServerCore } from "../../core/server";

/** Cancels one attempt: a queued one at once, a running one once its writer's stop is observed. */
export async function cancelAttemptById(ctx: Pick<ServerCore, "bb" | "db" | "cancelQueuedAttempt">, attemptId: string): Promise<{ ok:boolean; state:string; reason:string | null }> {
  const { bb, db } = ctx;
  const attempt = getAttempt(db, attemptId);
  if (!attempt) return { ok: false, state: "missing", reason: "attempt does not exist" };
  if (!attempt.thread_id) return ctx.cancelQueuedAttempt(attempt);
  const rejection = cancelRejection(db, attempt);
  if (rejection) return { ok:false, state:attempt.state, reason:rejection };
  transitionAttempt(db, attempt.id, "cancel_requested", { threadId: attempt.thread_id });
  await bb.sdk.threads.stop({ threadId: attempt.thread_id });
  const observed = await bb.sdk.threads.get({ threadId: attempt.thread_id });
  const status = stringAt(observed, "status");
  const listRunning = (bb.sdk.threads as { listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>> }).listRunning;
  const running = listRunning ? await listRunning({}) : [];
  const stillRunning = running.some((thread) => thread.id === attempt.thread_id)
    || status === "active" || status === "running";
  if (stillRunning) return { ok: false, state: "cancel_requested", reason: `writer stop was not independently observed (status=${status ?? "unknown"})` };
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
  return { ok: true, state: "canceled", reason: null };
}
