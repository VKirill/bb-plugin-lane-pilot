import { LP_EVENTS, isTerminalAttemptState } from "@lane-pilot/contracts";
import { outputText, parseJsonOr } from "@lane-pilot/kit";
import { providerLimitNotice } from "@lane-pilot/models";
import { breakerKey } from "@lane-pilot/resilience";
import { postOwnerItem } from "../../../owner-waiting";
import { reportStopGapOwnerItem } from "../../../runs/server";
import {
  getAttempt, getReasoningTrace, getRun, listStageReceipts,
  listUnansweredWriterQuestions, noteAttemptStream, transitionAttempt,
} from "../../../storage";
import type { StepContext, WorkflowEngine } from "../../../workflow";
import { releaseAttemptAdmission } from "../services/attempt-admission";
import { STOP_EXIT_DEADLINE_SEC } from "../../models/attempt-timeouts";
import { emitAttemptEvent } from "../services/attempt-events";
import {
  cleanupAttemptWorkspace, finalizeTerminalFailure, questionSecFor, silenceSecFor,
} from "../services/attempt-step-helpers";
import { handleWriterSubscriptionFallback, startThreadTurnWatcher } from "../services/attempt-turn-watch";
import { recordAndPersistBreaker } from "../services/attempt-admission";
import type { DispatchRuntime } from "../services/dispatch-runtime";
import { writerLeftWorktree } from "../services/left-worktree";
import { createWriterQuestionTimeout } from "../services/question-timeout";
import { noteTaskQa } from "../services/reopen-attempt";
import { recordWriterReport } from "../services/task-home";
import { watchWriterRun } from "../services/watch-writer";
import { sweepWriterSilence } from "../services/writer-silence";
import { needsHumanQuestion } from "../../models/writer-task";
import { providerStreamError, WRITER_STREAM_ERROR } from "../../models/writer-brief-feedback";

