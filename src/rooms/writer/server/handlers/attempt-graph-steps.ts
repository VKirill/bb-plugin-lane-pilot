import { LP_EVENTS, isTerminalAttemptState, taskFamily } from "@lane-pilot/contracts";
import { outputText, pollPause } from "@lane-pilot/kit";
import { turnFailureKey } from "../../../contracts";
import { recordGateEvaluation } from "../../../runs/server";
import {
  countAttempts, failureFieldsOf, getAttempt, getRunSettingsScopes,
  listStageReceipts, loadProjectSettings, transitionAttempt,
} from "../../../storage";
import { TASK_WORDS_KEY, landingWordGap, ownerWordsOn, taskStepEvidence, taskWordKey, type TaskWord } from "../../../tasks";
import type { StepContext, WorkflowEngine } from "../../../workflow";
import { releaseAttemptAdmission } from "../services/attempt-admission";
import { OWNER_WORD_WAIT_SEC, STOP_EXIT_DEADLINE_SEC } from "../../models/attempt-timeouts";
import { emitAttemptEvent } from "../services/attempt-events";
import { emitAttemptFinished } from "../services/attempt-finished";
import {
  executionSnapshot, finalizeTerminalFailure, recordTerminalWriterStages, withAttemptWorkspace,
} from "../services/attempt-step-helpers";
import { registerAttemptTurnExecutors } from "./attempt-turn-steps";
import { taskUsage } from "../services/attempt-usage";
import type { DispatchRuntime } from "../services/dispatch-runtime";
import { integrateAttemptOnce, type MergeWaitState } from "../services/finish-merge";
import { runPostValidationGates } from "../services/post-validation-gates";
import { mountVerificationAttemptFinished } from "../services/verification";
import { isWriterStreamError } from "../../models/writer-brief-feedback";

