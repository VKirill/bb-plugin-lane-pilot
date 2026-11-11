import { TASK_ATTEMPT_BUDGET, retryBudgetReason, spendRetryBudget } from "../retry-budget";
import { retrySafetyStop, taskLimitStop, TASK_WALL_CLOCK_MIN, VERIFY_MAX_PASSES } from "./retry-safety";
import { pilotBlockedByOthers, pilotOf, pilotUnderWall, runTasks, type TaskWallRow } from "./pilot";
import { listWalls } from "../../wall";
import { breakerKey, budgetStopReason, classifyFailure, runningWriterBudgetStop, tokenUsageFromEvent, type RunBudget } from "@lane-pilot/resilience";
import type { DirtSnapshot } from "../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { providerPoolCap } from "@lane-pilot/settings-catalog";
import {WRITER_PROFILES, isZcodeProvider, rotatedWriterSettings, type WriterProfile, writerFallbackChain, writerFallbacks} from "@lane-pilot/models";
import { DEPENDENCY_REDO_WAIT_MS, blockedReasonCount, countAttempts, countChargedAttempts, countThreadTurns, createAttempt, endSpawnFailure, failureFieldsOf, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getTask, getTaskPlan, latestTaskAttempt, latestTaskAttemptState, attemptReasonsForTask, canceledLatestTaskIds, listAttemptsForTask, listAttemptsInStates, listOpenAttempts, listStageReceipts, listRunTaskRows, listTaskAttemptRows, listTracedAttemptsSince, listUnansweredWriterQuestions, loadProjectSettings, priorAttemptStates, taskHeldUntil, noteCleanAdmission, noteToldPmDirectly, onAttemptChanged, parkAttemptWake, trailingQueuedParks, transitionAttempt, taskBasePath, taskTimelineRow, listTaskLatestAttemptStates } from "../../storage";
import { closeOwnerItem, closeOwnerItemsByPrefix, ownerItemPrefixCount, postOwnerItem, rpcLine } from "../../owner-waiting";
import { taskV2Schema } from "../../contracts";
import { bestEffort, ownsPathsOverlap, parseJsonOr, pollPause } from "@lane-pilot/kit";
import { reconcile, reconcileCursor } from "../../stability";
import { listRegressions, type RegressionRecord } from "../../baseline";
import { quarantineFileSet } from "../../baseline";
import { emergencyFallbackDecision } from "../emergency-writer";
;
import { resolveBestOf, roundSeedBrief, roundSurvivors } from "../best-of";
import { QUALITY_MODE_SETTING, resolveQualityMode } from "../../contracts/quality-mode";
import { runOnHost } from "@lane-pilot/host-calls";
import { WRITER_PICK_PREFIX, writerPickOverlay, type WriterLoad } from "../writer-model-pick";
import { loadWriterPin, noteWriterPair } from "../writer-model-pin";
import { reassignedReason, takeReassignRequest, type ReassignRequest } from "./reassign";
import { usageHoldReason, usageSkipPercent } from "../../usage/server";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../../contracts/state-machine";
import { FREE_RETRY_LIMIT, PARKED_CLASSES, REPLAY_CHECK_FAILED, SESSION_MAX_MS, VERIFICATION_TIMEOUT_RETRIES, failureClassCooldownMs, failureFingerprint, isWaitingSecret, isWriterSilent, repeatedFailureReason, turnFailureKey, verificationTimeoutOverBudget } from "../../contracts/failure-class"
import { taskFamily } from "@lane-pilot/contracts";
import { coreHostsRequiredProvider, isTaskSatisfied } from "../../runs/server";
import { walkWriterChain, waitingWriterReason, waitingWriterText, type ChainWalk } from "./writer-hold";
import { noteUnsupportedProvider, noteWriterWait } from "./writer-wake";
import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { attemptFeedback, isWriterStreamError, pendingWordTake, previousAttemptBrief } from "./writer-task";
import { trimCheckLogsIn } from "../log-trim";
import { stickyTurnPromptWithRules } from "./writer-knowledge";
import { parseMemorySettings } from "../../memory";
import { checkoutOwnsOverlap, isMainfixTask, retargetTask , priorityRank, HOLD_FOREVER, laneCap, laneQueueOf, spendReserve } from "../../tasks";
import { dependsOnTask } from "../../tasks";
import { createWriterSticky } from "./sticky";
import { WRITER_QUESTION_WAIT_TEXT } from "./question-default";
import { failureClass, failureIntervention, MAST_OF_FAILURE, type FailureClass } from "../../contracts/failure-class";
import { jev } from "@lane-pilot/jev";
import { judgedFailureClass } from "../../runs";
import { isHeld, isRunHalted, isRunPaused, waitWhileRunPaused } from "../../runs/server";
import { allowedSecretNames, secretProblem, waitingSecretNote, waitingSecretReason } from "../../secrets/server";