type Step = StepContext<DispatchRuntime>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Registers turn-lifecycle executors: silence nudge/stop, turn outcome, answer wait/timeout, and two-condition stop. */
export function registerAttemptTurnExecutors(
  engine: WorkflowEngine,
  resolveRuntime: (ctx: Step) => Promise<DispatchRuntime>,
): void {
  const reg = (key: string, fn: (r: DispatchRuntime, ctx: Step) => Promise<Record<string, unknown>>, extra: { reentrant?: boolean } = {}) =>
    engine.register<DispatchRuntime>(key, {
      ...extra,
      run: async (ctx) => ({ output: await fn(await resolveRuntime(ctx), ctx) }),
    });

  // 1. Nudge silent writer (<= 2 visits on node `nudge`) -> loops back to `wait-turn` with fresh deadline.
  reg("lp.writer-nudge", async (r, ctx) => {
    const attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
    const attempt = getAttempt(r.ctx.db, attemptId);
    const threadId = str(ctx.input.with.writerThreadId) ?? attempt?.thread_id ?? "";
    const sec = silenceSecFor(r);
    const now = engine.now();
    const row = getRun(r.ctx.db, r.runId);
    await sweepWriterSilence({
      bb: r.ctx.bb,
      openAttempts: () => (attempt && threadId ? [{
        id: attempt.id, run_id: attempt.run_id, task_id: attempt.task_id,
        thread_id: threadId, state: attempt.state, project_id: r.projectId, pm_thread_id: row?.pm_thread_id ?? null,
      }] : []),
      getThread: async (id) => r.ctx.bb.sdk.threads.get({ threadId: id }).catch(() => null),
      silenceMinutes: () => sec / 60,
      isDisposed: r.ctx.isDisposed,
      log: (line) => r.ctx.log(line),
    }, now);
    return {
      action: "nudged",
      attemptId,
      writerThreadId: threadId,
      silenceSec: sec,
      until: now + sec * 1_000,
    };
  });

  // 2. Third silence timeout (after 2 nudge visits exhausted) -> stop silent writer turn and release slot.
  reg("lp.writer-stop-silent", async (r, ctx) => {
    const attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
    const attempt = getAttempt(r.ctx.db, attemptId);
    const threadId = str(ctx.input.with.writerThreadId) ?? attempt?.thread_id ?? null;
    const reason = "writer_silent_timeout: stopped after 2 unanswered silence nudges";
    if (threadId) await r.ctx.bb.sdk.threads.stop({ threadId }).catch(() => undefined);
    if (attempt && !isTerminalAttemptState(attempt.state)) {
      transitionAttempt(r.ctx.db, attemptId, "blocked", { ...(threadId ? { threadId } : {}), reason });
    }
    await cleanupAttemptWorkspace(r, attemptId, "blocked");
    await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
    r.ctx.refreshRun?.(r.runId);
    await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId, taskId: r.taskId, state: "blocked", reason }, projectId: r.projectId, now: engine.now() });
    return { reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: true, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
  });

  // 3. Turn-outcome inspection when `wait-turn` wakes on `lp.thread.idle` (or synchronous check).
  reg("lp.turn-outcome", async (r, ctx) => {
    const attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
    const attempt = getAttempt(r.ctx.db, attemptId);
    const writerThreadId = str(ctx.input.with.writerThreadId) ?? attempt?.thread_id ?? "";
    const now = engine.now();
    if (!attempt || attempt.state === "cancel_requested" || attempt.state === "canceled") {
      return {
        status: "stopped",
        attemptId,
        writerThreadId,
        exitTimeoutSec: STOP_EXIT_DEADLINE_SEC,
        exitUntil: now + STOP_EXIT_DEADLINE_SEC * 1_000,
        reason: attempt?.reason ?? "writer stop requested",
      };
    }
    const rtServices = r.services as unknown as Record<string, unknown>;
    const finishInput = { projectId: r.projectId, config: r.config, task: r.task, runId: r.runId, taskId: r.taskId, attemptId, pmThreadId: r.threadId, writerThreadId, dirtBefore: attempt.dirt_before ?? [] };
    const holdProviderLimit = (until?: number) => {
      const trace = getReasoningTrace(r.ctx.db, attemptId);
      const breaker = rtServices.providerBreaker as Parameters<typeof recordAndPersistBreaker>[1] | undefined;
      if (trace && breaker) {
        void recordAndPersistBreaker(r.ctx.bb.storage?.kv as never, breaker, breakerKey(trace.providerId, trace.model), "exhausted", now, until);
      }
    };
    const providerFailed = (reason: string) => {
      r.providerErrorRetries = (r.providerErrorRetries ?? 0) + 1;
      r.primaryFailure = { status: "provider_error", reason, attemptId };
      transitionAttempt(r.ctx.db, attemptId, "provider_error", { reason, ...(writerThreadId ? { threadId: writerThreadId } : {}) });
      return { status: "provider_error", reason, attemptId, writerThreadId };
    };
    try {
      if (typeof (r.ctx.bb.sdk.threads as { get?: unknown }).get === "function" && writerThreadId && typeof rtServices.runBudgetFor === "function") {
        const watched = await watchWriterRun({ ctx: r.ctx, services: rtServices as never, input: finishInput, facts: { writerStopped: false }, providerFailed, holdProviderLimit });
        if (watched && watched.status === "provider_error") {
          const reason = String(watched.reason ?? "provider_error");
          await handleWriterSubscriptionFallback(r, reason, now);
          await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
          return { status: "provider_error", retryable: true, attemptId, writerThreadId, reason };
        }
        if (watched && watched.status === "canceled") {
          return { status: "stopped", attemptId, writerThreadId, exitTimeoutSec: STOP_EXIT_DEADLINE_SEC, exitUntil: now + STOP_EXIT_DEADLINE_SEC * 1_000, reason: "canceled" };
        }
      }
      const left = writerThreadId ? await writerLeftWorktree(r.ctx.bb.sdk as never, writerThreadId, attempt.workspace_path ?? r.config.writerWorkspacePath).catch(() => null) : null;
      if (left) {
        const reason = `writer_left_worktree: the writer thread moved to ${left}; its edits there are not this task's — check that folder and redispatch`;
        transitionAttempt(r.ctx.db, attemptId, "blocked", { reason, threadId: writerThreadId });
        await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId, state: "blocked", reason, retryable: false, result: { status: "blocked", reason, attemptId, writerThreadId } });
        return { status: "blocked", retryable: false, attemptId, writerThreadId, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: false, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
      }
      const rawOut = writerThreadId
        ? await r.ctx.bb.sdk.threads.output({ threadId: writerThreadId })
        : "";
      const answer = outputText(rawOut);
      if (answer) {
        try { noteAttemptStream(r.ctx.db, attemptId, answer); } catch { /* ignore */ }
        if (answer.trim() && (r.ctx.bb.sdk.files as { read?: unknown } | undefined)?.read) {
          await recordWriterReport(r.ctx, finishInput, answer).catch(() => undefined);
        }
      }
      const limit = providerLimitNotice(answer);
      if (limit) {
        const reason = `writer_provider_limit: ${limit}`;
        holdProviderLimit(now + 5 * 60_000);
        await handleWriterSubscriptionFallback(r, reason, now);
        r.providerErrorRetries = (r.providerErrorRetries ?? 0) + 1;
        r.primaryFailure = { status: "provider_error", reason, attemptId };
        transitionAttempt(r.ctx.db, attemptId, "provider_error", { reason, ...(writerThreadId ? { threadId: writerThreadId } : {}) });
        await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
        return { status: "provider_error", retryable: true, attemptId, writerThreadId, reason };
      }
      const dropped = providerStreamError(answer);
      if (dropped) {
        const reason = `${WRITER_STREAM_ERROR}: ${dropped}`;
        r.providerErrorRetries = (r.providerErrorRetries ?? 0) + 1;
        r.primaryFailure = { status: "provider_error", reason, attemptId };
        transitionAttempt(r.ctx.db, attemptId, "provider_error", { reason, ...(writerThreadId ? { threadId: writerThreadId } : {}) });
        await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
        return { status: "provider_error", retryable: true, attemptId, writerThreadId, reason };
      }
      const question = needsHumanQuestion(answer);
      if (question) {
        const reason = `needs_human: ${question}`;
        transitionAttempt(r.ctx.db, attemptId, "blocked", { reason, ...(writerThreadId ? { threadId: writerThreadId } : {}) });
        const parkedWorkspace = attempt.workspace_path ?? r.workspacePath;
        if (parkedWorkspace && (r.ctx.bb.sdk.files as { read?: unknown } | undefined)?.read) {
          await noteTaskQa({ bb: r.ctx.bb, db: r.ctx.db }, { hostId: r.config.hostId, workspacePath: parkedWorkspace, taskId: r.taskId, attemptId, question }).catch(() => undefined);
        }
        r.ctx.refreshRun?.(r.runId);
        const qSec = questionSecFor(r);
        return { status: "needs_answer", answerKind: "question", attemptId, writerThreadId, question, answerSec: qSec, answerUntil: now + qSec * 1_000 };
      }
      if (attempt.state === "blocked" && (attempt.reason ?? "").startsWith("needs_human:")) {
        const qSec = questionSecFor(r);
        return { status: "needs_answer", answerKind: "question", attemptId, writerThreadId, question: (attempt.reason ?? "").replace(/^needs_human:/i, "").trim(), answerSec: qSec, answerUntil: now + qSec * 1_000 };
      }
      return { status: "ready", attemptId, writerThreadId, answer };
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      const reason = `internal_error: ${msg}`;
      if (!isTerminalAttemptState(attempt.state)) {
        transitionAttempt(r.ctx.db, attemptId, "blocked", { reason, ...(writerThreadId ? { threadId: writerThreadId } : {}) });
      }
      await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId: writerThreadId || null, state: "blocked", reason, retryable: false, result: { status: "blocked", reason, attemptId, writerThreadId } });
      return { status: "blocked", retryable: false, attemptId, writerThreadId, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: false, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
    }
  });

  // 4. Timeout handler for `wait-answer`: owner-word 6h expiry OR writer question cascade (rules -> second pilot -> safe default -> owner inbox).
  reg("lp.answer-timeout", async (r, ctx) => {
    const attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
    const kind = str(ctx.input.with.answerKind) ?? "question";
    const attempt = getAttempt(r.ctx.db, attemptId);
    const writerThreadId = str(ctx.input.with.writerThreadId) ?? attempt?.thread_id ?? "";
    const now = engine.now();
    if (kind === "owner_word") {
      const reason = "owner_word_timeout: no owner decision received within 6 hours";
      if (attempt && !isTerminalAttemptState(attempt.state)) {
        transitionAttempt(r.ctx.db, attemptId, "blocked", { ...(writerThreadId ? { threadId: writerThreadId } : {}), reason });
      }
      postOwnerItem(r.ctx.db, {
        key: `owner-word-timeout:${attemptId}`,
        source: "writer",
        kind: "owner_word_timeout",
        reason: "blocked",
        projectId: r.projectId,
        what: "Ожидание слова владельца истекло",
        why: reason,
        evidence: [{ kind: "run", ref: r.runId }, { kind: "task", ref: r.taskId }, { kind: "attempt", ref: attemptId }],
      }, now);
      await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId: writerThreadId || null, state: "blocked", reason, retryable: false, result: { status: "blocked", reason, attemptId, writerThreadId } });
      return { action: "escalated", attemptId, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: false, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
    }

    const rtServices = r.services as unknown as Record<string, unknown>;
    const hasFullServices = typeof rtServices.runBudgetFor === "function";
    if (typeof rtServices.secondPilotAnswer !== "undefined" || hasFullServices || typeof (r.ctx.bb.sdk.threads as { send?: unknown }).send === "function") {
      const qt = createWriterQuestionTimeout(r.ctx, r.services as never);
      const waitMs = questionSecFor(r) * 1_000;
      const qRow = listUnansweredWriterQuestions(r.ctx.db).find((row) => row.id === attemptId);
      const dueNow = Math.max(now, (qRow?.updated_at ?? attempt?.created_at ?? now) + waitMs + 1);
      const outcomes = await qt.sweepWriterQuestions(dueNow);
      const mine = outcomes.find((row) => row.taskId === r.taskId);
      if (mine && mine.action !== "ended" && mine.action !== "left_to_owner") {
        const sec = silenceSecFor(r);
        if (hasFullServices && writerThreadId) {
          startThreadTurnWatcher({ bb: r.ctx.bb, db: r.ctx.db, engine, attemptId, taskId: r.taskId, projectId: r.projectId, writerThreadId, isDisposed: () => r.ctx.isDisposed?.() ?? false });
        }
        return { action: "reopened", via: mine.action, attemptId, writerThreadId, silenceSec: sec, until: now + sec * 1_000 };
      }
    }
    postOwnerItem(r.ctx.db, {
      key: `writer-question:${attemptId}`,
      source: "writer",
      kind: "question_unanswered",
      reason: "blocked",
      projectId: r.projectId,
      what: "Вопрос писателя остался без ответа",
      why: attempt?.reason ?? "не удалось автоматически ответить на вопрос писателя",
      evidence: [{ kind: "run", ref: r.runId }, { kind: "task", ref: r.taskId }, { kind: "attempt", ref: attemptId }],
    }, now);
    await finalizeTerminalFailure(r, engine, {
      attemptId,
      writerThreadId: writerThreadId || null,
      state: "blocked",
      reason: attempt?.reason ?? "question_unanswered",
      retryable: false,
      result: { status: "blocked", reason: attempt?.reason ?? "question_unanswered", attemptId, writerThreadId },
    });
    return { action: "escalated", attemptId, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: false, reason: attempt?.reason ?? "question_unanswered", stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
  });

  // 5. Resume after `wait-answer` received `LP_EVENTS.WRITER_ANSWERED`.
  reg("lp.reopen-after-answer", async (r, ctx) => {
    const payload = parseJsonOr<Record<string, unknown>>(JSON.stringify(ctx.input.with.payload ?? {}), {});
    const attemptId = str(ctx.input.with.attemptId) ?? str(payload.attemptId) ?? r.attemptId;
    const writerThreadId = str(ctx.input.with.writerThreadId) ?? getAttempt(r.ctx.db, attemptId)?.thread_id ?? "";
    const kind = str(payload.kind) ?? str(ctx.input.with.answerKind) ?? "question";
    const now = engine.now();
    if (kind === "owner_word") {
      if (payload.decision === "yes") return { next: "merge", attemptId, writerThreadId };
      const reason = `owner_word_no: ${str(payload.text) ?? "rejected by owner"}`;
      transitionAttempt(r.ctx.db, attemptId, "blocked", { reason, ...(writerThreadId ? { threadId: writerThreadId } : {}) });
      await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId: writerThreadId || null, state: "blocked", reason, retryable: false, result: { status: "blocked", reason, attemptId, writerThreadId } });
      return { next: "blocked", attemptId, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: false, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
    }
    const sec = silenceSecFor(r);
    if (writerThreadId) {
      startThreadTurnWatcher({ bb: r.ctx.bb, db: r.ctx.db, engine, attemptId, taskId: r.taskId, projectId: r.projectId, writerThreadId, isDisposed: () => r.ctx.isDisposed?.() ?? false });
    }
    return { next: "wait_turn", attemptId, writerThreadId, silenceSec: sec, until: now + sec * 1_000 };
  });

  // 9. Two-condition stopped handlers (Matvey): process exit & work hand-back have separate deadlines; any gap goes to owner inbox and never continues.
  reg("lp.attempt-stop-finalize", async (r, ctx) => {
    const attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
    const writerThreadId = str(ctx.input.with.writerThreadId) ?? getAttempt(r.ctx.db, attemptId)?.thread_id ?? null;
    const attempt = getAttempt(r.ctx.db, attemptId);
    if (attempt && attempt.state !== "canceled" && attempt.state !== "accepted" && attempt.state !== "blocked") {
      transitionAttempt(r.ctx.db, attemptId, "canceled", { ...(writerThreadId ? { threadId: writerThreadId } : {}), reason: "canceled: writer process exited and work handed back" });
    }
    await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId, state: "canceled", reason: "stopped", retryable: false, result: { status: "canceled", attemptId, writerThreadId } });
    return { reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "canceled", retryable: false, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
  });

  reg("lp.attempt-stop-gap", async (r, ctx) => {
    const attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
    const writerThreadId = str(ctx.input.with.writerThreadId) ?? getAttempt(r.ctx.db, attemptId)?.thread_id ?? null;
    const gap = str(ctx.input.with.handbackWoke) !== undefined || str(ctx.input.with.gap) === "exit_without_handback"
      ? "exit_without_handback"
      : "process_not_exited";
    const attempt = getAttempt(r.ctx.db, attemptId);
    if (attempt && attempt.state !== "canceled" && attempt.state !== "accepted" && attempt.state !== "blocked") {
      transitionAttempt(r.ctx.db, attemptId, "canceled", { ...(writerThreadId ? { threadId: writerThreadId } : {}), reason: `stopped_with_gap:${gap}` });
    }
    reportStopGapOwnerItem(r.ctx.db, { projectId: r.projectId, runId: r.runId, taskId: r.taskId, attemptId, writerThreadId, gap, detail: str(ctx.input.with.detail) });
    await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId, state: "canceled", reason: `stopped_with_gap:${gap}`, retryable: false, result: { status: "canceled", attemptId, writerThreadId, gap } });
    return { reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "canceled", retryable: false, gap, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
  });
}
