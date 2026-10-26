import { getRun, listUnansweredWriterQuestions, transitionAttempt } from "../../storage";
import { isRunHalted, isRunPaused } from "../../runs/server";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { createWriterAnswer } from "./answer";
import { markAnsweredByDefault, SAFE_DEFAULT_ANSWER, WRITER_QUESTION_WAIT_MS, wasAnsweredByDefault } from "./question-default";
import { writerQuestion } from "./reopen-attempt";

export type QuestionSweepAction = { taskId: string; action: "answered_by_default" | "ended" };

/**
 * A writer's question is a blocked attempt with a `needs_human:` reason (reopen-attempt.ts); the PM or any door answers it with
 * lane_pilot_answer_writer. When nobody does within WRITER_QUESTION_WAIT_MS the machine answers itself once with the safest default;
 * when that cannot be delivered (the writer's thread is gone) or the writer asked again after it, the attempt ends with the question
 * in its reason, so the task no longer holds its folder for a person who is not coming. No attempt is spent either way.
 */
export function createWriterQuestionTimeout(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const { answerWriter } = createWriterAnswer(ctx, services);

  async function end(row: ReturnType<typeof listUnansweredWriterQuestions>[number], why: string): Promise<void> {
    const question = writerQuestion(row.reason).slice(0, 400);
    // The legal way from «blocked» to a new reason runs through the running state (the same hop an answer takes).
    if (!transitionAttempt(db, row.id, "running", row.thread_id ? { threadId: row.thread_id } : {})) return;
    transitionAttempt(db, row.id, "blocked", { ...(row.thread_id ? { threadId: row.thread_id } : {}),
      reason: `verdict_block: question_unanswered: ${why}. The writer asked: ${question}. Send the task again with the contract settled (owns_paths, checks) or with the answer in its objective` });
    if (row.thread_id) await services.providerRetry?.abandon(row.thread_id);
  }

  async function sweep(now = Date.now(), signal?: AbortSignal): Promise<QuestionSweepAction[]> {
    const done: QuestionSweepAction[] = [];
    for (const row of listUnansweredWriterQuestions(db)) {
      if (signal?.aborted || ctx.isDisposed()) break;
      if (now - row.updated_at < WRITER_QUESTION_WAIT_MS) continue;
      if (services.activeWriterTasks.has(`${row.run_id}:${row.task_id}`)) continue;
      // A stopped or paused run holds its questions until it is resumed.
      if (await isRunHalted(bb.storage.kv as never, row.run_id) || await isRunPaused(bb.storage.kv as never, row.run_id)) continue;
      const run = getRun(db, row.run_id);
      if (await wasAnsweredByDefault(bb.storage.kv as never, row.run_id, row.task_id) || !run?.pm_thread_id) {
        await end(row, "nobody answered and the writer cannot be asked to go on");
        done.push({ taskId: row.task_id, action: "ended" });
        continue;
      }
      await markAnsweredByDefault(bb.storage.kv as never, row.run_id, row.task_id, now);
      const answered = await answerWriter({ projectId: row.project_id, runId: row.run_id, pmThreadId: run.pm_thread_id, taskId: row.task_id, answer: SAFE_DEFAULT_ANSWER });
      if (answered.ok) {
        ctx.log(`writer ${row.task_id}: its question stood unanswered for an hour; the machine answered with the safe default`);
        done.push({ taskId: row.task_id, action: "answered_by_default" });
      } else {
        await end(row, "nobody answered and the writer's thread cannot take the default answer");
        done.push({ taskId: row.task_id, action: "ended" });
      }
    }
    return done;
  }

  return { sweepWriterQuestions: sweep };
}
