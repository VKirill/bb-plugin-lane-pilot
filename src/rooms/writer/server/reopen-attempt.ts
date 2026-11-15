import { resolve } from "node:path";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { countAttempts, getAttempt, getRun, getTaskPlan, transitionAttempt } from "../../storage";
import { taskFolderRel } from "../../verification";
import { closeWriterStages, reopenWriterStages } from "../../runs/server";
import { stringAt, isNotFound, orMiss } from "@lane-pilot/kit";
import { writeReplacing } from "../../storage";
import { ASK_PM_MARKER } from "./writer-task";
import type { ServerCore } from "../../contracts/server";

import { saveFollowUp } from "./sticky";
import { writerLeftWorktree } from "./left-worktree";
import { appendTaskQaHome } from "./task-home";
import { runOnHost } from "@lane-pilot/host-calls";
import { sendServiceMessage } from "../../relay/server";
import { syncOwnsBarrier } from "./owns-barrier-sync";

import type { WriterStartApi } from "./start";
import type { WriterStateApi } from "./state";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  startWriterTask: WriterStartApi["startWriterTask"];
}

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

/** BB's public plugin-id syntax (bb-core packages/domain/src/plugin-id.ts `pluginIdSchema`). */
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/u;
const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? value as Record<string, unknown> : null);

/**
 * The only send failure that proves the turn did not reach the writer: a dispatch hook refused it before BB queued it.
 * Only `dispatchRejection` (bb-core apps/server/src/services/threads/dispatch-hooks.ts:218) makes it, and the SDK's
 * BbHttpError carries it as status 409, code and flat body `{code:"dispatch_rejected", details:{pluginId}}`: the whole
 * tuple must hold, the message text is never read. Anything else — another 4xx, a 5xx, a timeout, a lost reply — may
 * come after the turn was queued and proves nothing (send-refusal-sdk-contract-audit.md, 2026-11-15).
 */
