import { getRun, listUnansweredWriterQuestions, transitionAttempt } from "../../storage";
import { isRunHalted, isRunPaused } from "../../runs/server";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { postOwnerItem } from "../../owner-waiting";
import { createWriterAnswer } from "./answer";
import { isProductDecision, markAnsweredByDefault, SAFE_DEFAULT_ANSWER, WRITER_QUESTION_WAIT_MS, wasAnsweredByDefault } from "./question-default";
import { writerQuestion } from "./reopen-attempt";

export type QuestionSweepAction = { taskId: string; action: "answered_by_default" | "ended" | "left_to_owner" };

/**
 * A writer's question is a blocked attempt with a `needs_human:` reason (reopen-attempt.ts); the PM or any door answers it with
 * lane_pilot_answer_writer. When nobody does within WRITER_QUESTION_WAIT_MS the machine answers itself once with the safest default;
 * when that cannot be delivered (the writer's thread is gone) or the writer asked again after it, the attempt ends with the question
 * in its reason, so the task no longer holds its folder for a person who is not coming. No attempt is spent either way.
 * A product decision (isProductDecision) is not answered by default: the attempt ends at once with the question in its reason and one
 * line goes to the owner's list with a wake, so the owner sees what the product is waiting on.
 */
export function createWriterQuestionTimeout(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const { answerWriter } = createWriterAnswer(ctx, services);

  async function end(row: ReturnType<typeof listUnansweredWriterQuestions>[number], why: string, asked = writerQuestion(row.reason).slice(0, 400)): Promise<void> {
    const question = asked;
    // The legal way from «blocked» to a new reason runs through the running state (the same hop an answer takes).
    if (!transitionAttempt(db, row.id, "running", row.thread_id ? { threadId: row.thread_id } : {})) return;
    transitionAttempt(db, row.id, "blocked", { ...(row.thread_id ? { threadId: row.thread_id } : {}),
      reason: `verdict_block: question_unanswered: ${why}. The writer asked: ${question}. Send the task again with the contract settled (owns_paths, checks) or with the answer in its objective` });
    if (row.thread_id) await services.providerRetry?.abandon(row.thread_id);
  }

  /** A product decision after the hour: the attempt ends (uncharged, see isOwnerDecision) and the owner's list gets the question. */
  async function leaveToOwner(row: ReturnType<typeof listUnansweredWriterQuestions>[number]): Promise<void> {
    const question = writerQuestion(row.reason).slice(0, 400);
    postOwnerItem(db as never, { key: `writer-question:${row.run_id}:${row.task_id}`, source: "writer", kind: "product_decision", projectId: row.project_id, wake: true,
      what: `${row.task_id}: ${question}`, why: "A writer asked a product decision and nobody answered for an hour; the machine does not decide it by default. Answer it in the task's objective and send the task again.",
      evidence: [{ kind: "attempt", ref: row.id }, { kind: "task", ref: row.task_id }] });
    await end(row, "product decision, left to the owner", question);
  }

  async function sweep(now = Date.now(), signal?: AbortSignal): Promise<QuestionSweepAction[]> {
    const done: QuestionSweepAction[] = [];
    for (const row of listUnansweredWriterQuestions(db)) {
      if (signal?.aborted || ctx.isDisposed()) break;
      if (now - row.updated_at < WRITER_QUESTION_WAIT_MS) continue;
      if (services.activeWriterTasks.has(`${row.run_id}:${row.task_id}`)) continue;
      // A stopped or paused run holds its questions until it is resumed.
      if (await isRunHalted(bb.storage.kv as never, row.run_id) || await isRunPaused(bb.storage.kv as never, row.run_id)) continue;
      if (isProductDecision(writerQuestion(row.reason))) {
        await leaveToOwner(row);
        done.push({ taskId: row.task_id, action: "left_to_owner" });
        continue;
      }
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
