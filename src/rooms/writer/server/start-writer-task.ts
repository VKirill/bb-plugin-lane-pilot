import { TASK_ATTEMPT_BUDGET, retryBudgetReason, spendRetryBudget } from "../retry-budget";
import { retrySafetyStop, taskLimitStop, TASK_WALL_CLOCK_MIN, VERIFY_MAX_PASSES } from "./retry-safety";
import { pilotBlockedByOthers, pilotOf, pilotUnderWall, runTasks, type TaskWallRow } from "./pilot";
import { listWalls } from "../../wall";
import { breakerKey, budgetStopReason, classifyFailure, runningWriterBudgetStop, tokenUsageFromEvent, type RunBudget } from "@lane-pilot/resilience";
import type { DirtSnapshot } from "../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { providerPoolCap } from "@lane-pilot/settings-catalog";
import {isZcodeProvider, rotatedWriterSettings, writerFallbackChain, writerFallbacks} from "@lane-pilot/models";
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
import { stickyTurnPromptWithRules } from "./writer-knowledge";
import { parseMemorySettings } from "../../memory";
import { checkoutOwnsOverlap, isMainfixTask, retargetTask , priorityRank, HOLD_FOREVER, laneCap, laneQueueOf, spendReserve } from "../../tasks";
import { dependsOnTask } from "../../tasks";
import { createWriterSticky } from "./sticky";
import { WRITER_QUESTION_WAIT_TEXT } from "./question-default";
import { failureClass, failureIntervention, MAST_OF_FAILURE, type FailureClass } from "../../contracts/failure-class";
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
import { baselinePreflight } from "./start-baseline-preflight";
import { handoffToHotWriter } from "./start-thread-takeover";
import { attemptLoop } from "./start-attempt-loop";
import { fallbackChain } from "./start-fallback-chain";
import { recordOutcome } from "./start-record-outcome";

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


/** The createWriterStart locals startWriterTask closes over, passed in so the function can live in its own module. */
export interface StartWriterTaskDeps {
  ctx: ServerCore;
  services: Services;
  sticky: ReturnType<typeof createWriterSticky>;
  admitted: Map<string, { runId:string; taskId:string; projectId:string }>;
  noteAttemptOutcome: (input:{ budget:RunBudget; writerThreadId:string; writerSelection?:{providerId:string;model:string}; status:string; reason:string|null }) => Promise<void>;
  chainWithRoom: <T extends { providerId:string; model:string }>(chain:T[], hostId:string, settings:Record<string, unknown>, taskId:string) => Promise<{ chain:T[]; room:boolean; nextReset:string|null }>;
}

