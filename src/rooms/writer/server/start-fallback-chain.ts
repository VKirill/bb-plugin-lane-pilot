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

      /** The primary writer exhausted its session: the fallback chain takes the task over, writer by writer. */
      export const fallbackChain = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<"done"|"stop"> => {
      const { ctx, services, chainWithRoom, noteAttemptOutcome } = deps;
      const { bb, db, host } = ctx;
      if (state.last.status !== "accepted" && state.primaryFailure) {
        const { settings, fallbackList } = otherWriters(deps, state, input);
        // The writer's fallbacks in turn, then the PM's model; each takes over only while the failure is the model's, not the task's.
        // A provider, limit or catalog fault walks the chain. A repeated red check takes only the next writer (the same
        // pair is already excluded): another pass of this writer would only repeat the check.
        const primaryClass = failureClass(String(state.primaryFailure.status), typeof state.primaryFailure.reason === "string" ? state.primaryFailure.reason : null);
        const escalate = state.checkEscalation !== null && primaryClass === "task";
        const routed = primaryClass === "provider" || primaryClass === "limit" || escalate
          ? await chainWithRoom(fallbackList,input.config.hostId,settings,input.taskId)
          : { chain:[] as typeof fallbackList, room:false, nextReset:null };
        const fullChain = routed.chain;
        const chain = escalate ? fullChain.slice(0, 1) : fullChain;
        let failure:Record<string, unknown>=escalate ? { ...state.primaryFailure, checkEscalation:true } : state.primaryFailure;
        const primaryAttemptId=typeof state.primaryFailure.attemptId === "string" ? state.primaryFailure.attemptId : state.attemptId;
        // The writer the next fallback continues: the failed attempt that kept its worktree (worktree mode only), then each
        // fallback that started. Its thread and workspace are read when a fallback starts.
        let continueFrom:ReturnType<typeof getAttempt>=!state.liveFolder&&state.unremovedWorktree?.id===primaryAttemptId ? state.unremovedWorktree : undefined;
        /** The last fallback writer that ran: its failure is the task's result once the chain has ended. */
        let lastFallbackAttemptId:string|null=null;
        // Every writer provider is in a spent window: the task waits for the nearest reset, it is not a task failure.
        if (!chain.length && primaryClass === "limit" && configuredSetting(settings, "writer.capacity_wait") !== "off") {
          // The chain is empty only when no other writer exists (fallbacks off, the PM on the writer's own model): the reason says
          // so, not «usage windows» — the owner read it as spent limits on 2026-11-01. The prefix keeps the 15-minute recheck.
          const reason = fallbackList.length
            ? `capacity_saturated:${routed.nextReset ?? "unknown"}: every writer provider is over its usage window; the task waits for the nearest reset`
            : `capacity_saturated:unknown: no other writer can take the task (the writer's fallbacks are off and the PM runs the writer's own model); it retries every 15 minutes until the writer works again. Writer: ${typeof state.primaryFailure.reason === "string" ? state.primaryFailure.reason.slice(0, 160) : String(state.primaryFailure.status)}`;
          const latest = getAttempt(db, primaryAttemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason });
          state.last = { ...state.last, status:"blocked", reason, emergencyFallback:{ state:"skipped", reason:"capacity_saturated" } };
        } else if (!chain.length) {
          if (escalate && state.checkEscalation) {
            const stuck = getAttempt(db, typeof state.primaryFailure.attemptId === "string" ? state.primaryFailure.attemptId : state.attemptId);
            if (stuck && RETRY_ELIGIBLE.includes(stuck.state as AttemptState)) transitionAttempt(db, stuck.id, "blocked", { reason:state.checkEscalation, ...failureFieldsOf(state.primaryFailure) });
            state.last = { ...state.last, status:"blocked", reason:state.checkEscalation };
          }
          state.last={...state.last,emergencyFallback:{state:"skipped",
            reason:primaryClass === "provider" || primaryClass === "limit" ? "configured_pm_selection_matches_primary" : escalate ? "no next writer" : `failure is not a provider fault (${primaryClass})`}};
        }
        // H2: a fallback that cannot start costs no attempt — the chain is walked first and held members are skipped.
        // Nobody free parks one queued attempt until the earliest hold ends (the waker restarts the task); every
        // member unsupported ends the task blocked as before, with one owner item per provider, not per task.
        const fallbackWalk = chain.length ? await walkWriterChain(chain, { hostId:input.config.hostId, settings, appetite:{ tokens:(input.task as { appetite?: { tokens?: number } }).appetite?.tokens } }, writerHoldDeps(deps)) : null;
        if (fallbackWalk && !fallbackWalk.free) {
          const parkedAttemptId = id("lpattempt");
          createAttempt(db, { id:parkedAttemptId, runId:input.runId, taskId:input.taskId });
          await parkForWriter(deps, state, input, parkedAttemptId, fallbackWalk);
          return "stop";
        }
        const freeChain = fallbackWalk ? chain.filter((member) => !fallbackWalk.holds.some((held) => held.member === member)) : chain;
        for (const fallback of freeChain) {
          const decision=emergencyFallbackDecision({
            state:String(failure.status ?? "unknown"),
            reason:typeof failure.reason === "string" ? failure.reason : null,
            failureCode:typeof failure.failureCode === "string" ? failure.failureCode : null,
            stopConfirmed:failure.stopConfirmed === true,
            checkEscalation:failure.checkEscalation === true,
          });
          if (!decision.run) break;
          // A cancel stops the writer's thread, which reads as a provider failure; the chain must not take it as one
          // and start the next model (2026-10-04: an owner's stop of SelfyStudio was followed by a new fallback writer).
          if (typeof failure.attemptId === "string" && getAttempt(db, failure.attemptId)?.state === "canceled") break;
          if (getAttempt(db, state.attemptId)?.state === "canceled") break;
          // A file the contract expects and the writer did not make is the task's problem, not the model's limit:
          // another model meets the same contract (GLM spent 138 min per such task on 2026-10-03).
          if (typeof failure.reason === "string" && failure.reason.startsWith("missing expected_outputs")) break;
          // A change of model after the provider's own failure is not an attempt and spends nothing; a next writer after a red check is one.
          const fallbackSpent = primaryClass === "provider" || primaryClass === "limit" ? null
            : await spendRetryBudget(bb.storage.kv as never, input.runId, input.taskId, "fallback", Date.now(), TASK_ATTEMPT_BUDGET, ctx.log);
          if (fallbackSpent && !fallbackSpent.ok) {
            // The attempt that started the chain keeps the failure it ended with; the budget's reason goes to the log.
            ctx.log(`writer ${input.taskId}: ${retryBudgetReason(input.taskId, fallbackSpent.record)}`);
            break;
          }
          await rollbackLive(deps, state, input);
          // The task moves to another writer: a retry BB's provider-retry queued in a failed thread must not wake it later.
          await releaseFailedThreads(deps, state, input);
          const emergencySelection={providerId:fallback.providerId,model:fallback.model};
            // The interrupted writer's worktree goes on to the fallback with its edits, and the handoff tells the fallback what was done.
            const from=continueFrom;
            const continuation=from?.thread_id&&from.workspace_path ? {
              workspacePath:from.workspace_path, environmentId:from.environment_id, dirtBefore:from.dirt_before, fromThreadId:from.thread_id,
              brief:await collectHandoffBrief({ bb, host, hostId:input.config.hostId, threadId:from.thread_id, workspacePath:from.workspace_path,
                stopReason:`${String(failure.status ?? "failed")}${typeof failure.reason === "string" && failure.reason ? `: ${failure.reason}` : ""}` }),
            } : undefined;
            const emergencyAttemptId=id("lpattempt");
            createAttempt(db,{id:emergencyAttemptId,runId:input.runId,taskId:input.taskId});
            state.writerSelection=undefined;
            const spawned=await services.spawnWriterAttempt({
              projectId:input.projectId,runId:input.runId,taskId:input.taskId,attemptId:emergencyAttemptId,
              config:state.freshConfig,task:state.freshTask,plan:input.plan,pmThreadId:input.pmThreadId,pmReadContext: state.pmReadContext,
              emergency:{...emergencySelection,reason:decision.reason,...(fallback.pm?{}:{reasoningLevel:fallback.reasoningLevel})},
              continuation,
              // The handoff names only the provider's stop; a stray file or a red check of an earlier turn would be redone
              // (vf-s4-items 2026-10-24: the fallback rewrote Buffs.luau, which the first turn had been rejected for).
              ...(state.own.failure ? { previousAttempt:previousAttemptBrief(await trimCheckLogsIn(jev(), { ...state.own.failure, produced:[] }, state.freshTask.title, { projectId:input.projectId, runId:input.runId, subject:input.taskId, settings:state.runSettings }, ctx.log), state.freshTask, undefined, state.liveFolder) } : {}),
            });
            if (!spawned.ok) {
              // The owner's stop landed while this fallback was being made: its spawn ends canceled (endSpawnFailure), and the task
              // is canceled — not «emergency_fallback_failed», no next fallback, no park (cab-unslop-kit.3, 2026-10-31).
              if (spawned.status === "canceled" || getAttempt(db,emergencyAttemptId)?.state === "canceled") {
                state.last={status:"canceled",reason:spawned.reason,attemptId:emergencyAttemptId};
                state.writerThreadId=undefined;
                break;
              }
              const fallbackFailureReason=`emergency_fallback_failed:${spawned.reason}`;
              transitionAttempt(db,emergencyAttemptId,"blocked",{reason:fallbackFailureReason});
              state.last={status:"blocked",reason:fallbackFailureReason,attemptId:emergencyAttemptId,
                emergencyFallback:{state:"failed",reason:spawned.reason,trigger:decision.reason,attemptId:emergencyAttemptId,providerId:fallback.providerId,model:fallback.model}};
              state.writerThreadId=undefined;
              lastFallbackAttemptId=null;
              // A fallback that cannot start (its own limit, not in this host's catalog) hands over to the next one.
              failure={status:"spawn_rejected",reason:spawned.reason};
              continue;
            } else {
              state.writerThreadId=spawned.threadId;
              // The fallback owns the continued worktree now; the next fallback, if this one fails, continues from here.
              if (continuation) state.unremovedWorktree=undefined;
              continueFrom=getAttempt(db,emergencyAttemptId);
              if (state.liveFolder) { state.liveBackupId=emergencyAttemptId; await bindLiveBackup(deps, state); }
              state.writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
              if (state.writerSelection) await noteWriterPair(bb.storage.kv as never, input.runId, input.taskId,
                { providerId:state.writerSelection.providerId, model:state.writerSelection.model }, `failure_class:${primaryClass}`, bb.log);
              state.activeConfig=state.freshConfig;
              state.activeTask=retargetTask(state.freshTask,spawned.workspacePath);
              state.executionPacketSha256=spawned.executionPacketSha256 ?? null;
              const fallbackWorkspace=getAttempt(db,emergencyAttemptId)?.workspace_path;
              state.dirtBefore=!continuation&&state.baselineWorkspacePath&&fallbackWorkspace===state.baselineWorkspacePath
                ? state.baselineDirtBefore??spawned.dirtBefore : spawned.dirtBefore;
              const emergencyFallback={reason:decision.reason,primaryAttemptId,providerId:emergencySelection.providerId,model:emergencySelection.model};
              state.last={...await services.finishWriterAttempt({
                projectId:input.projectId,config:state.activeConfig,task:state.activeTask,runId:input.runId,taskId:input.taskId,
                attemptId:emergencyAttemptId,pmThreadId:input.pmThreadId,writerThreadId: state.writerThreadId,dirtBefore: state.dirtBefore,
                emergencyFallback,releaseSlot:()=>{ state.releaseWriterSlot?.(); state.releaseWriterSlot=undefined; },
              }),emergencyFallback:{state:"completed",...emergencyFallback,attemptId:emergencyAttemptId}};
              if (failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null) === "judgment") dropLiveWriterKey(deps, state);
              const workspaceBinding=getAttempt(db,emergencyAttemptId);
              if(workspaceBinding?.workspace_path) state.last={...state.last,workspace:{path:workspaceBinding.workspace_path,
                environmentId:workspaceBinding.environment_id,decision:workspaceBinding.workspace_decision,
                ...(isLiveDecision(workspaceBinding.workspace_decision)?{mode:LIVE_FOLDER_RECEIPT}:{})}};
              await noteAttemptOutcome({ budget: state.budget, writerThreadId: state.writerThreadId, writerSelection: state.writerSelection, status:String(state.last.status), reason:typeof state.last.reason === "string" ? state.last.reason : null });
              noteOwnFailure(state, state.last);
              if (state.last.status === "accepted") { state.acceptedAttemptId=emergencyAttemptId; break; }
              lastFallbackAttemptId=emergencyAttemptId;
              failure=state.last;
            }
        }
        // The chain ended without a writer that got through: the task ends blocked with the last fallback's reason, as
        // every exit of the loop above does. Left «validation_failed» it read as still at work: the PM was never told, and
        // a task that depends on it waited with no limit (SelfyStudio 2026-10-15, chat-free-muse-trial-api: 6.5 hours).
        const endedFallback=lastFallbackAttemptId && state.last.status !== "accepted" ? getAttempt(db,lastFallbackAttemptId) : undefined;
        if (endedFallback && RETRY_ELIGIBLE.includes(endedFallback.state as AttemptState)) {
          const endedReason=typeof state.last.reason === "string" && state.last.reason ? state.last.reason : String(state.last.status);
          transitionAttempt(db,endedFallback.id,"blocked",{reason:endedReason, ...failureFieldsOf(state.last)});
          state.last={...state.last,status:"blocked",reason:endedReason};
        }
      }
      return "done";
      };
