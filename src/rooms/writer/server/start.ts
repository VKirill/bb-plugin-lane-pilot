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
import { runOnHost } from "@lane-pilot/host-calls";
import { WRITER_PICK_PREFIX, writerPickOverlay, type WriterLoad } from "../writer-model-pick";
import { loadWriterPin, noteWriterPair } from "../writer-model-pin";
import { reassignedReason, takeReassignRequest, type ReassignRequest } from "./reassign";
import { usageHoldReason, usageSkipPercent } from "../../usage/server";
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
import { openDatabase } from "../../storage";
import { createWriterSticky } from "./sticky";
import { WRITER_QUESTION_WAIT_TEXT } from "./question-default";
import { jev } from "@lane-pilot/jev";
import { judgedFailureClass } from "../../runs";
import { isHeld, isRunHalted, isRunPaused, waitWhileRunPaused } from "../../runs/server";
import { allowedSecretNames, secretProblem, waitingSecretNote, waitingSecretReason } from "../../secrets/server";

import type { BaselineApi } from "../../baseline/server/baseline";
import type { MoneyApi } from "../../money/server";
import type { OwnerPresenceApi } from "../../owner-presence/server/presence";
import type { RollbackApi } from "../../rollback/server/rollback";
import { recoveryState } from "../../rollback";
import type { RuleScanApi } from "../../self-repair/server/rule-scan";
import type { ReconcileApi } from "../../stability/server/reconcile";
import type { StabilityPort } from "../../contracts";
import type { WallApi } from "../../wall/service";
import type { WriterFinishApi } from "./finish";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStateApi } from "./state";
import type { WriterVerifyApi } from "./verify";

import type { HarnessApi } from "../../harness/server/harness";
/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  baseline: BaselineApi;
  concurrencyLimit: WriterStateApi["concurrencyLimit"];
  finishWriterAttempt: WriterFinishApi["finishWriterAttempt"];
  harness: HarnessApi;
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  money: MoneyApi;
  ownerPresence: OwnerPresenceApi;
  providerBreaker: WriterStateApi["providerBreaker"];
  providerRetry: WriterStateApi["providerRetry"];
  providerUsage: WriterStateApi["providerUsage"];
  reconcileAttemptThread: ReconcileApi["reconcileAttemptThread"];
  restoreLiveFolder: WriterSpawnApi["restoreLiveFolder"];
  rollback: RollbackApi;
  ruleScan: RuleScanApi;
  runBudgetFor: WriterStateApi["runBudgetFor"];
  runVerification: WriterVerifyApi["runVerification"];
  runWriterPool: WriterStateApi["runWriterPool"];
  spawnWriterAttempt: WriterSpawnApi["spawnWriterAttempt"];
  stability: StabilityPort;
  startAfterAcceptance: WorkflowEngineApi["startAfterAcceptance"];
  wall: WallApi;
  workspaceDirt: WriterSpawnApi["workspaceDirt"];
}

import { createStartWriterTask } from "./start-writer-task";
import { admittedByCore } from "./start-admitted";
import { copyRefusedKeyPrefix } from "./copy-refused-key";

export { freshAttemptStart } from "./fresh-attempt-start";
export { quarantiningRegression } from "./start-quarantine";
export { familyFailureRecord } from "./start-failure-records";
export { CANCELED_REDO_WAIT_MS } from "./start-wait-limits";
export { sameArea } from "./start-area";
export { copyRefusedKeyPrefix } from "./copy-refused-key";

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
import { mountWriterTaskFinished } from "./attempt-reactions";
import { mountStabilityAttemptFinished } from "./stability";

import type { WorkflowEngineApi } from "../../platform/server";