import { recoveryState } from "../../rollback";

import { copyRefusedKeyPrefix } from "./copy-refused-key";
import { freshAttemptStart } from "./fresh-attempt-start";
import { familyFailureRecord, isOwnFailure, lastOwnFailure, verificationFailure } from "./start-failure-records";
import { quarantiningRegression } from "./start-quarantine";
import { CANCELED_REDO_WAIT_MS, RUN_LIMIT_SETTING, RUN_LIMIT_WORD, SECRET_WAIT_MS, secretPollMs } from "./start-wait-limits";
import type { Services } from "./start";
import { noteOwnFailure, type WriterTaskState } from "./start-task-state";
import { waitForDependencies } from "./start-wait-dependencies";
import { waitForSecrets } from "./start-wait-secrets";
import { waitForRegressionQuarantine } from "./start-wait-quarantine";
import { waitForOverlappingTasks } from "./start-wait-overlap";
import { bindLiveBackup, dropLiveWriterKey, liveBackupKey, rollbackLive } from "./start-live-folder";
import { releaseFailedThreads, removeWorktreeOf } from "./start-failed-cleanup";
import { otherWriters } from "./start-other-writers";
import { blockBeforeWriter, parkForStoreRead, prepareRun } from "./start-prepare-run";
import { parkForWriter, writerHoldDeps } from "./start-writer-holds";
import { admitTask, waitForAdmission } from "./start-admission";
import { sameArea } from "./start-area";

import type { AttemptState } from "../../contracts/state-machine";
import { closeWriterStages, recordStage } from "../../runs/server";
import { id, stringAt } from "@lane-pilot/kit";
import { configuredSetting } from "../../contracts/server";
import { shouldMergeAttemptWorktree } from "./spawn";
import { collectHandoffBrief } from "./writer-handoff";
import { listReturns, renderReturnNotes } from "../../stage-return";
import { isLiveDecision, LIVE_FOLDER_RECEIPT } from "../live-folder";
import { resolve } from "node:path";
import { findThreadsByMetadata } from "../../platform/server";
import type { ServerCore } from "../../contracts/server";

import { sendServiceMessage } from "../../relay/server";
import { emitAttemptFinished } from "./attempt-finished";

import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput } from "./start-task-state";

