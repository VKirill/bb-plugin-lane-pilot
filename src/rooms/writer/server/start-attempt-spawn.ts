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

/** Fresh spawn or PM-reassigned continuation for the current attempt; null when the loop goes on. */
export const spawnFreshWriter = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<"stop"|"break"|null> => {
        const { ctx, services } = deps;
        const { bb, db, host } = ctx;
        if (!state.writerThreadId && !state.halfBound && state.last.status !== "accepted") {
          const reassigned = state.pendingReassign;
          const primaryPair = { providerId:typeof state.runSettings["writer.provider"] === "string" && state.runSettings["writer.provider"] ? state.runSettings["writer.provider"] as string : state.freshConfig.writerProviderId,
            model:typeof state.runSettings["writer.model"] === "string" && state.runSettings["writer.model"] ? state.runSettings["writer.model"] as string : state.freshConfig.writerModel };
          // H2: the gate's sources answer before the attempt is spent. A free member of the chain (the task's writer,
          // its fallbacks, the PM) spawns in this attempt — the next one when the writer itself is held; nobody free
          // parks the attempt queued until the earliest hold ends, instead of the spawn_rejected loop it used to run.
          const chainMembers = [{ ...primaryPair, reasoningLevel:typeof state.runSettings["writer.reasoning_effort"] === "string" ? state.runSettings["writer.reasoning_effort"] as string : "medium" },
            ...writerFallbackChain(primaryPair, writerFallbacks(state.runSettings), { providerId:state.freshConfig.pmProviderId, model:state.freshConfig.pmModel })];
          // A PM reassignment names its writer: it is tried as ordered (its own refusal is the old path).
          const walked = reassigned?.request.selection
            ? { free:{ member:chainMembers[0]!, index:0 }, allUnsupported:false, allOff:false, off:[], shortest:undefined, wakeAt:null, holds:[] } as ChainWalk
            : await walkWriterChain(chainMembers, { hostId:state.freshConfig.hostId, settings:state.runSettings, appetite:{ tokens:(input.task as { appetite?: { tokens?: number } }).appetite?.tokens } }, writerHoldDeps(deps));
          if (await parkForWriter(deps, state, input, state.attemptId, walked)) return "stop";
          const spawnSettings = walked.free && walked.free.index > 0
            ? { ...state.writerChoice, "writer.provider":walked.free.member.providerId, "writer.model":walked.free.member.model,
                ...(walked.free.member.reasoningLevel ? { "writer.reasoning_effort":walked.free.member.reasoningLevel } : {}) }
            : state.writerChoice;
          if (walked.free && walked.free.index > 0)
            ctx.log(`writer ${input.taskId}: ${primaryPair.providerId}/${primaryPair.model} is held (${walked.shortest?.hold.reason ?? "unknown"}); spawning ${walked.free.member.providerId}/${walked.free.member.model} in the same attempt`);
          // A pause the last failure's class asks for before the next attempt (writer.class_cooldowns, hive H-14): it
          // doubles with each consecutive attempt that ended in the same class (SMA ae_auto_retry).
          const lastClass = failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null);
          let sameClassStreak = 0;
          for (const row of [...listAttemptsForTask(db, input.runId, input.taskId)].reverse()) {
            if (row.id === state.attemptId || ["queued","spawn_requested","spawn_unknown","running","cancel_requested"].includes(row.state)) continue;
            if (failureClass(row.state, getAttempt(db, row.id)?.reason) !== lastClass) break;
            sameClassStreak += 1;
          }
          const classCooldown = failureClassCooldownMs(lastClass, state.runSettings, Math.max(1, sameClassStreak));
          if (classCooldown > 0) await new Promise((resolve) => setTimeout(resolve, classCooldown));
          // The task's overall budget of writers, kept across reloads and restarts (retry-budget.ts).
          // A reassigned task's new writer spends no attempt of the task's budget (the PM asked for it).
          const spent = reassigned ? null : await spendRetryBudget(bb.storage.kv as never, input.runId, input.taskId, "attempt", Date.now(), TASK_ATTEMPT_BUDGET, ctx.log);
          if (spent && !spent.ok) {
            const reason = retryBudgetReason(input.taskId, spent.record);
            transitionAttempt(db, state.attemptId, "blocked", { reason });
            state.last = { status:"blocked", reason, attemptId: state.attemptId };
            return "break";
          }
          if (!reassigned) state.budget.noteAttempt();
          const afterAttempt=state.budget.check();
          if (!afterAttempt.ok) {
            const reason=budgetStopReason(afterAttempt.exceeded);
            transitionAttempt(db, state.attemptId, "blocked", { reason });
            state.last = { status:"blocked", reason, attemptId: state.attemptId };
            return "break";
          }
          const carried=reassigned?.from?.thread_id&&reassigned.from.workspace_path&&!state.liveFolder ? {
            workspacePath:reassigned.from.workspace_path, environmentId:reassigned.from.environment_id, dirtBefore:reassigned.from.dirt_before,
            fromThreadId:reassigned.from.thread_id,
            brief:await collectHandoffBrief({ bb, host, hostId:input.config.hostId, threadId:reassigned.from.thread_id, workspacePath:reassigned.from.workspace_path,
              stopReason:`reassigned by the PM: ${reassigned.request.reason}` }),
          } : undefined;
          const requested=reassigned?.request.selection;
          state.pendingReassign=null;
          // Recursive best-of (arXiv #20, writer.best_of.rounds > 1): a candidate of round 2+ starts with the
          // round seed — the previous round's surviving candidates, their check remarks and diff stats.
          const bestOf = resolveBestOf(state.runSettings, resolveQualityMode(state.freshTask, state.runSettings[QUALITY_MODE_SETTING]));
          let roundSeed = "";
          if (bestOf.enabled && bestOf.rounds > 1) {
            const finished = listAttemptsForTask(db, input.runId, input.taskId)
              .filter((row) => row.id !== state.attemptId && !["queued","spawn_requested","spawn_unknown","running","cancel_requested"].includes(row.state));
            const doneRounds = Math.floor(finished.length / bestOf.count);
            if (doneRounds >= 1 && doneRounds < bestOf.rounds) {
              const candidates = await Promise.all(finished.slice(-bestOf.count).map(async (row) => {
                const attempt = getAttempt(db, row.id);
                let diffStat: string | null = null;
                if (attempt?.workspace_path) {
                  const ran = await bestEffort(ctx.log, "writer attempt diff stat", runOnHost(host, { hostId: input.config.hostId, cwd: attempt.workspace_path, command: "git diff --stat HEAD", timeoutSec:15, timeoutMs:15_000 }), null);
                  if (ran && ran.exitCode === 0 && ran.stdout.trim()) diffStat = ran.stdout.trim();
                }
                return { attemptId: row.id, state: row.state, reason: attempt?.reason ?? null, diffStat };
              }));
              roundSeed = roundSeedBrief(doneRounds + 1, bestOf.rounds, roundSurvivors(candidates));
            }
          }
          const prevBrief = previousAttemptBrief(await trimCheckLogsIn(jev(), state.last.status && isOwnFailure(state.last) ? state.last : state.own.failure ?? (state.last.status ? state.last : null), state.freshTask.title, { projectId:input.projectId, runId:input.runId, subject:input.taskId, settings:state.runSettings }, ctx.log), state.freshTask, undefined, state.liveFolder);
          // A fresh thread has none of the failed attempt's context: from the second attempt on it gets the
          // digest of that attempt's thread (what it did, what failed), not only the failure line (rank 5).
          const failedThreadId=(typeof state.last.attemptId==="string" ? getAttempt(db,state.last.attemptId)?.thread_id : null) ?? null;
          const listedPrev=failedThreadId&&countAttempts(db,input.runId,input.taskId)>=2&&typeof (bb.sdk.threads as {events?:{list?:unknown}}|undefined)?.events?.list==="function"
            ? await bestEffort(ctx.log, "writer previous attempt events", listThreadEventsRaw(bb,{threadId:failedThreadId,order:"desc",limit:"50"}), null) : null;
          const prevEvents=listedPrev?.ok ? listedPrev.events as Parameters<typeof attemptFeedback>[1] : [];
          const prevFeedback=attemptFeedback(countAttempts(db,input.runId,input.taskId),prevEvents,prevBrief,true);
          // A PM's word the running writer could not take rides this fresh thread's brief, once (sma as_redirect_deferred).
          const pendingWord=await pendingWordTake(bb.storage.kv as never,input.runId,input.taskId).catch(()=>null);
          const spawned = await services.spawnWriterAttempt({
            projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId: state.attemptId,
            config:state.freshConfig, task:state.freshTask, plan:input.plan, pmThreadId:input.pmThreadId, pmReadContext: state.pmReadContext, writerSettings:spawnSettings,
            retryIndex:Math.max(0,countAttempts(db,input.runId,input.taskId)-1),
            // A fresh writer starts from main: of the failures before it, the task's own is the one to avoid, not a provider's cut.
            previousAttempt:[prevFeedback, roundSeed, pendingWord].filter(Boolean).join("\n\n"),
            ...(requested ? { emergency:{...requested, reason:"reassigned by the PM"} } : {}),
            ...(carried ? { continuation:carried } : {}),
          });
          if (!spawned.ok) {
            state.last = { status:spawned.status, reason:spawned.reason, attemptId:spawned.attemptId };
          } else {
            state.writerThreadId = spawned.threadId;
            if (state.liveFolder) { state.liveBackupId = state.attemptId; await bindLiveBackup(deps, state); }
            state.writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
            if (state.writerSelection) await noteWriterPair(bb.storage.kv as never, input.runId, input.taskId,
              { providerId:state.writerSelection.providerId, model:state.writerSelection.model }, "initial", bb.log);
            state.activeConfig = state.freshConfig;
            state.activeTask = retargetTask(state.freshTask,spawned.workspacePath);
            // In a folder without git every attempt of the task starts from the same state (the owned files are rolled
            // back), so a file outside owns_paths that an earlier attempt left behind keeps counting as changed until undone.
            state.dirtBefore = state.liveFolder && state.baselineDirtBefore ? state.baselineDirtBefore : spawned.dirtBefore;
            state.baselineDirtBefore ??=[...spawned.dirtBefore];
            state.baselineWorkspacePath ??=spawned.workspacePath;
            state.executionPacketSha256 = spawned.executionPacketSha256 ?? null;
          }
        }
        return null;
}
