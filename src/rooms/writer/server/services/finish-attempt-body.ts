import { breakerKey } from "@lane-pilot/resilience";
import { providerLimitNotice } from "@lane-pilot/models";
import { bestEffort, outputText, stringAt } from "@lane-pilot/kit";
import type { ServerCore } from "../../../contracts/server";
import { recordGateEvaluation } from "../../../runs/server";
import { countAttempts, failureFieldsOf, getAttempt, getReasoningTrace, noteAttemptStream, transitionAttempt } from "../../../storage";
import { recordTaskQuestions } from "../../../tasks/server";
import type { AttemptFinished } from "./attempt-finished";
import { mergeAcceptedAttempt } from "./finish-merge";
import type { FinishInput, Services } from "./finish-types";
import { writerLeftWorktree } from "./left-worktree";
import { runPostValidationGates } from "./post-validation-gates";
import { wasAnsweredByDefault } from "../repositories/question-default-store";
import { noteTaskQa } from "./reopen-attempt";
import { keepWriterNotes, recordWriterReport, writerNotePath } from "./task-home";
import { mountVerificationAttemptFinished } from "./verification";
import { watchWriterRun } from "./watch-writer";
import { needsHumanQuestion } from "../../models/writer-task";
import { providerStreamError, WRITER_STREAM_ERROR } from "../../models/writer-brief-feedback";