/** After a failed attempt: classify, and route — block and leave the loop, or fall through to the respawn. */
export const routeAttemptFailure = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, route: {
  failedBinding: ReturnType<typeof getAttempt>;
  redo: Awaited<ReturnType<StartWriterTaskDeps["sticky"]["retryWriter"]>>;
  sessionEnd: string | null;
  streamHandOff: boolean;
  turn: { failure: unknown; diff: string | null; streamError: boolean };
}):Promise<"break"|"next"> => {
        const { ctx, services } = deps;
        const { bb, db, host } = ctx;
        const { failedBinding, redo, sessionEnd, streamHandOff, turn } = route;
        // A failed attempt's own worktree is never merged; the next attempt starts from a fresh one.
        const removeFailedWorktree = () => removeWorktreeOf(deps, state, input, failedBinding);
        // The worktree waits: the next attempt removes it when it starts, and a fallback writer may continue in it (below).
        if (!redo) { state.unremovedWorktree = failedBinding; await rollbackLive(deps, state, input); }
        if (state.last.status === "spawn_rejected" && typeof state.last.reason === "string"
          && (state.last.reason.startsWith("execution_packet_failed:") || state.last.reason.startsWith("attempt_worktree_")
            || state.last.reason.startsWith("attempt_workspace_"))) {
          const rejected = getAttempt(db, state.attemptId);
          if (rejected?.state === "spawn_rejected") transitionAttempt(db, state.attemptId, "blocked", { reason:state.last.reason });
          // The working copy could not be made for a cause only a person clears (a stale path, a permission,
          // a full disk): parked as now, and the reason is put before the owner once per refusal fingerprint
          // — a machine wait never reaches a human otherwise (sma ap_copy_refusal).
          if (state.last.reason.startsWith("attempt_worktree_")) {
            const detail = state.last.reason.replace(/^attempt_worktree_(failed|baseline_failed|not_clean|provision_[a-z_]+):?/, "") || state.last.reason;
            postOwnerItem(db, { key:`${copyRefusedKeyPrefix(input.runId, input.taskId)}${failureFingerprint(state.last.reason)}`, source:"writer", kind:"copy_refused", projectId:input.projectId, wake:false,
              what:"Рабочая копия для задачи не создалась",
              why:`Причина: ${detail}. Задача припаркована: сама она не запустится, её нужно отправить снова после устранения причины.`,
              evidence:[{ kind:"run", ref:input.runId }, { kind:"task", ref:input.taskId }, { kind:"attempt", ref:state.attemptId }] });
          }
          state.last = { ...state.last, status:"blocked" };
          return "break";
        }
        if (state.last.status !== "accepted" && state.last.status !== "blocked") state.primaryFailure={...state.last};
        const failed = String(state.last.status) as AttemptState;
        if (!RETRY_ELIGIBLE.includes(failed)) return "break";
        const attempt = getAttempt(db, state.attemptId);
        if (attempt?.state === "spawn_unknown" || attempt?.state === "spawn_requested") {
          state.writerThreadId = await bestEffort(ctx.log, "writer reconcile attempt thread", services.reconcileAttemptThread(input.projectId, attempt), "");
        } else if (attempt && !attempt.thread_id) {
          // An attempt whose writer thread is stored needs no scan; scanning every thread of the project here blocked
          // retries with reconcile_page_cap once SelfyStudio passed 1000 threads (live 2026-10-04).
          const cursor = reconcileCursor(db, attempt.id, "writer");
          const scanned = await reconcile({
            list: async ({ limit, offset }) => (await bb.sdk.threads.list({
              projectId:input.projectId, originPluginId:"lane-pilot", includeHidden:true, archived:false, limit, offset,
            })).map((thread) => ({ id:thread.id })),
            metadata: async (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
            find: (match) => findThreadsByMetadata(bb, match, input.projectId),
          }, { lanePilotRunId:attempt.run_id, lanePilotTaskId:attempt.task_id, attemptId:attempt.id }, { cursor });
          // page_cap and a death mid-page leave the cursor. The attempt stays, and the next process reads the same page.
          if ((scanned.kind === "blocked" && scanned.reason === "page_cap") || (scanned.kind === "error" && cursor.read() !== null)) return "break";
          if (scanned.kind === "blocked" || scanned.kind === "error") {
            // Both end the attempt: an error left it «spawn_rejected» with its stages closed, and nothing retried it (found by the
            // fault-injection simulation, tests/simulation). A reconcile_ reason is Lane Pilot's fault: the task is parked.
            transitionAttempt(db, attempt.id, "blocked", { reason:scanned.kind === "blocked" ? `reconcile_${scanned.reason}` : `reconcile_error: ${scanned.message}` });
            state.last = { ...state.last, status:"blocked", reason:scanned.kind === "blocked" ? scanned.reason : scanned.message };
            return "break";
          }
        }
        // A fault of Lane Pilot or the machine is not redone here: another writer meets the same fault. The task is
        // parked and restarts once a fix ships or the machine recovers.
        // A reason the rules have no confident match for goes to Jev (J-4, shadow by default: recorded, the rules' class used).
        const failedClass = await judgedFailureClass({ jev, settings:async () => state.runSettings, projectId:input.projectId, runId:input.runId, db, kv:bb.storage.kv as never },
          String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null, input.taskId);
        // C6: a class's own intervention instead of the same retry — the streak of consecutive same-class failures of
        // this task decides. `failure.interventions=off` keeps the old uniform retry (live setting).
        const priorRows = priorAttemptStates(db, input.runId, input.taskId, state.attemptId);
        let sameClassStreak = 1;
        for (const row of priorRows) { if (failureClass(row.state, row.reason) === failedClass) sameClassStreak++; else break; }
        const intervention = configuredSetting(state.runSettings, "failure.interventions") === "off" ? "same_retry_remark" : failureIntervention(failedClass, sameClassStreak);
        state.judged = { status: String(state.last.status), reason: typeof state.last.reason === "string" ? state.last.reason : null, klass: failedClass, mast: MAST_OF_FAILURE[failedClass] ?? "external:unknown", intervention, streak: sameClassStreak };
        // A check the host killed for time is not the task's red code: one retry, then it stops on its own budget.
        if (failedClass === "verification_timeout") {
          const reasons = attemptReasonsForTask(db, input.runId, input.taskId);
          if (verificationTimeoutOverBudget(reasons)) {
            const reason = `verification_timeout_budget: the check timed out again after its ${VERIFICATION_TIMEOUT_RETRIES} retry; this budget is separate from the task's attempts. Raise timeout_sec or narrow the command, then dispatch again`;
            const latest = getAttempt(db, state.attemptId);
            if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason, ...failureFieldsOf(state.last) });
            state.last = { ...state.last, status:"blocked", reason };
            return "break";
          }
        }
        // A provider that takes no work fails every retry the same way: the writer chain below takes the task now.
        // The attempt ends blocked with its limit reason (uncharged); primaryFailure keeps the state the chain reads.
        // A writer that stayed silent through its nudges is handed on the same way: its session hung, not the task.
        // A provider refusal (a limit, an unavailable provider, a 5xx) hands over at once by default — one more attempt
        // of the same model only repeats the refusal (owner_present held writers 20 h, graphs-optimisation G10); the
        // `writer.fallback_on_provider_failure=after_retry` keeps the classic retry order (one more attempt of the same model first).
        // A stream cut is not a refusal: the provider cut a turn mid-work, its edits are in the worktree, and the same
        // thread continues them once as before — only a second cut in a row is the provider's (streamHandOff above).
        const providerHandsOff = failedClass === "provider" && !turn.streamError
          && state.runSettings["writer.fallback_on_provider_failure"] !== "after_retry"
          // No other writer to hand over to: the same model is tried again (free), instead of a block nobody else could lift.
          && otherWriters(deps, state, input).fallbackList.length > 0;
        if (failedClass === "limit" || providerHandsOff || isWriterSilent(typeof state.last.reason === "string" ? state.last.reason : null) || streamHandOff) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(state.last.reason ?? state.last.status), ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked" };
          return "break";
        }
        // A secret the checks need went away mid-task: the attempt is not charged and the task is parked until it is back.
        if (PARKED_CLASSES.has(failedClass) || isWaitingSecret(typeof state.last.reason === "string" ? state.last.reason : null)) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(state.last.reason ?? state.last.status), ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked" };
          return "break";
        }
        // The retry-safety gate (writer.retry_safety): an automatic retry stops when the failed attempt's work area was
        // touched after it ended (owner edits, rewritten check evidence, a catalog secret in the diff).
        if (configuredSetting(state.runSettings, "writer.retry_safety") !== "off") {
          const safety = await retrySafetyStop({ db, host, hostId:input.config.hostId, task:state.freshTask, attemptId: state.attemptId, liveFolder: state.liveFolder, log:ctx.log });
          if (safety) {
            const latest = getAttempt(db, state.attemptId);
            if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:safety });
            state.last = { ...state.last, status:"blocked", reason:safety };
            return "break";
          }
        }
        // The task-level caps (writer.task_wall_clock_min, writer.verify_max_passes): the session caps above bound one
        // session; these bound the task across sessions, restarts and chain handoffs.
        {
          const wallClockMin = Number(state.runSettings["writer.task_wall_clock_min"]) || 0;
          const verifyMaxPasses = Number(state.runSettings["writer.verify_max_passes"]) || 0;
          const limitStop = taskLimitStop({ db, runId:input.runId, taskId:input.taskId,
            wallClockMin:wallClockMin > 0 ? wallClockMin : TASK_WALL_CLOCK_MIN, verifyMaxPasses:verifyMaxPasses > 0 ? verifyMaxPasses : VERIFY_MAX_PASSES });
          if (limitStop) {
            const latest = getAttempt(db, state.attemptId);
            if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:limitStop });
            state.last = { ...state.last, status:"blocked", reason:limitStop };
            return "break";
          }
        }
        // The session ended: the turn cap or the wall cap blocks the task. A repeated red check (the same failure and
        // the same diff twice) does not: the next attempt goes to the next writer in the chain, not this one again.
        if (sessionEnd) {
          const ended = `${sessionEnd}: ${String(state.last.reason ?? state.last.status)}`;
          if (sessionEnd.startsWith("no progress:") && failedClass !== "verification_timeout" && verificationFailure(state.last)) {
            state.checkEscalation = ended;
            return "break";
          }
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:ended, ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked", reason:ended };
          return "break";
        }
        if (countChargedAttempts(db, input.runId, input.taskId) >= MAIN_ATTEMPT_LIMIT
          || state.attemptsHere >= MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) {
            const exhausted = `retry limit 2 exhausted${typeof state.last.reason === "string" && state.last.reason ? `: ${state.last.reason}` : ""}`;
            transitionAttempt(db, latest.id, "blocked", { reason:exhausted, ...failureFieldsOf(state.last) });
            state.last = { ...state.last, status:"blocked", reason:exhausted };
          }
          return "break";
        }
        // Two attempts of the task family failing the same way stop the task: a third attempt of the same writer
        // would only repeat them. A repeated red check is the exception: the next attempt is the next writer in the
        // chain. A turn in the same thread is not stopped here: the session's own early stop is above.
        const repeated = redo ? null : repeatedFailureReason(state.familyFailure, { state:String(state.last.status), reason:typeof state.last.reason === "string" ? state.last.reason : null });
        if (repeated && failedClass !== "verification_timeout" && verificationFailure(state.last)) {
          state.checkEscalation = repeated;
          state.primaryFailure = { ...state.last };
          return "break";
        }
        // Cascade retry (arXiv #25/26, writer.retry_escalate): with the setting on, the first red check already goes to
        // the next writer in the fallback chain — a cheaper writer failing the task's check is reason enough to try
        // the next one, inside the same attempt budget. Off by default: a single failure retries the same writer.
        if (!repeated && failedClass === "task" && verificationFailure(state.last) && state.runSettings["writer.retry_escalate"] === true) {
          state.checkEscalation = `retry_escalate: ${String(state.last.reason ?? "")}`;
          state.primaryFailure = { ...state.last };
          return "break";
        }
        if (repeated) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:repeated, ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked", reason:repeated };
          state.primaryFailure = { ...state.last };
          // The two normal moves are spent: the wall ladder opens (hunters from other sides, then the backlog), see src/rooms/wall.
          services.wall?.noteTaskStop({ projectId:input.projectId, runId:input.runId, taskId:input.taskId, family:taskFamily(input.taskId), state:state.familyFailure?.state ?? "validation_failed",
            reason:repeated.replace(/^repeated_failure:\s*/, ""), failureCode:typeof state.last.failureCode === "string" ? state.last.failureCode : null, pmThreadId:input.pmThreadId ?? null, task:input.task, plan:input.plan })
            .catch((cause:unknown) => ctx.log(`wall: could not note the stop of ${input.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`));
          return "break";
        }
        // The session goes on, and how it goes on is already decided: an in-thread continue (redo) is itself the
        // intervention for a fixable failure, and the classic handoffs above already took the failures they own.
        // What is left here is only a same-model respawn — the move C6 replaces by class: a task that keeps failing
        // the same way stops with narrow_brief, and a provider's second refusal in a row (or its first, with
        // writer.fallback_on_provider_failure=immediate, decided above) moves the task to the next writer now.
        if (!redo && intervention === "narrow_brief" && !state.liveFolder) {
          // The original reason stays in the blocked reason: the class and the advice are a prefix, not a replacement —
          // a receipt reader (and the live-folder rollback test) still sees what actually failed.
          const reason = `narrow_brief: ${String(state.last.reason ?? state.last.status)} — ${failedClass} failed ${sameClassStreak} attempts in a row; narrow the brief or change the approach, then dispatch again`;
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason, ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked", reason };
          return "break";
        }
        if (!redo && intervention === "next_writer" && failedClass === "provider" && sameClassStreak >= 2) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(state.last.reason ?? state.last.status), ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked" };
          return "break";
        }
        return "next";
}