export function createStartWriterTask(deps: StartWriterTaskDeps) {
  const { ctx, services, sticky, admitted, noteAttemptOutcome, chainWithRoom } = deps;
  const { bb, db, effectiveProjectSettings, host, markCanceledWriterStages, refreshRun, runPolicyFor } = ctx;

  function startWriterTask(input:{
    projectId:string; runId:string; taskId:string; firstAttemptId:string; pmThreadId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; writerThreadId?:string; dirtBefore?:DirtSnapshot[]; pmReadContext?:string;
    /** The writer already has its turn in writerThreadId (the PM reopened the attempt): it is checked once the turn ends, without the waits. */
    turnSent?:boolean;
  }): void {
    const key = `${input.runId}:${input.taskId}`;
    if (services.activeWriterTasks.has(key)) return;
    services.activeWriterTasks.add(key);
    // An attempt resumed after a reload arrives bound to its own worktree. Every new attempt starts from the run's
    // workspace instead: that worktree is removed when the attempt fails, and a retry snapshotted inside it failed
    // with «spawnSync /bin/bash ENOENT» (project-folders, 2026-10-02).
    const attemptStart = freshAttemptStart(input.task, input.config, taskBasePath(db, input.runId, input.taskId));
    // An attempt that never reached a writer has no baseline: its stored [] is the column's default. Taken as the folder's
    // state, a parked task restarted on a new attempt counted every file of a folder without git as its writer's change
    // (BB-сервис 2026-10-10: 49 434 paths, three tasks failed as Lane Pilot's fault).
    const resumedDirt = getAttempt(db, input.firstAttemptId)?.thread_id ? input.dirtBefore : undefined;
    const state: WriterTaskState = {
      attemptId: input.firstAttemptId,
      writerThreadId: input.writerThreadId,
      writerSelection: undefined,
      freshTask: attemptStart.task,
      freshConfig: attemptStart.config,
      activeConfig: input.config,
      activeTask: input.task,
      dirtBefore: resumedDirt ?? [],
      baselineDirtBefore: resumedDirt?[...resumedDirt]:null,
      baselineWorkspacePath: resumedDirt?input.task.project_cwd:null,
      executionPacketSha256: null,
      last: {},
      // The class Jev (J-4, active) or the rules gave the last failure: parking reads the same one, not its own recount.
      judged: null,
      primaryFailure: null,
      /** A red check the same writer already failed the same way: the next attempt is the next writer, not this one again. */
      checkEscalation: null,
      /** The last failure that was the task's own (a stray file, a red check), not its provider's: a fallback writer avoids it too. */
      own: { failure:lastOwnFailure(db, input.runId, input.taskId, input.firstAttemptId) },
      // The PM reassigned the task: the next writer continues the stopped one's worktree and starts with the requested model.
      pendingReassign: null,
      // The last failed attempt's worktree, kept until the next attempt starts or the fallback chain takes it over.
      unremovedWorktree: undefined,
      // An earlier task of the same family (a redispatch, a mainfix) that failed the same way stops the next one early.
      familyFailure: familyFailureRecord(db, input.runId, input.taskId),
      acceptedAttemptId: null,
      pmReadContext: input.pmReadContext ?? stringAt(listStageReceipts(db,input.runId,input.taskId).find((row)=>row.stageId==="pm-read")?.result,"summary") ?? "",
      key,
      releaseWriterSlot: undefined,
      // This start owns the live-writer key until it drops it. A question drops the key before the cleanup
      // awaits (a worktree remove can hang); the finally still frees the pool slot, and must not delete a key
      // a later answer's start has taken.
      holdsLiveWriter: true,
      // A folder without git: one writer at a time edits its live files, and a failed attempt is rolled back from the
      // backup its first spawn made (feedback turns in the same thread keep working on the live files, so they keep it).
      liveFolder: false,
      liveBackupId: null,
      // The run's shared state: every step below reads and writes these. The pipeline at the bottom names the order.
      policy: undefined as never,
      baseSettings: undefined as never,
      runSettings: undefined as never,
      writerChoice: undefined as never,
      budget: undefined as never,
      runFolder: undefined as never,
      attemptsHere: 0,
      halfBound: false,
      inSession: false,
      sessionStartedAt: Date.now(),
      previousTurn: null,
    };
    const existingTrace=getReasoningTrace(db,state.attemptId);
    if(existingTrace) state.writerSelection={
      providerId:existingTrace.providerId, model:existingTrace.model,
      reasoningLevel:existingTrace.effectiveReasoningLevel, serviceTier:existingTrace.serviceTier,
      selectionSource:existingTrace.selectionSource,
    };

      void (async () => {
      // The writer pipeline: prepare → admit → baseline → session → fallback chain → record.
      if (!await prepareRun(deps, state, input)) return;
      // An attempt the PM reopened (an answer to the writer's question, a contract fix) passed these waits when it first
      // started, and its turn is already in the writer's thread: the writer works whatever Lane Pilot waits for here.
      // Waiting again only held back its checks: a reopened attempt is created as a retry, later than the siblings queued
      // behind it, so it queued behind them while its writer had long finished (SelfyStudio 2026-10-15: stickers-landing-
      // showcase and webapp-ideas-home «running» about an hour with an idle writer).
      if (!input.turnSent && !await waitForAdmission(deps, state, input)) return;
      if (!await admitTask(deps, state, input)) return;
      if (!await baselinePreflight(deps, state, input)) return;
      await handoffToHotWriter(deps, state, input);
      if (await attemptLoop(deps, state, input) === "stop") return;
      if (await fallbackChain(deps, state, input) === "stop") return;
      await recordOutcome(deps, state, input);
    })().catch(async (cause: unknown) => {
      // After a reload the database is closed: stop quietly, the next load reconciles the attempt.
      if (ctx.state.disposed) return;
      // A failed attempt's worktree that no fallback took is removed here too, as it was before fallbacks could keep it.
      if (state.unremovedWorktree) void removeWorktreeOf(deps, state, input, state.unremovedWorktree).catch((removeCause) => bb.log.warn(`Lane Pilot could not remove the worktree of ${input.taskId}: ${removeCause instanceof Error ? removeCause.message : String(removeCause)}`));
      try {
        const message = cause instanceof Error ? cause.message : String(cause);
        const reason = `internal_error: ${message}`;
        bb.log.error(`Lane Pilot writer attempt ${state.attemptId} failed: ${message}`);
        // The writer may still be editing, so nothing is rolled back here; the originals wait in the backup.
        if (state.liveBackupId) bb.log.warn(`Lane Pilot: the owned files of ${input.taskId} are backed up in ~/.lane-pilot/live-backups/${state.liveBackupId} (folder without git, no rollback after an internal error)`);
        const attempt = getAttempt(db, state.attemptId);
        if(attempt?.state==="canceled"){
          markCanceledWriterStages(attempt,"writer attempt canceled before provider dispatch");
          refreshRun(input.runId);
          return;
        }
        if (attempt && ["queued", "spawn_requested", "spawn_unknown", "spawn_rejected", "running", "cancel_requested", "provider_error", "timeout", "empty_output", "validation_failed"].includes(attempt.state)) {
          transitionAttempt(db, state.attemptId, "blocked", { threadId:state.writerThreadId, reason });
        }
        // Stability hears the failure while the run is still running — its record before the receipts, as before.
        await bestEffort(ctx.log, "writer attempt finished emit", emitAttemptFinished(ctx, { scope:"task", projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          attemptId: state.attemptId, pmThreadId:input.pmThreadId, writerThreadId:state.writerThreadId ?? null, task:input.task, config:state.activeConfig,
          status:"blocked", reason, result:state.last, acceptedAttemptId:null }), undefined);
        for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
          const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
          if (!current || current.state === "passed" || current.state === "failed" || current.state === "skipped") continue;
          if (current.state === "pending") recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId,
            state:"failed", input:input.plan,
            attempt:Math.min(countAttempts(db, input.runId, input.taskId),MAIN_ATTEMPT_LIMIT),
            providerId:stageId==="writer-agent"?state.writerSelection?.providerId:undefined,
            model:stageId==="writer-agent"?state.writerSelection?.model:undefined,threadId:state.writerThreadId, reason });
        }
        try {
          refreshRun(input.runId);
        } catch (refreshCause) {
          bb.log.error(`Lane Pilot failed to refresh run ${input.runId} after attempt ${state.attemptId} error: ${refreshCause instanceof Error ? refreshCause.message : String(refreshCause)}`);
        }
      } catch (inner) {
        // A failure while recording the failure must never escape a detached task and crash BB.
        try { bb.log.error(`Lane Pilot writer attempt ${state.attemptId} could not record its failure: ${inner instanceof Error ? inner.message : String(inner)}`); } catch { /* ctx.state.disposed */ }
      }
    }).finally(() => {
      state.releaseWriterSlot?.();
      dropLiveWriterKey(deps, state);
    });
  }

  return startWriterTask;
}
