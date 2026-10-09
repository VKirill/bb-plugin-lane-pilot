import { taskV2Schema } from "../../contracts";
import { getAttempt, getRun, getTask, listAttemptsForTask } from "../../storage";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { answerTurnPrompt } from "./writer-task";
import { awaitsWriterAnswer, createAttemptReopen } from "./reopen-attempt";

/**
 * The PM's answer to a writer's NEEDS_HUMAN question: the same attempt reopens in the same writer thread and
 * worktree, the answer goes in as a turn, and the normal wait → validate → accept/retry loop takes over. The
 * answer round creates no attempt, so the task's charged attempt count does not grow.
 */
export function createWriterAnswer(ctx: ServerCore, services: Services) {
  const { configForRun, db } = ctx;
  const reopen = createAttemptReopen(ctx, services);

  const notAnswerable = (hint:string) => ({
    ok:false as const,
    error:{ code:"not_answerable", retryable:false, sideEffects:"none" as const, hint },
  });

  async function answerWriter(input:{
    projectId:string; runId:string; pmThreadId:string; taskId:string; answer:string;
  }): Promise<Record<string, unknown>> {
    const run = getRun(db, input.runId);
    if (!run || run.project_id !== input.projectId || run.pm_thread_id !== input.pmThreadId) {
      return notAnswerable("the run does not belong to this PM thread and project; redispatch the task instead");
    }
    const row = getTask(db, input.taskId);
    const parsed = row && row.run_id === input.runId && row.kind === "bb" ? taskV2Schema.safeParse(row.contract) : null;
    if (!parsed?.success) return notAnswerable(`no such task in this run: ${input.taskId}; redispatch it instead`);
    const latest = listAttemptsForTask(db, input.runId, input.taskId).at(-1);
    const attempt = latest ? getAttempt(db, latest.id) : undefined;
    if (!attempt || !awaitsWriterAnswer(attempt)) {
      return notAnswerable("the task's latest attempt is not blocked with a writer question; redispatch the task instead");
    }
    const ready = await reopen.checkReopenable({ runId:input.runId, taskId:input.taskId, run, attempt });
    if (!ready.ok) return notAnswerable(ready.hint);
    const config = await configForRun(input.projectId, run);
    if (!config) return notAnswerable("Lane Pilot is not configured for this project; redispatch the task instead");
    const reopened = await reopen.reopenAttempt({
      projectId:input.projectId, runId:input.runId, taskId:input.taskId, pmThreadId:input.pmThreadId,
      attempt, threadId:ready.threadId, workspacePath:ready.workspacePath, config, contract:parsed.data,
      reason:"the PM answered the writer's question", turn:answerTurnPrompt(input.answer), qaAnswer:input.answer,
    });
    if (!reopened.ok) return notAnswerable(reopened.hint);
    return { ok:true, runId:input.runId, taskId:input.taskId, attemptId:attempt.id, writerThreadId:ready.threadId, state:"running",
      note:"The writer continues in its own thread; no attempt was spent. Poll lane_pilot_wait_writer with the same runId. The question and the answer are kept in the task folder's QA.md." };
  }

  return { answerWriter };
}
