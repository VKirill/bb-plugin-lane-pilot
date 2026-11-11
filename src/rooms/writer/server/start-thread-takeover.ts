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
      /** Takes over an existing writer thread for this attempt; false leaves the attempt to a fresh spawn. */
      export const continueWith = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, writer:NonNullable<Awaited<ReturnType<StartWriterTaskDeps["sticky"]["hotWriter"]>>>, kind:"next-task"|"retry"|"merge", previousAttempt:string, keepDirt?:DirtSnapshot[]):Promise<boolean> => {
        const { ctx, services, sticky } = deps;
        const { bb, db, effectiveProjectSettings, host } = ctx;
        const bound = retargetTask(state.freshTask,writer.workspacePath);
        // The third turn of this thread gets the digest of what it already did, not the raw trajectory.
        let feedback = previousAttempt;
        if (kind === "retry" && writer.turns >= 2) {
          const listed = await bestEffort(ctx.log, "writer attempt feedback events", listThreadEventsRaw(bb, { threadId: writer.threadId, order: "desc", limit: "50" }), null);
          feedback = attemptFeedback(writer.turns + 1, listed?.ok ? listed.events as Parameters<typeof attemptFeedback>[1] : [], previousAttempt);
        }
        // The next task of an area is a different contract: its rules come with it (writer-knowledge.ts); a retry or a merge keeps the brief's.
        const memorySettings = parseMemorySettings((await bestEffort(ctx.log, "writer memory settings", effectiveProjectSettings(input.projectId, getRunSettingsScopes(db, input.runId)), null))?.values ?? {});
        const turnPrompt = await stickyTurnPromptWithRules({ db, host, chainForRun:(runId) => services.ruleScan.chainForRun(runId), log:ctx.log },
          { projectId:input.projectId, runId:input.runId, hostId:state.freshConfig.hostId, task:bound, memorySettings },
          { kind, task:bound, previousAttempt:kind === "merge" && !previousAttempt.includes(REPLAY_CHECK_FAILED) ? "" : feedback, liveFolder: state.liveFolder });
        // A task a person sent back to an earlier stage with a note (src/rooms/stage-return) takes the note into the area writer's next-task turn.
        const returnNotes = kind === "next-task" ? renderReturnNotes(listReturns(db, input.runId, input.taskId)) : "";
        const turn = await sticky.continueInThread({ runId:input.runId, taskId:input.taskId, attemptId: state.attemptId, config:state.freshConfig, writer, kind, dirtBefore:keepDirt,
          prompt:returnNotes ? (conflicts) => `${turnPrompt(conflicts)}\n\n${returnNotes}` : turnPrompt });
        if (!turn.ok) {
          ctx.log(`writer ${input.taskId}: ${kind} in thread ${writer.threadId} not possible (${turn.reason}); a fresh writer starts`);
          // A half-bound attempt cannot take a fresh spawn: it ends as Lane Pilot's fault and the retry spawns.
          if (turn.bound) {
            state.last = { status:endSpawnFailure(db, state.attemptId, turn.reason), reason:turn.reason, attemptId: state.attemptId };
            state.halfBound = true;
          }
          return false;
        }
        state.writerThreadId = writer.threadId;
        const trace = getReasoningTrace(db, state.attemptId);
        state.writerSelection = trace ? { providerId:trace.providerId, model:trace.model, reasoningLevel:trace.effectiveReasoningLevel,
          serviceTier:trace.serviceTier, selectionSource:trace.selectionSource } : undefined;
        state.activeConfig = state.freshConfig;
        state.activeTask = bound;
        state.dirtBefore = turn.dirtBefore;
        state.baselineDirtBefore ??= [...turn.dirtBefore];
        state.baselineWorkspacePath ??= turn.workspacePath;
        state.executionPacketSha256 = null;
        return true;
      };
      // The area's writer from an earlier task of this run takes this one in its own thread, unless the writer setting now names
      // another provider or model: then this task gets a fresh writer on the current one (the spawn's own selection, below).
      export const handoffToHotWriter = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<void> => {
        const { ctx, sticky } = deps;
        if (!state.writerThreadId && input.task.area && !state.liveFolder) {
          const wanted = {
            providerId: typeof state.runSettings["writer.provider"] === "string" ? state.runSettings["writer.provider"] as string : state.freshConfig.writerProviderId,
            model: typeof state.runSettings["writer.model"] === "string" && state.runSettings["writer.model"] ? state.runSettings["writer.model"] as string : state.freshConfig.writerModel,
          };
          const hot = await sticky.hotWriter(input.projectId, input.runId, input.task.area, wanted);
          if (hot) await continueWith(deps, state, input, hot, "next-task", "");
        }
      };