type Step = StepContext<DispatchRuntime>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Registers turn-lifecycle executors plus validate, critique, and merge executors. */
export function registerAttemptStepExecutors(
  engine: WorkflowEngine,
  resolveRuntime: (ctx: Step) => Promise<DispatchRuntime>,
): void {
  registerAttemptTurnExecutors(engine, resolveRuntime);

  const reg = (key: string, fn: (r: DispatchRuntime, ctx: Step) => Promise<Record<string, unknown>>, extra: { reentrant?: boolean } = {}) =>
    engine.register<DispatchRuntime>(key, {
      ...extra,
      run: async (ctx) => ({ output: await fn(await resolveRuntime(ctx), ctx) }),
    });

  // 6. Validate node: deterministic verification + lightweight owner-word fallback for unit-test harnesses.
  reg("lp.attempt-validate", async (r, ctx) => {
    const attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
    const attempt = getAttempt(r.ctx.db, attemptId);
    const writerThreadId = str(ctx.input.with.writerThreadId) ?? attempt?.thread_id ?? "";
    const now = engine.now();
    if (!attempt || attempt.state === "cancel_requested" || attempt.state === "canceled") {
      return { status: "stopped", attemptId, writerThreadId, exitTimeoutSec: STOP_EXIT_DEADLINE_SEC, exitUntil: now + STOP_EXIT_DEADLINE_SEC * 1_000 };
    }
    const rtServices = r.services as unknown as {
      validateWriterResult?: (input: unknown) => Promise<{ status: string; reason?: string; output?: string; produced?: string[]; verification?: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>; warnings?: string[]; failureCode?: unknown; checkName?: unknown; timeoutSec?: unknown; diffKey?: unknown }>;
      runBudgetFor?: unknown;
      taskWords?: unknown;
    };
    const activeTask = r.activeTasksByAttempt?.[attemptId] ?? r.task;
    const dirtBefore = r.dirtBeforeByAttempt?.[attemptId] ?? attempt.dirt_before ?? [];
    let candidate: Awaited<ReturnType<NonNullable<typeof rtServices.validateWriterResult>>>;
    try {
      candidate = rtServices.validateWriterResult
        ? await rtServices.validateWriterResult({
            projectId: r.projectId, config: r.runConfig, task: activeTask, runId: r.runId, taskId: r.taskId, attemptId,
            attempt: countAttempts(r.ctx.db, r.runId, r.taskId),
            pmThreadId: r.threadId, writerThreadId, dirtBefore,
          })
        : { status: "accepted", output: str(ctx.input.with.answer) ?? "accepted", produced: [], verification: [], warnings: [] };
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      const reason = `internal_error: ${msg}`;
      if (!isTerminalAttemptState(attempt.state)) {
        transitionAttempt(r.ctx.db, attemptId, "blocked", { reason, ...(writerThreadId ? { threadId: writerThreadId } : {}) });
      }
      await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId: writerThreadId || null, state: "blocked", reason, retryable: false, result: { status: "blocked", reason, attemptId, writerThreadId } });
      return {
        status: "failed",
        attemptId,
        writerThreadId,
        retryable: false,
        reason,
        reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: false, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
      };
    }
    if (candidate.status !== "accepted") {
      const baseReason = candidate.reason ?? `validation_${candidate.status}`;
      recordGateEvaluation(r.ctx.db, { attemptId, projectId: r.projectId, runId: r.runId, taskId: r.taskId, gate: "accept", status: "rejected", attempt: countAttempts(r.ctx.db, r.runId, r.taskId), input: JSON.stringify(r.task), summary: { writerStatus: candidate.status } });
      if (getAttempt(r.ctx.db, attemptId)?.state === "cancel_requested") {
        return { status: "stopped", attemptId, writerThreadId, exitTimeoutSec: STOP_EXIT_DEADLINE_SEC, exitUntil: now + STOP_EXIT_DEADLINE_SEC * 1_000 };
      }
      const turn = {
        failure: turnFailureKey({ reason: candidate.reason, verification: candidate.verification }),
        diff: typeof candidate.diffKey === "string" ? candidate.diffKey : null,
        streamError: isWriterStreamError(candidate.reason),
      };
      const noProgress = candidate.status !== "blocked"
        && Boolean(r.previousTurn && turn.diff && r.previousTurn.diff === turn.diff && r.previousTurn.failure === turn.failure);
      r.previousTurn = turn;
      const reason = noProgress ? `no progress: the same failure and the same diff in two turns in a row: ${baseReason}` : baseReason;
      const nextState: "blocked" | "validation_failed" = candidate.status === "blocked" || noProgress ? "blocked" : "validation_failed";
      if (!["blocked", "validation_failed", "canceled"].includes(attempt.state)) {
        transitionAttempt(r.ctx.db, attemptId, nextState, { reason, ...(writerThreadId ? { threadId: writerThreadId } : {}), ...failureFieldsOf(candidate) });
      }
      const retryable = nextState !== "blocked";
      await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId: writerThreadId || null, state: nextState, reason, retryable, result: { ...candidate, status: nextState, reason, attemptId, writerThreadId } });
      return {
        status: "failed",
        attemptId,
        writerThreadId,
        retryable,
        reason,
        reply: { runId: r.runId, taskId: r.taskId, attemptId, state: nextState, retryable, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
      };
    }
    const hasFullServices = typeof rtServices.runBudgetFor === "function";
    // Lightweight unit-test fallback (`attempt-graph.test.ts` doesn't pass full `taskWords`/`runBudgetFor`).
    if (!hasFullServices) {
      const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
      const wordsMap = await r.ctx.bb.storage?.kv?.get(TASK_WORDS_KEY).catch(() => null) as Record<string, TaskWord[]> | null;
      const words = wordsMap?.[taskWordKey(r.runId, taskFamily(r.taskId))];
      const wordGap = landingWordGap(ownerWordsOn(settings, taskStepEvidence(activeTask)), words, attemptId);
      if (wordGap && !wordGap.includes("said no")) {
        return {
          status: "wait_owner_word",
          answerKind: "owner_word",
          attemptId,
          writerThreadId,
          answerSec: OWNER_WORD_WAIT_SEC,
          answerUntil: now + OWNER_WORD_WAIT_SEC * 1_000,
          candidate,
        };
      }
    }
    return { status: "passed", attemptId, writerThreadId, candidate };
  });

  // 7. Critique & post-validation gate node: runs code-critique, plan-fact, convention gates, test-fit, notes/checkpoints, proof, and owner landing word.
  reg("lp.attempt-critique", async (r, ctx) => {
    const attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
    const attempt = getAttempt(r.ctx.db, attemptId);
    let writerThreadId = str(ctx.input.with.writerThreadId) ?? attempt?.thread_id ?? "";
    const now = engine.now();
    const candidate = (ctx.input.with.candidate as { status?: string; output: string; produced: string[]; verification: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>; warnings?: string[] } | undefined)
      ?? { status: "accepted", output: "", produced: [], verification: [], warnings: [] };
    const rtServices = r.services as unknown as Record<string, unknown>;
    const hasFullServices = typeof rtServices.runBudgetFor === "function";

    // Unit-test harnesses without full services (`taskWords` + `runBudgetFor`) pass critique directly.
    if (!hasFullServices) {
      return { status: "passed", attemptId, writerThreadId, review: "not_required", checklist: {}, candidate };
    }

    const activeTask = r.activeTasksByAttempt?.[attemptId] ?? r.task;
    const dirtBefore = r.dirtBeforeByAttempt?.[attemptId] ?? attempt?.dirt_before ?? [];
    const answer = outputText(await r.ctx.bb.sdk.threads.output({ threadId: writerThreadId }).catch(() => candidate.output ?? ""));
    const endedByStop = (reason: string, tid = writerThreadId): Record<string, unknown> | null => {
      if (getAttempt(r.ctx.db, attemptId)?.state !== "cancel_requested") return null;
      transitionAttempt(r.ctx.db, attemptId, "canceled", { threadId: tid, reason: `writer stop observed after: ${reason}`.slice(0, 500) });
      return { status: "canceled", attemptId, writerThreadId: tid };
    };
    const stoppedMeanwhile = (where: string, tid = writerThreadId): Record<string, unknown> | null => {
      const state = getAttempt(r.ctx.db, attemptId)?.state;
      if (state === "cancel_requested") return endedByStop(where, tid);
      return state === "canceled" ? { status: "canceled", attemptId, writerThreadId: tid } : null;
    };

    const gated = await runPostValidationGates({
      ctx: r.ctx,
      services: rtServices as never,
      input: {
        projectId: r.projectId, config: r.runConfig, task: activeTask, runId: r.runId, taskId: r.taskId,
        attemptId, pmThreadId: r.threadId, writerThreadId, dirtBefore: dirtBefore as never,
      },
      candidate: { status: "accepted", output: candidate.output ?? "", produced: candidate.produced ?? [], verification: (candidate.verification ?? []) as never, warnings: candidate.warnings },
      writerThreadId,
      answer,
      parkOwnerWord: true,
      endedByStop,
      stoppedMeanwhile,
    });

    if (gated.kind === "wait_owner_word") {
      return {
        status: "wait_owner_word",
        answerKind: "owner_word",
        attemptId,
        writerThreadId: gated.writerThreadId,
        answerSec: OWNER_WORD_WAIT_SEC,
        answerUntil: now + OWNER_WORD_WAIT_SEC * 1_000,
        candidate: gated.candidate,
      };
    }
    if (gated.kind === "terminal") {
      const termStatus = String(gated.result.status ?? "blocked");
      const reason = String(gated.result.reason ?? termStatus);
      writerThreadId = String(gated.result.writerThreadId ?? writerThreadId);
      if (termStatus === "canceled") {
        return {
          status: "stopped",
          attemptId,
          writerThreadId,
          exitTimeoutSec: STOP_EXIT_DEADLINE_SEC,
          exitUntil: now + STOP_EXIT_DEADLINE_SEC * 1_000,
        };
      }
      if (termStatus === "validation_failed" || termStatus === "empty_output") {
        await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId: writerThreadId || null, state: "validation_failed", reason, retryable: true, result: gated.result });
        return { status: "rejected", attemptId, writerThreadId, retryable: true, candidate: gated.result, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: termStatus, retryable: true, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
      }
      await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId: writerThreadId || null, state: "blocked", reason, retryable: false, result: gated.result });
      return { status: "blocked", attemptId, writerThreadId, retryable: false, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: false, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
    }
    return {
      status: "passed",
      attemptId,
      writerThreadId: gated.writerThreadId,
      review: gated.review,
      checklist: gated.checklist,
      candidate: gated.candidate,
    };
  });

  // 8. Merge node: busy/dirty waits return durable wait deadlines for `merge-wait` (`builtin:wait`) instead of polling.
  engine.register<DispatchRuntime>("lp.attempt-merge", {
    run: async (ctx) => {
      const r = await resolveRuntime(ctx);
      const attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
      const attempt = getAttempt(r.ctx.db, attemptId);
      const writerThreadId = str(ctx.input.with.writerThreadId) ?? attempt?.thread_id ?? "";
      const candidate = (ctx.input.with.candidate as { output: string; produced: string[]; verification: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>; warnings?: string[] } | undefined) ?? { output: "", produced: [], verification: [], warnings: [] };
      const review = str(ctx.input.with.review) === "passed" ? "passed" as const : "not_required" as const;
      const checklist = (ctx.input.with.checklist && typeof ctx.input.with.checklist === "object" ? ctx.input.with.checklist : {}) as Record<string, unknown>;
      const rtServices = r.services as unknown as Record<string, unknown>;
      if (!rtServices.persistWriterAcceptance) {
        if (attempt && attempt.state !== "accepted") transitionAttempt(r.ctx.db, attemptId, "accepted", { ...(writerThreadId ? { threadId: writerThreadId } : {}) });
        const result = withAttemptWorkspace(r, attemptId, { status: "accepted", attemptId, writerThreadId, produced: candidate.produced ?? [], verification: candidate.verification ?? [] });
        recordTerminalWriterStages(r, { attemptId, writerThreadId: writerThreadId || null, terminal: "passed", result });
        await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
        r.ctx.refreshRun?.(r.runId);
        await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId, taskId: r.taskId, state: "accepted" }, projectId: r.projectId, now: engine.now() });
        const spent = r.ctx.bb ? await taskUsage(r.ctx.bb, r.ctx.db, r.runId, r.taskId) : {};
        return {
          output: { status: "accepted", reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "accepted", stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } },
          ...spent,
        };
      }
      const verification = mountVerificationAttemptFinished(r.ctx, rtServices as never);
      const priorWait = (ctx.input.with.mergeState as MergeWaitState | undefined) ?? {};
      const activeTask = r.activeTasksByAttempt?.[attemptId] ?? r.task;
      const activeConfig = r.activeConfigsByAttempt?.[attemptId] ?? r.runConfig;
      const dirtBefore = r.dirtBeforeByAttempt?.[attemptId] ?? attempt?.dirt_before ?? [];
      const step = await integrateAttemptOnce({
        ctx: r.ctx,
        services: rtServices as never,
        input: { projectId: r.projectId, config: activeConfig, task: activeTask, runId: r.runId, taskId: r.taskId, attemptId, pmThreadId: r.threadId, writerThreadId, dirtBefore: dirtBefore as never, ...(r.emergencyFallback && r.emergencyFallback.providerId ? { emergencyFallback: { reason: r.emergencyFallback.reason, primaryAttemptId: r.emergencyFallback.primaryAttemptId ?? attemptId, providerId: r.emergencyFallback.providerId, model: r.emergencyFallback.model } } : {}) },
        candidate: candidate as never,
        writerThreadId,
        review,
        checklist,
        verification,
        endedByStop: (reason) => {
          if (getAttempt(r.ctx.db, attemptId)?.state !== "cancel_requested") return null;
          transitionAttempt(r.ctx.db, attemptId, "canceled", { ...(writerThreadId ? { threadId: writerThreadId } : {}), reason });
          return { status: "canceled", attemptId, writerThreadId };
        },
        setEndMerge: () => undefined,
      }, priorWait, engine.now());
      if (step.kind === "wait") {
        const waitDelayMs = Math.max(50, pollPause(step.durationSec * 1_000));
        return {
          output: {
            status: step.waitKind === "busy" ? "wait_busy" : "wait_dirty",
            waitUntil: engine.now() + waitDelayMs,
            durationSec: Math.max(0.05, waitDelayMs / 1_000),
            mergeState: step.state,
            attemptId,
            writerThreadId,
            candidate,
          },
        };
      }
      const doneState = String(step.result.status ?? (step.result.receipt ? "accepted" : "accepted"));
      if (doneState === "validation_failed" || doneState === "blocked" || doneState === "canceled") {
        const reason = String(step.result.reason ?? doneState);
        const termState = doneState === "canceled" ? "canceled" : doneState;
        await finalizeTerminalFailure(r, engine, { attemptId, writerThreadId: writerThreadId || null, state: termState, reason, retryable: termState === "validation_failed", result: step.result });
        const spent = r.ctx.bb && termState !== "validation_failed" ? await taskUsage(r.ctx.bb, r.ctx.db, r.runId, r.taskId) : {};
        return {
          output: {
            status: termState === "validation_failed" ? "conflict" : "blocked",
            retryable: termState === "validation_failed",
            reply: { runId: r.runId, taskId: r.taskId, attemptId, state: termState, retryable: termState === "validation_failed", ...step.result, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
          },
          ...spent,
        };
      }
      const finalResult = withAttemptWorkspace(r, attemptId, {
        ...step.result,
        ...(r.emergencyFallback ? { emergencyFallback: r.emergencyFallback } : {}),
      });
      const sel = executionSnapshot(r, attemptId);
      recordTerminalWriterStages(r, {
        attemptId,
        writerThreadId: writerThreadId || null,
        terminal: "passed",
        result: finalResult,
      });
      r.ctx.refreshRun?.(r.runId);
      await emitAttemptFinished(r.ctx, {
        scope: "attempt", projectId: r.projectId, runId: r.runId, taskId: r.taskId, attemptId,
        pmThreadId: r.threadId, writerThreadId, task: activeTask, config: activeConfig, status: "accepted",
        reason: null, result: finalResult, candidate: { output: candidate.output, produced: candidate.produced, verification: candidate.verification }, acceptanceReached: true,
      }).catch(() => undefined);
      await emitAttemptFinished(r.ctx, {
        scope: "task", projectId: r.projectId, runId: r.runId, taskId: r.taskId, attemptId,
        pmThreadId: r.threadId, writerThreadId, task: activeTask, config: activeConfig, status: "accepted",
        writerSelection: sel ? { providerId: sel.providerId, model: sel.model } : undefined,
        reason: null, result: finalResult, acceptedAttemptId: attemptId,
      }).catch(() => undefined);
      if (r.liveBackupByAttempt) delete r.liveBackupByAttempt[attemptId];
      await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
      await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId, taskId: r.taskId, state: "accepted" }, projectId: r.projectId, now: engine.now() });
      const spent = r.ctx.bb ? await taskUsage(r.ctx.bb, r.ctx.db, r.runId, r.taskId) : {};
      return {
        output: {
          status: "accepted",
          retryable: false,
          reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "accepted", retryable: false, ...finalResult, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
        },
        ...spent,
      };
    },
  });
}