export function sendRefused(cause: unknown): boolean {
  const err = record(cause);
  const body = record(err?.body);
  const details = record(body?.details);
  return err?.status === 409 && err.code === "dispatch_rejected" && body?.code === "dispatch_rejected"
    && typeof details?.pluginId === "string" && PLUGIN_ID.test(details.pluginId);
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
    `If the task cannot be done as written, change no files and answer with the first line \`${ASK_PM_MARKER} <one question>\`.`,
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
/**
 * The Q&A note of a task: in the attempt folder of its home (and the running worktree's copy) for a task with a home, in the old task folder's
 * QA.md for a task dispatched before the switch. Never both: one task stays on one layout (docs/task-folder.md).
 */
export async function noteTaskQa(ctx: Pick<ServerCore, "bb" | "db">, input: { hostId: string; workspacePath: string; taskId: string; attemptId?: string | null; question: string; answer?: string }): Promise<void> {
  if (await appendTaskQaHome(ctx, { taskId: input.taskId, attemptId: input.attemptId ?? null, question: input.question, ...(input.answer !== undefined ? { answer: input.answer } : {}), mirrorRoot: input.workspacePath })) return;
  await appendTaskQa(ctx.bb, input);
}

/**
 * Appends the question and the answer to the task folder's QA.md; a failed write never fails its caller. `answer`
 * absent marks the entry open — a writer parked on NEEDS_HUMAN leaves its question on disk for a person, the next
 * session or a reload (sma m_q_exec_ckpt).
 */
export async function appendTaskQa(bb: ServerCore["bb"], input: { hostId: string; workspacePath: string; taskId: string; question: string; answer?: string }): Promise<void> {
  const rel = taskFolderRel(input.taskId);
  if (!rel) return;
  const path = resolve(input.workspacePath, rel, "QA.md");
  try {
    const existing = await orMiss(Promise.resolve().then(() => bb.sdk.files.read({ hostId: input.hostId, rootPath: input.workspacePath, path })), null, isNotFound);
    const prior = existing && typeof existing === "object" && typeof (existing as { content?: unknown }).content === "string"
      ? (existing as { content: string }).content : null;
    const answerLine = input.answer === undefined ? "A: open — the writer is parked here" : `A (PM): ${input.answer.trim().slice(0, 4000)}`;
    const entry = `## ${new Date().toISOString()}\nQ (writer): ${input.question}\n${answerLine}\n`;
    const content = prior ? `${prior.trimEnd()}\n\n${entry}\n` : `# Q&A — ${input.taskId}\n\n${entry}\n`;
    await writeReplacing(bb.sdk.files, { hostId: input.hostId, rootPath: input.workspacePath, path, content, createParents: true });
  } catch (cause) {
    bb.log.warn(`Lane Pilot could not record the Q&A of ${input.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export function createAttemptReopen(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, db, getThreadBounded, host, log } = ctx;

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
    const left = await writerLeftWorktree(bb.sdk as never, attempt.thread_id, attempt.workspace_path);
    if (left) return { ok: false, hint: `the writer thread left its worktree for ${left}; check that folder for stray edits and redispatch the task instead` };
    return { ok: true, threadId: attempt.thread_id, workspacePath: run.writer_workspace_path };
  }

  /**
   * Reopens the attempt under the given contract. A turn that cannot be delivered puts the attempt back as it was, still
   * blocked; the caller then puts its own stored contract back. With `previousContract` (an in-place change) the owns
   * barrier follows the new owns_paths before anything else changes, and back to the old one when the turn is not delivered:
   * a writer is never told to edit a file the OS still refuses it (EXT05). `sideEffects: "unknown"`: the barrier's state
   * on the host is not known.
   */
  async function reopenAttempt(input: {
    projectId: string; runId: string; taskId: string; pmThreadId: string;
    attempt: NonNullable<ReturnType<typeof getAttempt>>; threadId: string; workspacePath: string;
    config: PrototypeConfig; contract: TaskV2; previousContract?: TaskV2;
    reason: string; turn: string; qaAnswer: string;
  }): Promise<{ ok: true; deliveryUnknown?: true } | { ok: false; hint: string; sideEffects?: "unknown" }> {
    const { attempt, config, runId, taskId, threadId } = input;
    // The worktree may be gone (a sweep, a reboot): a turn sent there fails on its first command and the writer looks elsewhere.
    if (attempt.workspace_path) {
      // Only a definite «no such folder» refuses; a host that does not answer is no proof, and the turn goes as before.
      const there = await runOnHost(host, { hostId: config.hostId, cwd: attempt.workspace_path, command: "true", timeoutSec: 15 })
        .then((ran) => (ran.exitCode === 0 ? "" : `${ran.stderr ?? ""}`), (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
      if (/ENOENT|no such file|not a directory/i.test(there)) return { ok: false, hint: "the writer's worktree is gone; redispatch the task instead (its work is in ~/.lane-pilot/released/ if it was saved)" };
    }
    const barrierInput = { projectId: input.projectId, runId, hostId: config.hostId, worktreePath: attempt.workspace_path };
    if (input.previousContract) {
      const barrier = await syncOwnsBarrier(ctx, { ...barrierInput, from: input.previousContract, to: input.contract });
      if (!barrier.ok) return { ok: false, hint: barrier.hint, ...(barrier.uncertain ? { sideEffects: "unknown" as const } : {}) };
    }
    const barrierBack = async () => (input.previousContract
      ? await syncOwnsBarrier(ctx, { ...barrierInput, from: input.contract, to: input.previousContract }) : { ok: true as const });
    // A refused move (false, or an illegal one that throws and changes nothing) comes before any turn: the same refusal
    // either way, so the caller puts its old contract back, and the barrier goes back with it.
    const moved = (() => { try { return { ok: transitionAttempt(db, attempt.id, "running", { threadId }) }; }
      catch (cause) { return { ok: false, why: cause instanceof Error ? cause.message : String(cause) }; } })();
    if (!moved.ok) {
      const back = await barrierBack();
      const hint = `the attempt can no longer be reopened${typeof moved.why === "string" ? ` (${moved.why.slice(0, 200)})` : ""}; redispatch the task instead`;
      return back.ok ? { ok: false, hint } : { ok: false, hint: `${hint}; ${back.hint}`, sideEffects: "unknown" };
    }
    reopenWriterStages(db, runId, taskId, `reopened: ${input.reason}`);
    const since = Date.now();
    await saveFollowUp(bb.storage.kv, attempt.id, since);
    let deliveryUnknown = false;
    try {
      await sendServiceMessage(bb, { threadId, text: input.turn, senderThreadId: input.pmThreadId });
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      if (!sendRefused(cause)) {
        // The turn may have reached the writer: nothing is put back. The attempt goes on under the changed contract, whose
        // barrier is in place, and the writer loop below reads whatever the thread answers (its old question again if nothing came).
        deliveryUnknown = true;
        log(`writer ${taskId}: delivery of the turn to ${threadId} is not confirmed (${why}); attempt ${attempt.id} goes on`);
      } else {
        // The server refused the turn, so nothing was delivered: the attempt and its stages go back, still answerable.
        transitionAttempt(db, attempt.id, "blocked", { threadId, reason: attempt.reason ?? undefined });
        closeWriterStages(db, { runId, taskId, plan: getTaskPlan(db, taskId) ?? "",
          terminal: "failed", attempt: countAttempts(db, runId, taskId), reason: attempt.reason, threadId });
        // The caller puts the old contract back: the barrier goes back with it.
        const back = await barrierBack();
        const hint = `the turn could not be delivered to the writer thread (${why}); the task stays blocked — redispatch it instead`;
        return back.ok ? { ok: false, hint } : { ok: false, hint: `${hint}; ${back.hint}`, sideEffects: "unknown" };
      }
    }
    await noteTaskQa({ bb, db }, { hostId: config.hostId, workspacePath: input.workspacePath, taskId, attemptId: attempt.id, question: writerQuestion(attempt.reason), answer: input.qaAnswer });
    const workspace = acceptedTaskWorkspace(runId, taskId, input.workspacePath, input.contract, attempt.id);
    services.startWriterTask({
      projectId: input.projectId, runId, taskId, firstAttemptId: attempt.id,
      pmThreadId: input.pmThreadId, writerThreadId: threadId,
      config: { ...config, writerWorkspacePath: workspace.path }, task: workspace.task,
      plan: getTaskPlan(db, taskId) ?? input.contract.objective, dirtBefore: attempt.dirt_before, turnSent: true,
    });
    log(`writer ${taskId}: attempt ${attempt.id} reopened in thread ${threadId} (${input.reason})`);
    return deliveryUnknown ? { ok: true, deliveryUnknown: true } : { ok: true };
  }

  return { checkReopenable, reopenAttempt };
}