export async function finishWriterAttemptBody(
  ctx: ServerCore,
  services: Services,
  verification: ReturnType<typeof mountVerificationAttemptFinished>,
  input: FinishInput,
  facts: Pick<AttemptFinished, "writerStopped">,
): Promise<Record<string, unknown>> {
  const { bb, db, getThreadBounded, host } = ctx;
  // The PM's stop and a failure can land together: an attempt whose stop was requested ends canceled whatever failed
  // (cancel_requested has only canceled, blocked and accepted to go to, and the owner asked for the stop).
  const endedByStop = (reason: string, threadId = input.writerThreadId): Record<string, unknown> | null => {
    if (getAttempt(db, input.attemptId)?.state !== "cancel_requested") return null;
    transitionAttempt(db, input.attemptId, "canceled", { threadId, reason: `writer stop observed after: ${reason}`.slice(0, 500) });
    return { status: "canceled", attemptId: input.attemptId, writerThreadId: threadId };
  };
  // The PM's stop can land after validation passed (cab-unslop-kit.2, 2026-10-31: canceled 8 s after its validate gate). The row was
  // canceled by cancel.ts while this finish went on: it ran the critics, told the PM «passed its checks, waits for the owner's word»,
  // held the task's files for 32 min (start.ts `admitted`, so the sibling task queued behind it), and after the word died on the
  // removed worktree and parked a canceled task. Every stage boundary after validation reads the row first.
  const stoppedMeanwhile = (where: string, threadId = input.writerThreadId): Record<string, unknown> | null => {
    const state = getAttempt(db, input.attemptId)?.state;
    if (state === "cancel_requested") return endedByStop(where, threadId);
    return state === "canceled" ? { status: "canceled", attemptId: input.attemptId, writerThreadId: threadId } : null;
  };
  const providerFailed = (reason: string) => {
    const stopped = endedByStop(reason);
    if (stopped) return stopped;
    transitionAttempt(db, input.attemptId, "provider_error", { reason });
    return { status: "provider_error", reason, attemptId: input.attemptId, writerThreadId: input.writerThreadId };
  };
  // A provider limit the OpenCode log named holds the writer's provider/model open until its reset time (else the cooldown).
  const holdProviderLimit = (until?: number) => {
    const trace = getReasoningTrace(db, input.attemptId);
    if (trace) services.providerBreaker.record(breakerKey(trace.providerId, trace.model), "exhausted", Date.now(), until);
  };
  let endMerge = () => undefined as void;
  try {
    const watched = await watchWriterRun({ ctx, services, input, facts, providerFailed, holdProviderLimit });
    if (watched) return watched;
    const currentAttempt = getAttempt(db, input.attemptId);
    if (currentAttempt?.state === "cancel_requested" || currentAttempt?.state === "canceled") {
      if (currentAttempt.state === "cancel_requested") transitionAttempt(db, input.attemptId, "canceled", { threadId: input.writerThreadId, reason: "writer stop observed before validation" });
      return { status: "canceled", attemptId: input.attemptId, writerThreadId: input.writerThreadId };
    }
    // A writer that moved its thread out of its worktree did its work elsewhere (maybe the main checkout): nothing to
    // validate here and no retry in place; the PM learns where the edits went.
    const left = await writerLeftWorktree(bb.sdk as never, input.writerThreadId, currentAttempt?.workspace_path ?? input.config.writerWorkspacePath);
    if (left) {
      const reason = `writer_left_worktree: the writer thread moved to ${left}; its edits there are not this task's — check that folder and redispatch`;
      bb.log.warn(`Lane Pilot ${input.taskId}: ${reason}`);
      transitionAttempt(db, input.attemptId, "blocked", { reason });
      return { status: "blocked", reason, attemptId: input.attemptId, writerThreadId: input.writerThreadId };
    }
    // A writer that stopped to ask the owner is not a failed attempt: no retry, no fallback, the question goes to the PM.
    const answer = outputText(await bb.sdk.threads.output({ threadId: input.writerThreadId }).catch((cause: unknown) => { ctx.log(`writer ${input.taskId}: thread output unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return ""; }));
    // The run's stream on the attempt dossier (SMA ar_run_dir): hashed and excerpted, kept on the trace.
    // A dossier note is never a reason to fail the finish: a database or parse error is logged and the finish goes on.
    try { noteAttemptStream(db, input.attemptId, answer); }
    catch (cause) { ctx.log(`writer ${input.taskId}: stream note not kept: ${cause instanceof Error ? cause.message : String(cause)}`); }
    // The writer's real report (its thread's output) is the attempt's report.md in the task home (docs/task-folder.md): plan-fact, the
    // critic and the acceptance read it there by the manifest. A later attempt's report supersedes this one.
    if (answer.trim()) await recordWriterReport(ctx, input, answer);
    // The provider's own limit notice instead of a report: the task never ran, so another model takes it, uncharged.
    const limit = providerLimitNotice(answer);
    if (limit) {
      const reason = `writer_provider_limit: ${limit}`;
      return providerFailed(reason);
    }
    // The provider cut the turn off mid-work: no answer to check yet; the same writer continues in place (sticky.ts).
    const dropped = providerStreamError(answer);
    if (dropped) return providerFailed(`${WRITER_STREAM_ERROR}: ${dropped}`);
    const question = needsHumanQuestion(answer);
    if (question) {
      // Asked again after the machine's default answer (question-timeout.ts): nobody is coming, the attempt ends and frees the task.
      const askedAgain = await wasAnsweredByDefault(bb.storage.kv as never, input.runId, input.taskId);
      const reason = askedAgain ? `verdict_block: question_unanswered: the writer asked again after the default answer. It asked: ${question}` : `needs_human: ${question}`;
      recordGateEvaluation(db, { attemptId: input.attemptId, projectId: input.projectId, runId: input.runId, taskId: input.taskId, gate: "accept", status: "skipped",
        attempt: countAttempts(db, input.runId, input.taskId), input: JSON.stringify(input.task), summary: { reason: "needs_human" } });
      transitionAttempt(db, input.attemptId, "blocked", { reason });
      // The parked question is a file in the task folder, not only attempt.reason: a person, the next session or a
      // reload sees what the writer waits for; a CHECKPOINT.md the writer left is kept with it (sma m_q_exec_ckpt).
      const parkedWorkspace = getAttempt(db, input.attemptId)?.workspace_path ?? input.config.writerWorkspacePath;
      if (parkedWorkspace) {
        await noteTaskQa(ctx, { hostId: input.config.hostId, workspacePath: parkedWorkspace, taskId: input.taskId, attemptId: input.attemptId, question });
        const checkpoint = await host.call("readBoundedFile", { requestedHostId: input.config.hostId, projectCwd: parkedWorkspace,
          relativePath: writerNotePath(db, input.taskId, input.attemptId, "CHECKPOINT.md"), offset: 0, maxLines: 200 }, { hostId: input.config.hostId, timeoutMs: 10_000 }).then((file) => file.content, () => null);
        await keepWriterNotes(ctx, input, { "CHECKPOINT.md": checkpoint });
        if (checkpoint) await bestEffort(ctx.log, "writer questions record", recordTaskQuestions(bb.storage.kv, input.runId, input.taskId,
          { questions: [{ kind: "open", question }], checkpoint: checkpoint.slice(0, 2000), at: Date.now() }), undefined);
      }
      return { status: "blocked", reason, attemptId: input.attemptId, writerThreadId: input.writerThreadId };
    }
    const checked = await services.validateWriterResult({
      config: input.config, projectId: input.projectId, runId: input.runId, taskId: input.taskId,
      attempt: countAttempts(db, input.runId, input.taskId), task: input.task, writerThreadId: input.writerThreadId, attemptId: input.attemptId,
      dirtBefore: input.dirtBefore,
    });
    if (checked.status !== "accepted") {
      recordGateEvaluation(db, { attemptId: input.attemptId, projectId: input.projectId, runId: input.runId, taskId: input.taskId, gate: "accept", status: "rejected",
        attempt: countAttempts(db, input.runId, input.taskId), input: JSON.stringify(input.task), summary: { writerStatus: checked.status } });
      const stopped = endedByStop(checked.reason ?? checked.status);
      if (stopped) return stopped;
      transitionAttempt(db, input.attemptId, checked.status, { reason: checked.reason, ...failureFieldsOf(checked) });
      return { ...checked, attemptId: input.attemptId, writerThreadId: input.writerThreadId };
    }
    { const stopped = stoppedMeanwhile("validation"); if (stopped) return stopped; }
    const gated = await runPostValidationGates({
      ctx, services, input, candidate: checked, writerThreadId: input.writerThreadId, answer, endedByStop, stoppedMeanwhile,
    });
    if (gated.kind !== "passed") return gated.kind === "terminal" ? gated.result : { status: "blocked", reason: "owner_word_pending", attemptId: input.attemptId, writerThreadId: gated.writerThreadId };
    return await mergeAcceptedAttempt({
      ctx, services, input, candidate: gated.candidate, writerThreadId: gated.writerThreadId,
      review: gated.review, checklist: gated.checklist, verification,
      endedByStop, setEndMerge: (end) => { endMerge = end; },
    });
  } catch (cause) {
    const thread = await getThreadBounded(input.writerThreadId);
    if (stringAt(thread, "status") === "error") {
      return providerFailed(cause instanceof Error ? cause.message : String(cause));
    }
    throw cause;
  } finally { endMerge(); }
}
