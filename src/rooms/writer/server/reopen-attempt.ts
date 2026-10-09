import { resolve } from "node:path";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { countAttempts, getAttempt, getRun, getTaskPlan, transitionAttempt } from "../../storage";
import { taskFolderRel } from "../../verification";
import { closeWriterStages, reopenWriterStages } from "../../runs/server";
import { stringAt } from "../../core/server";
import { NEEDS_HUMAN_MARKER } from "./writer-task";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { saveFollowUp } from "./sticky";
import { sendServiceMessage } from "../../relay/server";

/** A blocked attempt whose reason is the writer's own question, not a fault. */
const NEEDS_HUMAN_REASON = /^needs_human:/i;

export type FieldChange = { field: string; from: unknown; to: unknown };

/** True when the attempt stopped with the writer's own question: the PM answers it, or fixes the contract under it. */
export function awaitsWriterAnswer(attempt: { state: string; reason?: string | null } | null | undefined): boolean {
  return attempt?.state === "blocked" && NEEDS_HUMAN_REASON.test(attempt.reason ?? "");
}

/** The writer's question itself, without its NEEDS_HUMAN marker. */
export function writerQuestion(reason: string | null | undefined): string {
  return (reason ?? "").replace(NEEDS_HUMAN_REASON, "").trim();
}

const shown = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
};
const changeLines = (changes: FieldChange[]) => changes.map((change) => `- ${change.field}: ${shown(change.from)} → ${shown(change.to)}`).join("\n");

/** The turn a writer gets when the PM fixed its contract under its question: every changed field, old and new. */
export function contractFixTurnPrompt(input: { question: string; changes: FieldChange[] }): string {
  return [
    `The PM fixed your task's contract in place; the attempt continues in this thread and worktree, and no attempt was spent. Your question was: ${input.question}`,
    `Changed fields, old → new. The new value applies from now on, and validation uses it:\n${changeLines(input.changes)}`,
    "The setup rules from your first brief still hold: only owns_paths (the new one, if it changed), no commits or merges, no npm install.",
    `If the task cannot be done as written, change no files and answer with the first line \`${NEEDS_HUMAN_MARKER} <one question>\`.`,
    "Run the verification commands, then answer with the changed paths and result.",
  ].join("\n\n");
}

/** The Q&A entry of a contract fix: what the PM changed, in the same form as the writer's turn. */
export function contractFixRecord(changes: FieldChange[]): string {
  return `The PM fixed the contract in place (no attempt spent):\n${changeLines(changes)}`;
}

/**
 * Shared by lane_pilot_answer_writer and lane_pilot_update_task: a blocked attempt whose writer asked a question reopens
 * in its own writer thread and worktree, the turn goes in, the stages run again, and the Q&A is kept. No attempt is charged.
 */
