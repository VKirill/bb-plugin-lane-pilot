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


/** The createWriterStart locals startWriterTask closes over, passed in so the function can live in its own module. */
export interface StartWriterTaskDeps {
  ctx: ServerCore;
  services: Services;
  sticky: ReturnType<typeof createWriterSticky>;
  admitted: Map<string, { runId:string; taskId:string; projectId:string }>;
  pickWriter: (settings:Record<string, unknown>, input:{ projectId:string; runId:string; taskId:string; task:TaskV2; config:PrototypeConfig }) => ReturnType<typeof writerPickOverlay>;
  noteAttemptOutcome: (input:{ budget:RunBudget; writerThreadId:string; writerSelection?:{providerId:string;model:string}; status:string; reason:string|null }) => Promise<void>;
  chainWithRoom: <T extends { providerId:string; model:string }>(chain:T[], hostId:string, settings:Record<string, unknown>, taskId:string) => Promise<{ chain:T[]; room:boolean; nextReset:string|null }>;
}

export function createStartWriterTask(deps: StartWriterTaskDeps) {
  const { ctx, services, sticky, admitted, pickWriter, noteAttemptOutcome, chainWithRoom } = deps;
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
      writerOverlay: undefined as never,
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
      // A merge conflict or a fault of Lane Pilot or the machine does not spend an attempt; free retries are capped too.
      // Free retries are counted within this start: a task restarted after a Lane Pilot fix gets its full share,
      // while attempts burned on the fault before it stay out of the count (BB-сервис 2026-10-05: five fault attempts
      // left the restarted task no attempt at all, and it sat queued with its stages failed).
      const attemptsLeft = () => countChargedAttempts(db, input.runId, input.taskId) <= MAIN_ATTEMPT_LIMIT
        && state.attemptsHere < MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT;
      // A task is ONE writer session: a failure of the task's own goes back to the same writer as a feedback turn (a new
      // attempt row in its thread, not a new charged attempt) until the checks pass, the turn cap (SESSION_MAX_TURNS) or
      // the wall cap (SESSION_MAX_MS) is reached, or two turns in a row leave both the failure and the diff unchanged.
      // Only a provider or limit fault, or a thread that cannot take the turn, starts another writer.
      /** Another attempt follows this failure: the same conditions the loop checks below before it creates one. */
      const attemptsLeftAfter = (binding:ReturnType<typeof getAttempt>) => Boolean(binding?.thread_id)
        && RETRY_ELIGIBLE.includes(String(state.last.status) as AttemptState)
        && countChargedAttempts(db, input.runId, input.taskId) < MAIN_ATTEMPT_LIMIT
        && state.attemptsHere + 1 < MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT;
      /** Takes over an existing writer thread for this attempt; false leaves the attempt to a fresh spawn. */
      const continueWith = async (writer:NonNullable<Awaited<ReturnType<typeof sticky.hotWriter>>>, kind:"next-task"|"retry"|"merge", previousAttempt:string, keepDirt?:DirtSnapshot[]):Promise<boolean> => {
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
      // The baseline (src/rooms/baseline): the task's checks on the base before any writer is asked. «Already built» is told to the PM, or in
      // mode stop ends the task here with the evidence. A mainfix has its own preflight below; a folder without git has no base to run on.
      const baselinePreflight = async ():Promise<boolean> => {
        if (!state.writerThreadId && !input.turnSent && !state.liveFolder && !isMainfixTask(input.task.id)) {
          const baseline = await services.baseline?.preflight({ projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId: state.attemptId, pmThreadId:input.pmThreadId, config:state.freshConfig, task:state.freshTask });
          if (baseline?.alreadyDone) {
            ctx.log(`baseline ${input.taskId}: checks already pass on the base; closing accepted without a writer`);
            transitionAttempt(db, state.attemptId, "accepted");
            state.last = { status:"accepted", attemptId: state.attemptId, produced:[], verification:[], alreadyDone:baseline.alreadyDone };
            state.acceptedAttemptId = state.attemptId;
          } else if (baseline?.stop) { blockBeforeWriter(deps, state, input, baseline.stop); return false; }
        }
        return true;
      };
      // The area's writer from an earlier task of this run takes this one in its own thread, unless the writer setting now names
      // another provider or model: then this task gets a fresh writer on the current one (the spawn's own selection, below).
      const handoffToHotWriter = async ():Promise<void> => {
        if (!state.writerThreadId && input.task.area && !state.liveFolder) {
          const wanted = {
            providerId: typeof state.runSettings["writer.provider"] === "string" ? state.runSettings["writer.provider"] as string : state.freshConfig.writerProviderId,
            model: typeof state.runSettings["writer.model"] === "string" && state.runSettings["writer.model"] ? state.runSettings["writer.model"] as string : state.freshConfig.writerModel,
          };
          const hot = await sticky.hotWriter(input.projectId, input.runId, input.task.area, wanted);
          if (hot) await continueWith(hot, "next-task", "");
        }
      };
      /** The writer session: spawn or continue → finish → judge the failure → retry in thread, respawn, or hand to the chain. */
      const attemptLoop = async ():Promise<"done"|"stop"> => {
      let pauseReadItemKey: string | null = null;
      // The attempt's state decides whether this wait is still its business: a cancel, an accept, a block or a
      // vanished row ends it even while the pause flag itself cannot be read. `queued` stays — the first
      // stage-boundary wait runs before the spawn, while the attempt is still queued by design.
      const pauseWaitShouldStop = () => {
        const pauseAttemptState = getAttempt(db, state.attemptId)?.state;
        return pauseAttemptState === undefined || pauseAttemptState === "cancel_requested" || pauseAttemptState === "canceled" || pauseAttemptState === "accepted" || pauseAttemptState === "blocked";
      };
      while (attemptsLeft()) {
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
            break;
          }
          if (!reassigned) state.budget.noteAttempt();
          const afterAttempt=state.budget.check();
          if (!afterAttempt.ok) {
            const reason=budgetStopReason(afterAttempt.exceeded);
            transitionAttempt(db, state.attemptId, "blocked", { reason });
            state.last = { status:"blocked", reason, attemptId: state.attemptId };
            break;
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
        const moreAttempts = attemptsLeftAfter(failedBinding);
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
          break;
        }
        if (state.last.status !== "accepted" && state.last.status !== "blocked") state.primaryFailure={...state.last};
        const failed = String(state.last.status) as AttemptState;
        if (!RETRY_ELIGIBLE.includes(failed)) break;
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
          if ((scanned.kind === "blocked" && scanned.reason === "page_cap") || (scanned.kind === "error" && cursor.read() !== null)) break;
          if (scanned.kind === "blocked" || scanned.kind === "error") {
            // Both end the attempt: an error left it «spawn_rejected» with its stages closed, and nothing retried it (found by the
            // fault-injection simulation, tests/simulation). A reconcile_ reason is Lane Pilot's fault: the task is parked.
            transitionAttempt(db, attempt.id, "blocked", { reason:scanned.kind === "blocked" ? `reconcile_${scanned.reason}` : `reconcile_error: ${scanned.message}` });
            state.last = { ...state.last, status:"blocked", reason:scanned.kind === "blocked" ? scanned.reason : scanned.message };
            break;
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
            break;
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
          break;
        }
        // A secret the checks need went away mid-task: the attempt is not charged and the task is parked until it is back.
        if (PARKED_CLASSES.has(failedClass) || isWaitingSecret(typeof state.last.reason === "string" ? state.last.reason : null)) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(state.last.reason ?? state.last.status), ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked" };
          break;
        }
        // The retry-safety gate (writer.retry_safety): an automatic retry stops when the failed attempt's work area was
        // touched after it ended (owner edits, rewritten check evidence, a catalog secret in the diff).
        if (configuredSetting(state.runSettings, "writer.retry_safety") !== "off") {
          const safety = await retrySafetyStop({ db, host, hostId:input.config.hostId, task:state.freshTask, attemptId: state.attemptId, liveFolder: state.liveFolder, log:ctx.log });
          if (safety) {
            const latest = getAttempt(db, state.attemptId);
            if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:safety });
            state.last = { ...state.last, status:"blocked", reason:safety };
            break;
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
            break;
          }
        }
        // The session ended: the turn cap or the wall cap blocks the task. A repeated red check (the same failure and
        // the same diff twice) does not: the next attempt goes to the next writer in the chain, not this one again.
        if (sessionEnd) {
          const ended = `${sessionEnd}: ${String(state.last.reason ?? state.last.status)}`;
          if (sessionEnd.startsWith("no progress:") && failedClass !== "verification_timeout" && verificationFailure(state.last)) {
            state.checkEscalation = ended;
            break;
          }
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:ended, ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked", reason:ended };
          break;
        }
        if (countChargedAttempts(db, input.runId, input.taskId) >= MAIN_ATTEMPT_LIMIT
          || state.attemptsHere >= MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) {
            const exhausted = `retry limit 2 exhausted${typeof state.last.reason === "string" && state.last.reason ? `: ${state.last.reason}` : ""}`;
            transitionAttempt(db, latest.id, "blocked", { reason:exhausted, ...failureFieldsOf(state.last) });
            state.last = { ...state.last, status:"blocked", reason:exhausted };
          }
          break;
        }
        // Two attempts of the task family failing the same way stop the task: a third attempt of the same writer
        // would only repeat them. A repeated red check is the exception: the next attempt is the next writer in the
        // chain. A turn in the same thread is not stopped here: the session's own early stop is above.
        const repeated = redo ? null : repeatedFailureReason(state.familyFailure, { state:String(state.last.status), reason:typeof state.last.reason === "string" ? state.last.reason : null });
        if (repeated && failedClass !== "verification_timeout" && verificationFailure(state.last)) {
          state.checkEscalation = repeated;
          state.primaryFailure = { ...state.last };
          break;
        }
        // Cascade retry (arXiv #25/26, writer.retry_escalate): with the setting on, the first red check already goes to
        // the next writer in the fallback chain — a cheaper writer failing the task's check is reason enough to try
        // the next one, inside the same attempt budget. Off by default: a single failure retries the same writer.
        if (!repeated && failedClass === "task" && verificationFailure(state.last) && state.runSettings["writer.retry_escalate"] === true) {
          state.checkEscalation = `retry_escalate: ${String(state.last.reason ?? "")}`;
          state.primaryFailure = { ...state.last };
          break;
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
          break;
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
          break;
        }
        if (!redo && intervention === "next_writer" && failedClass === "provider" && sameClassStreak >= 2) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(state.last.reason ?? state.last.status), ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked" };
          break;
        }
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
        if (redo && !await continueWith(redo, redo.kind, previousAttemptBrief(await trimCheckLogsIn(jev(), { ...failedLast, produced:[] }, state.freshTask.title, { projectId:input.projectId, runId:input.runId, subject:input.taskId, settings:state.runSettings }, ctx.log), state.freshTask, failedBinding?.dirt_before ?? [], state.liveFolder), failedBinding?.dirt_before)) {
          await removeFailedWorktree();
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
      /** The primary writer exhausted its session: the fallback chain takes the task over, writer by writer. */
      const fallbackChain = async ():Promise<"done"|"stop"> => {
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
      /** The task's end for these writers: worktree and live-folder cleanup, the terminal receipts, the reactions. */
      const recordOutcome = async ():Promise<void> => {
      // A worktree kept for a fallback that did not continue in it (no chain, a guard stopped it) is removed as any failed one.
      // A writer's question keeps its worktree: the answer continues there. Removing it here also hung the live-writer
      // key (the sweep then skipped the question) when the host call did not return.
      const asked = failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null) === "judgment";
      const questionWorktree = asked && state.unremovedWorktree?.id === (typeof state.last.attemptId === "string" ? state.last.attemptId : state.attemptId);
      if (state.unremovedWorktree && !questionWorktree) await removeWorktreeOf(deps, state, input, state.unremovedWorktree);
      // Whatever the writers left in a folder without git is taken back when no attempt was accepted.
      if (state.last.status !== "accepted") await rollbackLive(deps, state, input);
      // The task is over for these writers (a writer's question keeps its thread: its answer goes on there).
      if (state.last.status !== "accepted" && failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null) !== "judgment") await releaseFailedThreads(deps, state, input);
      // The writer's turns on this task (its first answer and every feedback turn), kept in the stage receipt.
      const turns = state.writerThreadId ? countThreadTurns(db, input.runId, input.taskId, state.writerThreadId) : 0;
      if (turns) state.last = { ...state.last, turns };
      const accepted = state.last.status === "accepted";
      const reason = accepted ? undefined : String(state.last.reason ?? state.last.status ?? "writer_failed");
      // A writer's question would wait unseen: writers are quiet children and do not wake the PM.
      if (!accepted && reason && failureClass(String(state.last.status), reason) === "judgment" && input.pmThreadId) {
        noteToldPmDirectly(db, input.pmThreadId, input.taskId);
        void bestEffort(ctx.log, "writer question notice", sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:state.writerThreadId || undefined,
          text:`Lane Pilot: ${input.taskId} stopped with a question from its writer. Answer it with lane_pilot_answer_writer (taskId, answer) — from the code or docs if they settle it, else ask the owner once; the writer continues in its own thread and no attempt is spent. ${WRITER_QUESTION_WAIT_TEXT} Send the task again only when the contract itself must change; tasks that depend on it wait for that.${state.liveFolder ? " This folder has no git, so the writer's files stay where they are and the folder stays locked: other tasks for it queue until this question is answered (or the task is sent again)." : ""}\n${reason.slice(0, 1200)}` }), undefined);
      }
      // A failed task is told to stability before the receipts close the run: its record reads the run still running
      // (the harness breaker's noteHarnessFailure skips a run that is already blocked). Accepted work emits after the
      // refresh below — the after-acceptance graph starts on the settled run, as before.
      if (!accepted && state.last.status !== "canceled") {
        try {
          await emitAttemptFinished(ctx, { scope:"task", projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            attemptId: state.attemptId, pmThreadId:input.pmThreadId, writerThreadId:state.writerThreadId ?? null, task:input.task, config:state.activeConfig,
            status:String(state.last.status), reason:reason ?? null, result:state.last,
            writerSelection:state.writerSelection ? { providerId:state.writerSelection.providerId, model:state.writerSelection.model } : undefined,
            judged:state.judged && state.judged.status === String(state.last.status) && state.judged.reason === (typeof state.last.reason === "string" ? state.last.reason : null)
              ? { failureClass:state.judged.klass, mast:state.judged.mast ?? null, intervention:state.judged.intervention ?? null, streak:state.judged.streak ?? null } : undefined,
            acceptedAttemptId:null });
        } catch (emitCause) {
          ctx.log(`attempt-finished: emit failed for ${input.taskId}: ${emitCause instanceof Error ? emitCause.message : String(emitCause)}`);
        }
      }
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
        if (current?.state === "pending") {
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
        }
        const terminal = accepted ? "passed" : state.last.status === "canceled" ? "canceled" : "failed";
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:terminal,
          input:input.plan, attempt:Math.min(countAttempts(db, input.runId, input.taskId),MAIN_ATTEMPT_LIMIT),
          providerId:stageId==="writer-agent"?state.writerSelection?.providerId:undefined,
          model:stageId==="writer-agent"?state.writerSelection?.model:undefined,threadId:state.writerThreadId,
          result:stageId === "writer-agent" ? {
            ...state.last,
            // #33: the decision this stage made, next to the outcome — failure class, its MAST-14 bucket and the
            // intervention the class's streak got, so receipts read why the retry went this way.
            ...(state.judged ? { decision: { failureClass: state.judged.klass, mast: state.judged.mast ?? null, intervention: state.judged.intervention ?? null, streak: state.judged.streak ?? null } } : {}),
            execution: state.writerSelection ? {
              providerId:state.writerSelection.providerId,
              model:state.writerSelection.model,
              reasoningLevel:state.writerSelection.reasoningLevel ?? null,
              serviceTier:state.writerSelection.serviceTier ?? null,
              selectionSource:state.writerSelection.selectionSource ?? null,
            } : state.last,
          } : accepted ? stageId === "verification"
            ? { produced:state.last.produced, verification:state.last.verification, runV2:state.last.runV2 }
            : state.last : null, reason:accepted ? undefined : reason });
      }
      refreshRun(input.runId);
      if (accepted) {
        try {
          await emitAttemptFinished(ctx, { scope:"task", projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            attemptId: state.attemptId, pmThreadId:input.pmThreadId, writerThreadId:state.writerThreadId ?? null, task:input.task, config:state.activeConfig,
            status:"accepted", reason:null, result:state.last,
            writerSelection:state.writerSelection ? { providerId:state.writerSelection.providerId, model:state.writerSelection.model } : undefined,
            acceptedAttemptId: state.acceptedAttemptId });
        } catch (emitCause) {
          ctx.log(`attempt-finished: emit failed for ${input.taskId}: ${emitCause instanceof Error ? emitCause.message : String(emitCause)}`);
        }
      }
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
      if (!await baselinePreflight()) return;
      await handoffToHotWriter();
      if (await attemptLoop() === "stop") return;
      if (await fallbackChain() === "stop") return;
      await recordOutcome();
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