export function createWriterStart(ctx: ServerCore, services: Services) {
  const { bb, db, effectiveProjectSettings, host, markCanceledWriterStages, refreshRun, runPolicyFor } = ctx;
  const sticky = createWriterSticky(ctx, services);
  // The task-finished reactions, in run order: stability's failure record, the area's writer record,
  // the after-acceptance graph (attempt-reactions.ts; the room-named mounts move to their owners).
  mountStabilityAttemptFinished(ctx, services);
  mountWriterTaskFinished(ctx, services, sticky);
  // A store-read block's owner item describes a blocked attempt: when the attempt leaves blocked (requeue,
  // accepted, canceled) the item closes; the next block posts under a fresh sequence key.
  bb.onDispose(onAttemptChanged(db, (changedId) => {
    const attempt = getAttempt(db, changedId);
    if (attempt && attempt.state !== "blocked") {
      closeOwnerItemsByPrefix(db, `store-read:${changedId}:`, "attempt left blocked");
      closeOwnerItemsByPrefix(db, copyRefusedKeyPrefix(attempt.run_id, attempt.task_id), "attempt left blocked");
    }
  }));
  const admitted = admittedByCore.get(ctx) ?? new Map<string, { runId:string; taskId:string; projectId:string }>();
  admittedByCore.set(ctx, admitted);

  /** The breaker learns from provider trouble only; the budget learns the thread's token total. */
  async function noteAttemptOutcome(input:{ budget:RunBudget; writerThreadId:string; writerSelection?:{providerId:string;model:string}; status:string; reason:string|null }): Promise<void> {
    if (input.writerSelection) {
      const key = breakerKey(input.writerSelection.providerId, input.writerSelection.model);
      const outcome = input.status === "accepted" || input.status === "validation_failed" || input.status === "empty_output"
        ? "ok"
        : classifyFailure(`${input.status}:${input.reason ?? ""}`);
      services.providerBreaker.record(key, outcome === "product" ? "ok" : outcome);
    }
    try {
      const listed = await bb.sdk.threads.events.list({ threadId:input.writerThreadId, types:["thread/tokenUsage/updated"], order:"desc", limit:"50" });
      const usage = Array.isArray(listed) ? tokenUsageFromEvent(listed[0]) : null;
      if (usage) input.budget.noteTokens(usage.threadId, usage.totalTokens);
    } catch {
      // Usage is informational; a host that cannot list events does not fail the attempt.
    }
  }

  /**
   * The chain entries whose provider usage window is not spent (provider-usage, I1); `room` says whether any is. When every
   * entry is spent the whole chain stays: the reading may be stale, and a spent window still fails in the provider's own
   * words, as before.
   */
  async function chainWithRoom<T extends { providerId:string; model:string }>(chain:T[], hostId:string, settings:Record<string, unknown>, taskId:string):Promise<{ chain:T[]; room:boolean; nextReset:string|null }> {
    const threshold = usageSkipPercent(settings);
    // The usage threshold can be 0 (the windows off); ZCode's own limits (host, free hours, one slot) still hold.
    if (!chain.length || (threshold <= 0 && !chain.some((entry) => isZcodeProvider(entry.providerId)))) return { chain, room:chain.length > 0, nextReset:null };
    const holds = await Promise.all(chain.map((entry) => services.providerUsage.hold({ providerId:entry.providerId, model:entry.model, hostId, threshold, settings })));
    const usable = chain.filter((_, index) => !holds[index]);
    if (usable.length) chain.forEach((entry, index) => { if (holds[index]) ctx.log(`writer ${taskId}: ${entry.providerId}/${entry.model} skipped, ${usageHoldReason(entry.providerId, entry.model, holds[index]!)}`); });
    const resets = holds.flatMap((hold) => (hold?.resetsAt ? [hold.resetsAt] : [])).sort();
    return usable.length ? { chain:usable, room:true, nextReset:resets[0] ?? null } : { chain, room:false, nextReset:resets[0] ?? null };
  }

  /** Jev's writer for a task, once per task (kept in the KV), as the settings it changes; null keeps the project's writer. */
  const pickWriter = (settings:Record<string, unknown>, input:{ projectId:string; runId:string; taskId:string; task:TaskV2; config:PrototypeConfig }) =>
    writerPickOverlay({ kv:bb.storage.kv as never, jev:jev(), log:(line) => bb.log.warn(line),
      // A writer whose provider window is spent (usage.skip_percent) is not offered to Jev; ZCode neither where it cannot work now (no zcode
      // provider on the task's machine, outside its free hours, or busy).
      held:async (profile) => Boolean(await services.providerUsage.hold({ providerId:profile.providerId, model:profile.model, hostId:input.config.hostId,
        threshold:isZcodeProvider(profile.providerId) ? 0 : usageSkipPercent(settings), settings })),
      load:(profiles) => writerLoad(profiles, input.config.hostId, settings, input.projectId) },
      settings, input);

  /**
   * How busy each offered writer's provider is, for Jev to spread the tasks: the spent share of its usage window (from the cached
   * readings; null when nothing is measured) and the writer tasks running on that provider now (the picks kept for running tasks).
   */
  /** Refusals count as a share only from 10 attempts of the pair in this project: below that a single spawn_rejected would skew the pick. */
  const REFUSAL_WINDOW_MS = 30 * 86_400_000;
  const REFUSAL_MIN_ATTEMPTS = 10;
  const refusalShares = (projectId:string):Map<string, { attempts:number; refused:number }> => {
    const rows = listTracedAttemptsSince(db, projectId, Date.now() - REFUSAL_WINDOW_MS);
    const out = new Map<string, { attempts:number; refused:number }>();
    for (const row of rows) {
      let trace:{ providerId?:string; model?:string } | null = null;
      trace = parseJsonOr(row.trace_json, null) as { providerId?:string; model?:string } | null;
      if (!trace?.providerId || !trace.model) continue;
      const pair = `${trace.providerId}/${trace.model}`;
      const cell = out.get(pair) ?? { attempts:0, refused:0 };
      cell.attempts += 1;
      if (row.state === "provider_error" || row.state === "spawn_rejected") cell.refused += 1;
      out.set(pair, cell);
    }
    return out;
  };

  async function writerLoad(profiles:readonly WriterProfile[], hostId:string, settings:Record<string, unknown>, projectId:string):Promise<Record<string, WriterLoad>> {
    // ponytail: counts only tasks whose writer Jev picked (a task on the project's own writer has no kept pick); count attempts by writer pair if that skews the spread.
    const running = new Map<string, number>();
    const picks = await Promise.all([...services.activeWriterTasks].map((key) => bb.storage.kv.get(`${WRITER_PICK_PREFIX}${key}`)));
    for (const picked of picks) {
      const provider = typeof picked === "string" && picked ? WRITER_PROFILES.find((row) => row.key === picked)?.providerId : undefined;
      if (provider) running.set(provider, (running.get(provider) ?? 0) + 1);
    }
    // W31 rank 3b: a pair whose attempts this project's providers keep refusing pays for it in the pick; writer.pick_refusal_penalty=off keeps the old behaviour.
    const refusals = settings["writer.pick_refusal_penalty"] === false || settings["writer.pick_refusal_penalty"] === "off" ? new Map<string, { attempts:number; refused:number }>() : refusalShares(projectId);
    const out:Record<string, WriterLoad> = {};
    await Promise.all(profiles.map(async (profile) => {
      const spent = isZcodeProvider(profile.providerId) ? null
        : await bestEffort(ctx.log, "writer provider usage hold", services.providerUsage.hold({ providerId:profile.providerId, model:profile.model, hostId, threshold:1, settings }), null);
      const pair = refusals.get(`${profile.providerId}/${profile.model}`);
      out[profile.key] = { percent:spent?.percent ?? null, running:running.get(profile.providerId) ?? 0,
        refuseShare: pair && pair.attempts >= REFUSAL_MIN_ATTEMPTS ? pair.refused / pair.attempts : null };
    }));
    return out;
  }
  const startWriterTask = createStartWriterTask({ ctx, services, sticky, admitted, pickWriter, noteAttemptOutcome, chainWithRoom });

  return { startWriterTask };
}

export type WriterStartApi = ReturnType<typeof createWriterStart>;