export function createAttemptReopen(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, db, getThreadBounded, log } = ctx;

  /** Whether the blocked attempt can take a turn now: no writer still finishing, its thread idle, the run has a workspace. */
  async function checkReopenable(input: {
    runId: string; taskId: string;
    run: NonNullable<ReturnType<typeof getRun>>; attempt: NonNullable<ReturnType<typeof getAttempt>>;
  }): Promise<{ ok: true; threadId: string; workspacePath: string } | { ok: false; hint: string }> {
    const { attempt, run } = input;
    if (services.activeWriterTasks.has(`${input.runId}:${input.taskId}`)) {
      return { ok: false, hint: "the task's writer is still finishing; poll lane_pilot_wait_writer first" };
    }
    if (!attempt.thread_id || !attempt.workspace_path) {
      return { ok: false, hint: "the attempt has no writer thread; redispatch the task instead" };
    }
    const thread = await getThreadBounded(attempt.thread_id);
    if (stringAt(thread, "status") !== "idle" || (thread as { archivedAt?: unknown } | null)?.archivedAt) {
      return { ok: false, hint: "the writer thread is gone or busy; redispatch the task instead" };
    }
    if (!run.writer_workspace_path) return { ok: false, hint: "the run has no writer workspace; redispatch the task instead" };
    return { ok: true, threadId: attempt.thread_id, workspacePath: run.writer_workspace_path };
  }

  /**
   * Reopens the attempt under the given contract. A turn that cannot be delivered puts the attempt back as it was, still
   * blocked; the caller then puts its own stored contract back.
   */
  async function reopenAttempt(input: {
    projectId: string; runId: string; taskId: string; pmThreadId: string;
    attempt: NonNullable<ReturnType<typeof getAttempt>>; threadId: string; workspacePath: string;
    config: PrototypeConfig; contract: TaskV2;
    reason: string; turn: string; qaAnswer: string;
  }): Promise<{ ok: true } | { ok: false; hint: string }> {
    const { attempt, config, runId, taskId, threadId } = input;
    if (!transitionAttempt(db, attempt.id, "running", { threadId })) {
      return { ok: false, hint: "the attempt can no longer be reopened; redispatch the task instead" };
    }
    reopenWriterStages(db, runId, taskId, `reopened: ${input.reason}`);
    const since = Date.now();
    await saveFollowUp(bb.storage.kv, attempt.id, since);
    try {
      await sendServiceMessage(bb, { threadId, text: input.turn, senderThreadId: input.pmThreadId });
    } catch (cause) {
      // Nothing was delivered: put the attempt and its stages back the way they were, still answerable.
      transitionAttempt(db, attempt.id, "blocked", { threadId, reason: attempt.reason ?? undefined });
      closeWriterStages(db, { runId, taskId, plan: getTaskPlan(db, taskId) ?? "",
        terminal: "failed", attempt: countAttempts(db, runId, taskId), reason: attempt.reason, threadId });
      return { ok: false, hint: `the turn could not be delivered to the writer thread (${cause instanceof Error ? cause.message : String(cause)}); the task stays blocked — redispatch it instead` };
    }
    await appendQa({ hostId: config.hostId, workspacePath: input.workspacePath, taskId, question: writerQuestion(attempt.reason), answer: input.qaAnswer });
    const workspace = acceptedTaskWorkspace(runId, taskId, input.workspacePath, input.contract, attempt.id);
    services.startWriterTask({
      projectId: input.projectId, runId, taskId, firstAttemptId: attempt.id,
      pmThreadId: input.pmThreadId, writerThreadId: threadId,
      config: { ...config, writerWorkspacePath: workspace.path }, task: workspace.task,
      plan: getTaskPlan(db, taskId) ?? input.contract.objective, dirtBefore: attempt.dirt_before,
    });
    log(`writer ${taskId}: attempt ${attempt.id} reopened in thread ${threadId} (${input.reason})`);
    return { ok: true };
  }

  /** Appends the question and the answer to the task folder's QA.md; a failed write never fails the reopen. */
  async function appendQa(input: { hostId: string; workspacePath: string; taskId: string; question: string; answer: string }): Promise<void> {
    const rel = taskFolderRel(input.taskId);
    if (!rel) return;
    const path = resolve(input.workspacePath, rel, "QA.md");
    try {
      const existing = await Promise.resolve()
        .then(() => bb.sdk.files.read({ hostId: input.hostId, rootPath: input.workspacePath, path }))
        .catch(() => null);
      const prior = existing && typeof existing === "object" && typeof (existing as { content?: unknown }).content === "string"
        ? (existing as { content: string }).content : null;
      const entry = `## ${new Date().toISOString()}\nQ (writer): ${input.question}\nA (PM): ${input.answer.trim().slice(0, 4000)}\n`;
      const content = prior ? `${prior.trimEnd()}\n\n${entry}\n` : `# Q&A — ${input.taskId}\n\n${entry}\n`;
      await bb.sdk.files.write({ hostId: input.hostId, rootPath: input.workspacePath, path,
        content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
    } catch (cause) {
      bb.log.warn(`Lane Pilot could not record the Q&A of ${input.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return { checkReopenable, reopenAttempt };
}
