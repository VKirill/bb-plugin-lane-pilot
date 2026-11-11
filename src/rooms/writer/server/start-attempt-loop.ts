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
import { continueWith } from "./start-thread-takeover";
import { spawnFreshWriter } from "./start-attempt-spawn";
import { routeAttemptFailure } from "./start-failure-route";

      // A merge conflict or a fault of Lane Pilot or the machine does not spend an attempt; free retries are capped too.
      // Free retries are counted within this start: a task restarted after a Lane Pilot fix gets its full share,
      // while attempts burned on the fault before it stay out of the count (BB-сервис 2026-10-05: five fault attempts
      // left the restarted task no attempt at all, and it sat queued with its stages failed).
      const attemptsLeft = (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput) => countChargedAttempts(deps.ctx.db, input.runId, input.taskId) <= MAIN_ATTEMPT_LIMIT
        && state.attemptsHere < MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT;
      // A task is ONE writer session: a failure of the task's own goes back to the same writer as a feedback turn (a new
      // attempt row in its thread, not a new charged attempt) until the checks pass, the turn cap (SESSION_MAX_TURNS) or
      // the wall cap (SESSION_MAX_MS) is reached, or two turns in a row leave both the failure and the diff unchanged.
      // Only a provider or limit fault, or a thread that cannot take the turn, starts another writer.
      /** Another attempt follows this failure: the same conditions the loop checks below before it creates one. */
      const attemptsLeftAfter = (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, binding:ReturnType<typeof getAttempt>) => Boolean(binding?.thread_id)
        && RETRY_ELIGIBLE.includes(String(state.last.status) as AttemptState)
        && countChargedAttempts(deps.ctx.db, input.runId, input.taskId) < MAIN_ATTEMPT_LIMIT
        && state.attemptsHere + 1 < MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT;
      /** The writer session: spawn or continue → finish → judge the failure → retry in thread, respawn, or hand to the chain. */
      export const attemptLoop = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<"done"|"stop"> => {
      const { ctx, services, sticky, noteAttemptOutcome } = deps;
      const { bb, db } = ctx;
      let pauseReadItemKey: string | null = null;
      // The attempt's state decides whether this wait is still its business: a cancel, an accept, a block or a
      // vanished row ends it even while the pause flag itself cannot be read. `queued` stays — the first
      // stage-boundary wait runs before the spawn, while the attempt is still queued by design.
      const pauseWaitShouldStop = () => {
        const pauseAttemptState = getAttempt(db, state.attemptId)?.state;
        return pauseAttemptState === undefined || pauseAttemptState === "cancel_requested" || pauseAttemptState === "canceled" || pauseAttemptState === "accepted" || pauseAttemptState === "blocked";
      };
      while (attemptsLeft(deps, state, input)) {
        if (state.last.status === "accepted") break;
        // The stage that just ended is the safe boundary of a pause: the next attempt or turn waits for the resume.
        // An unreadable pause flag is never a resume: the writer keeps its slot and waits, and the owner hears once
        // per episode — the sequence key reposts after the last row was closed (resume, reload, next blip).
        const pauseWait = await waitWhileRunPaused(bb.storage.kv as never, input.runId, { isDisposed: ctx.isDisposed, shouldStop: pauseWaitShouldStop, onError: (message) => bb.log.warn(message), onFirstWait: () => ctx.log(`writer ${input.taskId} waits at a stage boundary: run ${input.runId} is paused`), onReadBound: () => {
          if (!pauseReadItemKey) {
            pauseReadItemKey = `pause-read:${state.attemptId}:${ownerItemPrefixCount(db, `pause-read:${state.attemptId}:`)}`;
            postOwnerItem(db, { key: pauseReadItemKey, source: "writer", kind: "pause_read", projectId: input.projectId, wake: true,
              what: "Запись ждёт: состояние паузы не читается",
              why: "Хранилище плагина не отвечает на чтение флага паузы уже много раз подряд; писатель держит слот на границе стадии и ждёт чистого чтения — это не возобновление.",
              evidence: [{ kind: "run", ref: input.runId }, { kind: "task", ref: input.taskId }] });
          }
          return true;
        } });
        if (pauseReadItemKey) { closeOwnerItem(db, pauseReadItemKey, pauseWait ? "pause state readable again" : "the pause wait ended"); pauseReadItemKey = null; }
        if (!pauseWait) return "stop";
        if (!state.inSession) { state.attemptsHere += 1; state.sessionStartedAt = Date.now(); state.previousTurn = null; }
        const budgetCheck=state.budget.check();
        if (!budgetCheck.ok) {
          const reason=budgetStopReason(budgetCheck.exceeded);
          transitionAttempt(db, state.attemptId, "blocked", { reason });
          state.last = { status:"blocked", reason, attemptId: state.attemptId };
          // The run's whole remainder ran out: the owner is asked once per run whether to raise the
          // run.max_* limit or finish the run, instead of the work stopping quietly (sma ac_pocket).
          const limitSetting = RUN_LIMIT_SETTING[budgetCheck.exceeded];
          const limitNumber = (value:number) => budgetCheck.exceeded === "maxWallMs" ? Math.round(value / 60_000) : value;
          const openTasks = listTaskLatestAttemptStates(db, input.runId)
            .filter((row) => row.state !== "accepted" && row.state !== "canceled").map((row) => row.task_id);
          postOwnerItem(db, { key:`run-budget:${input.runId}`, source:"writer", kind:"budget_spent", projectId:input.projectId, wake:false,
            what:`Лимит прогона исчерпан: ${RUN_LIMIT_WORD[budgetCheck.exceeded]}, потрачено ${limitNumber(budgetCheck.used)} при лимите ${limitNumber(budgetCheck.limit)}`,
            why:`В прогоне остались незаконченные задачи: ${openTasks.length}. Работа продолжится, если поднять лимит (настройка ${limitSetting}), или прогон можно завершить.`,
            actions:[
              { id:"raise", label:`Поднять ${limitSetting}`, cli:`bb lane-pilot budget ${input.projectId} ${limitSetting}=<новый лимит>` },
              { id:"finish", label:"Завершить прогон", cli:rpcLine("finish_run", { projectId:input.projectId, runId:input.runId }), rpc:{ method:"finish_run", input:{ projectId:input.projectId, runId:input.runId } } },
            ],
            evidence:[{ kind:"run", ref:input.runId }, { kind:"task", ref:input.taskId }, { kind:"attempt", ref:state.attemptId }] });
          break;
        }
        // A mainfix runs only while main is still red: when its failing checks already pass on current main (another
        // task fixed it), it closes as accepted without a writer and the PM hears why.
        if (state.attemptsHere === 1 && !state.writerThreadId && isMainfixTask(input.task.id) && state.freshTask.verification.length > 0) {
          const checks = await bestEffort(ctx.log, "writer mainfix checks", services.runVerification(state.freshConfig, state.freshTask, input.runId), null);
          if (checks && checks.length > 0 && checks.every((check) => check.exitCode === 0)) {
            ctx.log(`mainfix ${input.taskId}: its checks already pass on main; closing accepted without a writer`);
            transitionAttempt(db, state.attemptId, "accepted");
            state.last = { status:"accepted", attemptId: state.attemptId, produced:[], verification:checks,
              mainfixPreflight:"the failing checks already pass on current main" };
            if (input.pmThreadId) void bestEffort(ctx.log, "writer mainfix notice", bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active",
              input:[{ type:"text", mentions:[],
                text:`Lane Pilot: задача ${input.taskId} закрыта принятой без писателя — её проверки уже проходят на текущем main, main починила другая задача. Действий не нужно.` }] } as never), undefined);
          }
        }
        const spawnStop = await spawnFreshWriter(deps, state, input);
        if (spawnStop === "stop") return "stop";
        if (spawnStop === "break") break;
        if (state.writerThreadId) {
          state.last = { ...await services.finishWriterAttempt({
            projectId:input.projectId, config:state.activeConfig, task:state.activeTask, runId:input.runId,
            taskId:input.taskId, attemptId: state.attemptId, pmThreadId:input.pmThreadId, writerThreadId: state.writerThreadId, dirtBefore: state.dirtBefore,
            releaseSlot:()=>{ state.releaseWriterSlot?.(); state.releaseWriterSlot=undefined; },
          }), ...(state.executionPacketSha256 ? { executionPacketSha256: state.executionPacketSha256 } : {}) };
          const workspaceBinding=getAttempt(db,state.attemptId);
          if(workspaceBinding?.workspace_path) state.last={...state.last,workspace:{path:workspaceBinding.workspace_path,
            environmentId:workspaceBinding.environment_id,decision:workspaceBinding.workspace_decision,
            ...(isLiveDecision(workspaceBinding.workspace_decision)?{mode:LIVE_FOLDER_RECEIPT}:{})}};
          // The question is already on the attempt. Drop the live-writer key before the awaits below (token
          // events, retry lookup, worktree remove): while it stayed until finally, the question sweep skipped
          // this task for the whole wait.
          if (failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null) === "judgment") dropLiveWriterKey(deps, state);
          await noteAttemptOutcome({ budget: state.budget, writerThreadId: state.writerThreadId, writerSelection: state.writerSelection, status:String(state.last.status), reason:typeof state.last.reason === "string" ? state.last.reason : null });
          noteOwnFailure(state, state.last);
        }
        if (state.last.status === "accepted") { state.acceptedAttemptId = state.attemptId; break; }
        // The PM moved the task to a fresh writer (lane_pilot_reassign_task): the stop is not a failure, so no attempt is spent.
        // The next iteration starts the writer in the stopped attempt's worktree, with its edits and a handoff brief.
        const reassign = state.last.status === "canceled" ? await takeReassignRequest(bb.storage.kv as never, state.attemptId) : null;
        if (reassign) {
          const stopped = getAttempt(db, state.attemptId);
          transitionAttempt(db, state.attemptId, "canceled", { threadId:stopped?.thread_id ?? undefined, reason:reassignedReason(reassign.reason) });
          state.pendingReassign={from:stopped, request:reassign};
          // A new session that is not charged: the loop top counts it back, so attemptsHere ends where it was.
          state.inSession=false;
          state.attemptsHere-=1;
          state.attemptId=id("lpattempt");
          createAttempt(db,{id:state.attemptId,runId:input.runId,taskId:input.taskId});
          state.writerThreadId=undefined;
          state.writerSelection=undefined;
          state.dirtBefore=[];
          state.executionPacketSha256=null;
          continue;
        }
        // A failure the writer can fix itself is redone in its own thread and worktree, with the reason.
        const failedBinding=getAttempt(db,state.attemptId);
        const moreAttempts = attemptsLeftAfter(deps, state, input, failedBinding);
        let sessionEnd = moreAttempts ? sticky.sessionLimit(state.attemptId) : null;
        let redo = moreAttempts && !sessionEnd ? await sticky.retryWriter(state.attemptId, input.runId) : null;
        const turn = { failure:turnFailureKey(state.last), diff:typeof state.last.diffKey === "string" ? state.last.diffKey : null,
          streamError:isWriterStreamError(typeof state.last.reason === "string" ? state.last.reason : null) };
        if (redo && Date.now() - state.sessionStartedAt >= SESSION_MAX_MS) sessionEnd = `wall limit ${SESSION_MAX_MS / 60_000} min reached`;
        else if (redo && state.previousTurn && turn.diff && state.previousTurn.diff === turn.diff && state.previousTurn.failure === turn.failure) {
          sessionEnd = "no progress: the same failure and the same diff in two turns in a row";
        }
        if (sessionEnd) redo = null;
        // A provider cut is continued in its thread once. Cut again right away (ck-21 on 2026-10-12, «[unavailable]» twice
        // within 8 s), the provider is down: the writer chain below takes the task over in this worktree, with its edits,
        // instead of up to five empty turns or a «repeated_failure» block.
        if (redo && turn.streamError && state.previousTurn?.streamError) redo = null;
        const streamHandOff = turn.streamError && !redo;
        state.previousTurn = turn;
        if (await routeAttemptFailure(deps, state, input, { failedBinding, redo, sessionEnd, streamHandOff, turn }) === "break") break;
        state.familyFailure = { state:String(state.last.status), reason:typeof state.last.reason === "string" ? state.last.reason : null };
        state.halfBound = false;
        const failedLast = state.last;
        if (state.unremovedWorktree) { const stale = state.unremovedWorktree; state.unremovedWorktree = undefined; await removeWorktreeOf(deps, state, input, stale); }
        state.attemptId = id("lpattempt");
        createAttempt(db, { id:state.attemptId, runId:input.runId, taskId:input.taskId });
        state.writerThreadId = undefined;
        state.writerSelection=undefined;
        state.activeConfig = state.freshConfig;
        state.activeTask = state.freshTask;
        state.dirtBefore = [];
        state.executionPacketSha256 = null;
        if (redo && !await continueWith(deps, state, input, redo, redo.kind, previousAttemptBrief(await trimCheckLogsIn(jev(), { ...failedLast, produced:[] }, state.freshTask.title, { projectId:input.projectId, runId:input.runId, subject:input.taskId, settings:state.runSettings }, ctx.log), state.freshTask, failedBinding?.dirt_before ?? [], state.liveFolder), failedBinding?.dirt_before)) {
          await removeWorktreeOf(deps, state, input, failedBinding);
          await rollbackLive(deps, state, input);
        }
        state.inSession = Boolean(redo && state.writerThreadId);
        if (state.inSession) await bindLiveBackup(deps, state);
      }
      // No attempt was left for this start: end the queued attempt instead of leaving it queued with failed stages.
      if (state.attemptsHere === 0 && getAttempt(db, state.attemptId)?.state === "queued") {
        const exhausted = "retry limit 2 exhausted: the task's attempts were spent before this start";
        transitionAttempt(db, state.attemptId, "blocked", { reason:exhausted });
        state.last = { status:"blocked", reason:exhausted, attemptId: state.attemptId };
      }
      return "done";
      };
