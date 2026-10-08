import { taskV2Schema } from "../../contracts";
import { countAttempts, getAttempt, getRun, getTask, getTaskPlan, listAttemptsForTask, transitionAttempt } from "../../database";
import { taskFolderRel } from "../../rooms/verification/git-integrate";
import { closeWriterStages, reopenWriterStages } from "../stage-records";
import { stringAt } from "../values";
import { answerTurnPrompt } from "../writer-task";
import { resolve } from "node:path";
import type { ServerCore } from "../core";
import type { Services } from "../services";
import { saveFollowUp } from "./sticky";
import { sendServiceMessage } from "../../rooms/relay/server/service-message";

/** A blocked attempt whose reason is the writer's own question, not a fault. */
const NEEDS_HUMAN_REASON = /^needs_human:/i;

/**
 * The PM's answer to a writer's NEEDS_HUMAN question: the same attempt reopens in the same writer thread and
 * worktree, the answer goes in as a turn, and the normal wait → validate → accept/retry loop takes over. The
 * answer round creates no attempt, so the task's charged attempt count does not grow.
 */
export function createWriterAnswer(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, getThreadBounded, log } = ctx;

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
    if (!attempt || attempt.state !== "blocked" || !NEEDS_HUMAN_REASON.test(attempt.reason ?? "")) {
      return notAnswerable("the task's latest attempt is not blocked with a writer question; redispatch the task instead");
    }
    if (services.activeWriterTasks.has(`${input.runId}:${input.taskId}`)) {
      return notAnswerable("the task's writer is still finishing; poll lane_pilot_wait_writer first");
    }
    if (!attempt.thread_id || !attempt.workspace_path) {
      return notAnswerable("the attempt has no writer thread; redispatch the task instead");
    }
    const thread = await getThreadBounded(attempt.thread_id);
    if (stringAt(thread, "status") !== "idle" || (thread as { archivedAt?: unknown } | null)?.archivedAt) {
      return notAnswerable("the writer thread is gone or busy; redispatch the task instead");
    }
    if (!run.writer_workspace_path) return notAnswerable("the run has no writer workspace; redispatch the task instead");
    const config = await configForRun(input.projectId, run);
    if (!config) return notAnswerable("Lane Pilot is not configured for this project; redispatch the task instead");
    if (!transitionAttempt(db, attempt.id, "running", { threadId:attempt.thread_id })) {
      return notAnswerable("the attempt can no longer be reopened; redispatch the task instead");
    }
    reopenWriterStages(db, input.runId, input.taskId, "reopened: the PM answered the writer's question");
    const since = Date.now();
    await saveFollowUp(bb.storage.kv, attempt.id, since);
    const question = (attempt.reason ?? "").replace(NEEDS_HUMAN_REASON, "").trim();
    try {
      await sendServiceMessage(bb, { threadId:attempt.thread_id, text:answerTurnPrompt(input.answer), senderThreadId:input.pmThreadId });
    } catch (cause) {
      // Nothing was delivered: put the attempt and its stages back the way they were, still answerable.
      transitionAttempt(db, attempt.id, "blocked", { threadId:attempt.thread_id, reason:attempt.reason ?? undefined });
      closeWriterStages(db, { runId:input.runId, taskId:input.taskId, plan:getTaskPlan(db, input.taskId) ?? "",
        terminal:"failed", attempt:countAttempts(db, input.runId, input.taskId), reason:attempt.reason, threadId:attempt.thread_id });
      return notAnswerable(`the answer could not be delivered to the writer thread (${cause instanceof Error ? cause.message : String(cause)}); the task stays blocked — redispatch it instead`);
    }
    await appendQa({ hostId:config.hostId, workspacePath:run.writer_workspace_path, taskId:input.taskId, question, answer:input.answer });
    const workspace = acceptedTaskWorkspace(input.runId, input.taskId, run.writer_workspace_path, parsed.data, attempt.id);
    services.startWriterTask({
      projectId:input.projectId, runId:input.runId, taskId:input.taskId, firstAttemptId:attempt.id,
      pmThreadId:input.pmThreadId, writerThreadId:attempt.thread_id,
      config:{ ...config, writerWorkspacePath:workspace.path }, task:workspace.task,
      plan:getTaskPlan(db, input.taskId) ?? parsed.data.objective, dirtBefore:attempt.dirt_before,
    });
    log(`writer ${input.taskId}: the PM answered its question; attempt ${attempt.id} continues in thread ${attempt.thread_id}`);
    return { ok:true, runId:input.runId, taskId:input.taskId, attemptId:attempt.id, writerThreadId:attempt.thread_id, state:"running",
      note:"The writer continues in its own thread; no attempt was spent. Poll lane_pilot_wait_writer with the same runId. The question and the answer are kept in the task folder's QA.md." };
  }

  /** Appends the question and the answer to the task folder's QA.md; a failed write never fails the answer. */
  async function appendQa(input:{ hostId:string; workspacePath:string; taskId:string; question:string; answer:string }): Promise<void> {
    const rel = taskFolderRel(input.taskId);
    if (!rel) return;
    const path = resolve(input.workspacePath, rel, "QA.md");
    try {
      const existing = await Promise.resolve()
        .then(() => bb.sdk.files.read({ hostId:input.hostId, rootPath:input.workspacePath, path }))
        .catch(() => null);
      const prior = existing && typeof existing === "object" && typeof (existing as { content?:unknown }).content === "string"
        ? (existing as { content:string }).content : null;
      const entry = `## ${new Date().toISOString()}\nQ (writer): ${input.question}\nA (PM): ${input.answer.trim().slice(0, 4000)}\n`;
      const content = prior ? `${prior.trimEnd()}\n\n${entry}\n` : `# Q&A — ${input.taskId}\n\n${entry}\n`;
      await bb.sdk.files.write({ hostId:input.hostId, rootPath:input.workspacePath, path,
        content, contentEncoding:"utf8", createParents:true, expectedSha256:null });
    } catch (cause) {
      bb.log.warn(`Lane Pilot could not record the Q&A of ${input.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return { answerWriter };
}
