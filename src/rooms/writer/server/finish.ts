import { appetiteStop, breakerKey, runningWriterBudgetStop, tokenUsageFromEvent } from "@lane-pilot/resilience";
import type { StageHelperSettings } from "../../platform/server";
import { checkTimeoutSec } from "../check-timing";
import { pipelineWriterStep, pipelineWriterTag } from "./pipeline-tag";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { writerLeftWorktree } from "./left-worktree";
import { countAttempts, countOtherLiveAttemptsInArea, countThreadTurns, firstAttemptAt, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getTask, getTaskPlan, listOpenAttempts, listStageReceipts, loadProjectSettings, priorAttemptStates, transitionAttempt, taskBasePath, failureFieldsOf } from "../../storage";
import { saveBlockedBy, type BlockedBy } from "../../runs/server";
import { relayFor } from "../../relay/server";
import type { HelperPolicySnapshot } from "../../contracts/helper-context";
import {providerLimitNotice, writerExecutionSelection} from "@lane-pilot/models";
import { actionableFindings, advisoryFeedback, buildCandidateEvidence, codeCritiqueSource, codeRepairPrompt, findingsHash, nextRepairAction, parseCodeCritiqueSettings, parseWriterRepairReply, repairLedgerFromResult, sameUnresolvedFindings, sameWriterIdentity, settingsFromFrozenPolicy, shouldRequestRepair } from "../../critique";
import type { WriterIdentity } from "../../critique";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, critiqueRepeatSkip, patchChangedLines, resolveCodeCriticDefault, resolveQualityMode, withReferenceTestCritic } from "../../contracts/quality-mode";
import { loadCriticCodeDefault } from "./critic-override";
import { runPlanFactStage } from "./plan-fact";
import { candidatePatches, headSides, runCodeCritique } from "../../critique/server";
import { fullAccessSpawn, setAsideOnStartFailure } from "../../platform/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { closeWriterStages, recordGateEvaluation, recordStage } from "../../runs/server";
import {bestEffort, fileAllowedByOwns, isNotFound, orMiss, outputText, sha256Hex, stringAt} from "@lane-pilot/kit";
import { wasAnsweredByDefault } from "./question-default";
import { appendTaskQa } from "./reopen-attempt";
import {needsHumanQuestion, providerStreamError, WRITER_STREAM_ERROR, writerContextBlocks, writerSetupLines} from "./writer-task";
import { isLiveDecision } from "../live-folder";
import { OWNER_WORD_WAIT_MS, TASK_WORDS_KEY, acceptanceArtifactDir, acceptanceProofGap, taskSizeOf, landingWordGap, landingWordAsked, questionsFromFile, checkScriptEdits, recordTaskApproach, recordTaskQuestions, referenceTestEdits, taskWordKey, testEditAllowance, testEditHoldKey, testFitFindings, writerMarkers } from "../../tasks";
import type { TaskWord } from "../../tasks";
import type { StageId } from "../../tasks";
import { THREAD_WATCH_EVENT_TYPES, listThreadEventsRaw, sleepUntilThreadSignal, startLimitWaiting, threadFailure, threadWatchMark, waitThreadIdle } from "@lane-pilot/thread-observe";
import { resolve } from "node:path";
import type { ServerCore } from "../../contracts/server";

import { clearFollowUpCancelled, followUpCancelled, loadFollowUp } from "./sticky";
import { askGuestsToCommit } from "./checkout-guests";
import { shouldMergeAttemptWorktree } from "./spawn";
import { loadWriterNudge } from "./writer-silence";
import { recordedWriterSkills } from "./skill-pick";
import { beginChecks, checksMoved } from "../../runs"
import { REPLAY_CHECK_FAILED, THREAD_NOT_STARTED_REASON, WRITER_SILENT_REASON, failureFingerprint } from "../../contracts/failure-class"
import { taskFamily } from "@lane-pilot/contracts";
import { bookkeepingSetting } from "@lane-pilot/settings-catalog";
import { attemptMergeMessage, clearMergeIntent, recordMergeIntent } from "../../verification/server";
import { sendServiceMessage } from "../../relay/server";
import { judgeRulesOnDiff, ruleViolationRemark } from "../../learning";
import { jev, type JevSettings } from "@lane-pilot/jev";
import { taskWordItemPrefix, type LeadRoadApi, type TaskWordPort } from "../../contracts";
import { closeOwnerItemsByPrefix, postOwnerItem, rpcLine } from "../../owner-waiting";
import { writerFinishScanJudgment } from "../finish-scan";
import { runOnHost } from "@lane-pilot/host-calls";
import { pollPause } from "@lane-pilot/kit";
import { emitAttemptFinished, type AttemptFinished } from "./attempt-finished";
import { progressJournal } from "../session-digest";
import { mountWriterAttemptFinished } from "./attempt-reactions";
import { mountVerificationAttemptFinished } from "./verification";
import { mountRuleFormsAttemptFinished } from "./rule-forms";

import type { RollbackApi } from "../../rollback/server/rollback";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStateApi } from "./state";
import type { WriterVerifyApi } from "./verify";

import type { BaselineApi } from "../../baseline/server/baseline";
import type { PromotionServiceApi } from "../../rule-forms/promotion-service";
import type { WriterDispatchApi } from "./dispatch";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  stageHelperSettings: StageHelperSettings;
  baseline: BaselineApi;
  dispatchWriter: WriterDispatchApi["dispatchWriter"];
  persistWriterAcceptance: WriterVerifyApi["persistWriterAcceptance"];
  promotions: PromotionServiceApi;
  providerBreaker: WriterStateApi["providerBreaker"];
  rollback: RollbackApi;
  runBudgetFor: WriterStateApi["runBudgetFor"];
  runVerification: WriterVerifyApi["runVerification"];
  validateWriterResult: WriterVerifyApi["validateWriterResult"];
  workspaceDirt: WriterSpawnApi["workspaceDirt"];
  taskWords: TaskWordPort;
  leadRoad: LeadRoadApi;
}

export { postMergeRepair } from "./verification";

/** The area's copy stays while it holds queued or running work; with none, the merge removes it now, not at the sweep (WT2 A2). */
function areaHasLiveWork(db: Parameters<typeof countOtherLiveAttemptsInArea>[0], input: { projectId: string; taskId: string }): boolean {
  return countOtherLiveAttemptsInArea(db, input.taskId) > 0;
}

const FOLLOW_UP_DELETED = "the owner deleted the queued instruction for this writer";

/** How long an accepted attempt waits for another task's merge into the same checkout before it reports the block. */
const MERGE_QUEUE_MS = 15 * 60_000;
/** How long finished work waits for someone's uncommitted edits in the base checkout to be committed or put away. */
const DIRTY_BASE_WAIT_MS = 2 * 3600_000;
const dirtyBase = (merged:{ status:string; reason?:string|null }) => merged.status === "conflict" && Boolean(merged.reason?.startsWith("base checkout has uncommitted changes"));

export function createWriterFinish(ctx: ServerCore, services: Services) {
  const { bb, db, getThreadBounded, host } = ctx;
  // The attempt-finished reactions, in run order: the settle record, the landed check (verification's,
  // fire-and-forget), the skill metric and materialize, the finish scan (attempt-reactions.ts).
  mountRuleFormsAttemptFinished(ctx, services);
  const verification = mountVerificationAttemptFinished(ctx, services);
  mountWriterAttemptFinished(ctx, services);

  /** Who holds the checkout: the open attempt whose task the holder's commit message names. */
  function mergeHolder(runId: string, holder: string | null, since: number): BlockedBy {
    const projectId = getRun(db, runId)?.project_id;
    const taskId = holder?.split(":")[0]?.trim() || null;
    const attempt = taskId ? listOpenAttempts(db).find((row) => row.task_id === taskId && row.project_id === projectId) : undefined;
    return { kind:"merge-lock", holderTaskId:taskId, holderThreadId:attempt?.thread_id ?? null, holderAttemptId:attempt?.id ?? null,
      since:new Date(since).toISOString(), retryAfterSec:60, detail:holder };
  }

  type FinishInput = {
    projectId:string; config:PrototypeConfig; task:TaskV2;
    runId:string; taskId:string; attemptId:string; pmThreadId:string; writerThreadId:string;
    dirtBefore:import("../cli-outcome").DirtSnapshot[];
    emergencyFallback?:{reason:string;primaryAttemptId:string;providerId:string;model:string};
    /** Gives the writer's pool slot back early: the wait for the owner's word needs no writer seat (Gemini F-008.2). */
    releaseSlot?:()=>void;
  };

  /** The attempt's end, whatever its outcome: the reactions on the attempt-finished bus run last (attempt-finished.ts). */
  async function finishWriterAttempt(input: FinishInput): Promise<Record<string,unknown>> {
    let result: Record<string, unknown> | null = null;
    // Facts the body learns on the way out, for the reactions: what landed, how far the gates passed.
    const facts: Pick<AttemptFinished, "writerStopped"> = {};
    try {
      result = await finishWriterAttemptBody(input, facts);
      return result;
    } finally {
      try {
        await emitAttemptFinished(ctx, { scope:"attempt", projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          attemptId:input.attemptId, pmThreadId:input.pmThreadId, writerThreadId:input.writerThreadId,
          task:input.task, config:input.config, status:String(result?.status ?? "error"),
          reason:typeof result?.reason === "string" ? result.reason : null, result, ...facts });
      } catch (cause) {
        ctx.log(`attempt-finished: emit failed after ${input.attemptId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  async function finishWriterAttemptBody(input: FinishInput, facts: Pick<AttemptFinished, "writerStopped">): Promise<Record<string,unknown>> {
    // The PM's stop and a failure can land together: an attempt whose stop was requested ends canceled whatever failed
    // (cancel_requested has only canceled, blocked and accepted to go to, and the owner asked for the stop).
    const endedByStop = (reason:string, threadId = input.writerThreadId):Record<string,unknown>|null => {
      if (getAttempt(db, input.attemptId)?.state !== "cancel_requested") return null;
      transitionAttempt(db, input.attemptId, "canceled", { threadId, reason:`writer stop observed after: ${reason}`.slice(0, 500) });
      return { status:"canceled", attemptId:input.attemptId, writerThreadId:threadId };
    };
    // The PM's stop can land after validation passed (cab-unslop-kit.2, 2026-10-31: canceled 8 s after its validate gate). The row was
    // canceled by cancel.ts while this finish went on: it ran the critics, told the PM «passed its checks, waits for the owner's word»,
    // held the task's files for 32 min (start.ts `admitted`, so the sibling task queued behind it), and after the word died on the
    // removed worktree and parked a canceled task. Every stage boundary after validation reads the row first.
    const stoppedMeanwhile = (where:string, threadId = input.writerThreadId):Record<string,unknown>|null => {
      const state = getAttempt(db, input.attemptId)?.state;
      if (state === "cancel_requested") return endedByStop(where, threadId);
      return state === "canceled" ? { status:"canceled", attemptId:input.attemptId, writerThreadId:threadId } : null;
    };
    const providerFailed = (reason:string) => {
      const stopped = endedByStop(reason);
      if (stopped) return stopped;
      transitionAttempt(db, input.attemptId, "provider_error", { reason });
      return { status:"provider_error", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
    };
    // A provider limit the OpenCode log named holds the writer's provider/model open until its reset time (else the cooldown).
    const holdProviderLimit = (until?:number) => {
      const trace = getReasoningTrace(db, input.attemptId);
      if (trace) services.providerBreaker.record(breakerKey(trace.providerId, trace.model), "exhausted", Date.now(), until);
    };
    let endMerge = () => undefined as void;
    try {
      const budget = services.runBudgetFor(input.runId, loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)));
      // The task's own appetite (contract `appetite`) is watched next to the run's budget: this writer's tokens and the time since the
      // wait began (a reload starts the clock again: the appetite is then counted generously, never twice).
      const appetite = input.task.appetite;
      const attemptStartedAt = Date.now();
      let writerTokens: number | null = null;
      const watchBudget = budget.snapshot().limits.maxWallMs !== undefined || budget.snapshot().limits.maxTokens !== undefined || appetite?.minutes !== undefined;
      const noteWriterTokens = async () => {
        if (budget.snapshot().limits.maxTokens === undefined) return;
        try {
          const usageListed = await bb.sdk.threads.events.list({ threadId:input.writerThreadId, types:["thread/tokenUsage/updated"], order:"desc", limit:"50" });
          const usage = Array.isArray(usageListed) ? tokenUsageFromEvent(usageListed[0]) : null;
          if (usage) { writerTokens = usage.totalTokens; budget.noteTokens(usage.threadId, usage.totalTokens); }
        } catch (cause) { ctx.log(`writer ${input.taskId}: usage events unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); }
      };
      // Stage budget question: at four fifths of the task's appetite minutes the PM is asked once whether to extend them (lane_pilot_update_task)
      // or let the writer stop. The appetite's tokens are a forecast only (packages/resilience/src/appetite.ts): no question, no stop.
      let budgetAsked = false;
      const askBudgetOnce = () => {
        if (budgetAsked || !appetite?.minutes || !input.pmThreadId) return;
        const timeUsed = (Date.now() - attemptStartedAt) / (appetite.minutes * 60_000);
        if (timeUsed < 0.8) return;
        budgetAsked = true;
        void bestEffort(ctx.log, "writer budget note", Promise.resolve().then(() => bb.sdk.threads.send({ threadId:input.pmThreadId!, mode:"queue-if-active", input:[{ type:"text", mentions:[], text:`[Lane Pilot] Task ${input.taskId} has spent ${Math.round(timeUsed * 100)}% of its appetite (${Math.round((Date.now() - attemptStartedAt) / 60_000)}/${appetite.minutes} min). Its writer stops at the appetite: raise it with lane_pilot_update_task now if the work is worth more, or let it stop.` }] } as never)), undefined);
      };
      const overBudget = () => { askBudgetOnce(); return runningWriterBudgetStop(budget.check()) ?? appetiteStop(appetite, { tokens:writerTokens, elapsedMs:Date.now() - attemptStartedAt }); };
      const stopRunningWriter = async (reason:string) => {
        const current = await bestEffort(ctx.log, "writer thread status", getThreadBounded(input.writerThreadId), null);
        const status = stringAt(current, "status");
        if (["active", "starting"].includes(status ?? "")) await bestEffort(ctx.log, "writer thread stop", bb.sdk.threads.stop({ threadId:input.writerThreadId }), undefined);
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        closeWriterStages(db, {
          runId:input.runId, taskId:input.taskId, plan:getTaskPlan(db, input.taskId) ?? "",
          terminal:"failed", attempt:countAttempts(db, input.runId, input.taskId), reason, threadId:input.writerThreadId,
        });
        facts.writerStopped = true;
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      };
      // A continued thread is idle from its previous task until the new turn starts: wait for the turn sent after `since`.
      clearFollowUpCancelled(bb, input.attemptId);
      const followUpSince = await loadFollowUp(bb.storage.kv, input.attemptId);
      if (followUpSince !== null) {
        try {
          const deleted = () => followUpCancelled(bb, input.attemptId) ? FOLLOW_UP_DELETED : null;
          if (!watchBudget) {
            await waitThreadIdle(bb, input.writerThreadId, "writer_follow_up", undefined, followUpSince, deleted);
          } else {
            let waiting = true;
            const idle = waitThreadIdle(bb, input.writerThreadId, "writer_follow_up", undefined, followUpSince, deleted)
              .finally(() => { waiting = false; });
            // A budget stop returns before this wait ends; its later rejection (thread_interrupted) must not go unhandled, which kills the BB server.
            void bestEffort(ctx.log, "writer idle wait", idle, undefined);
            while (waiting) {
              await noteWriterTokens();
              const budgetStop = overBudget();
              if (budgetStop) return await stopRunningWriter(budgetStop);
              await Promise.race([idle, new Promise((wake) => setTimeout(wake, 2_000))]);
            }
            await idle;
          }
        } catch (cause) {
          if (ctx.state.disposed) throw new Error("Lane Pilot was reloaded while the writer ran");
          const reason = cause instanceof Error ? cause.message : String(cause);
          // The owner deleted the queued instruction: it never reaches the writer, so the task is blocked, not retried.
          if (reason.endsWith(FOLLOW_UP_DELETED)) return await stopRunningWriter(`follow_up_deleted: ${FOLLOW_UP_DELETED}`);
          return providerFailed(reason);
        }
      }
      // A writer runs as long as it works, unless the run's wall or token budget is gone; BB's events say when it has failed.
      let completedThread: unknown;
      for (;;) {
        if (ctx.state.disposed) throw new Error("Lane Pilot was reloaded while the writer ran");
        const pollStarted = Date.now();
        const mark = threadWatchMark(bb);
        const currentThread = await getThreadBounded(input.writerThreadId);
        const currentStatus = stringAt(currentThread, "status");
        // The silence sweep nudged this writer twice and it stayed silent: the attempt ends and the task moves on.
        const nudge = await loadWriterNudge(bb.storage.kv, input.attemptId);
        if (nudge?.ended) {
          // The silence sweep found a provider limit in the log (writer-silence.ts): that reason, else the silent one.
          const reason = nudge.reason ?? `${WRITER_SILENT_REASON}: no activity after ${nudge.count} nudges`;
          if (nudge.reason) holdProviderLimit(nudge.until);
          const ended = providerFailed(reason);
          if (["active", "starting"].includes(currentStatus ?? "")) await bestEffort(ctx.log, "writer thread stop", bb.sdk.threads.stop({ threadId:input.writerThreadId }), undefined);
          return ended;
        }
        const listed = currentStatus === "idle" ? null : await listThreadEventsRaw(bb, { threadId:input.writerThreadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50" });
        const eventFailure = listed?.ok ? threadFailure(listed.events) : null;
        // The core could not start the session («Command thread.start failed»): the task never ran. The pair is set aside for an hour and the
        // attempt ends as an unavailable provider — free, and the chain's next writer takes it at once (feed-gen 2026-11-10: four dead
        // Antigravity starts read «writer thread status error», spent the task's two attempts and parked it).
        const notStarted = eventFailure && /thread\.start failed/i.test(eventFailure) ? eventFailure : null;
        if (notStarted) {
          const trace = getReasoningTrace(db, input.attemptId);
          if (trace) setAsideOnStartFailure(bb, `writer for ${input.taskId}`, trace.providerId, trace.model, notStarted);
          holdProviderLimit();
        }
        const rawFailure = notStarted ? `${THREAD_NOT_STARTED_REASON}: ${notStarted}`
          : currentStatus === "error" ? `writer thread status error${eventFailure ? `: ${eventFailure}` : ""}` : eventFailure;
        // A turn held in the concurrency-limit queue is waiting its turn: the provider's start limit is not a failure then.
        const failure = await startLimitWaiting(bb, input.writerThreadId, rawFailure) ? null : rawFailure;
        if (failure) {
          const ended = providerFailed(failure);
          if (["active", "starting"].includes(currentStatus ?? "")) await bestEffort(ctx.log, "writer thread stop", bb.sdk.threads.stop({ threadId:input.writerThreadId }), undefined);
          return ended;
        }
        if (currentStatus === "idle") {
          completedThread = currentThread;
          break;
        }
        if (watchBudget) {
          await noteWriterTokens();
          const budgetStop = overBudget();
          if (budgetStop) return await stopRunningWriter(budgetStop);
        }
        // A run with a wall or token budget is read every 2 s, because the budget is checked here. Otherwise BB's events
        // (idle, failed, archived) wake the loop, and a read every 20 s covers a lost event.
        const pause = Math.max(0, 2_000 - (Date.now() - pollStarted));
        if (watchBudget) await new Promise((resolve) => setTimeout(resolve, pollPause(pause)));
        else await sleepUntilThreadSignal(bb, input.writerThreadId, mark, pause);
      }
      const currentAttempt = getAttempt(db, input.attemptId);
      if (currentAttempt?.state === "cancel_requested" || currentAttempt?.state === "canceled") {
        if (currentAttempt.state === "cancel_requested") transitionAttempt(db, input.attemptId, "canceled", { threadId:input.writerThreadId, reason:"writer stop observed before validation" });
        return { status:"canceled", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      // A writer that moved its thread out of its worktree did its work elsewhere (maybe the main checkout): nothing to
      // validate here and no retry in place; the PM learns where the edits went.
      const left = await writerLeftWorktree(bb.sdk as never, input.writerThreadId, currentAttempt?.workspace_path ?? input.config.writerWorkspacePath);
      if (left) {
        const reason = `writer_left_worktree: the writer thread moved to ${left}; its edits there are not this task's — check that folder and redispatch`;
        bb.log.warn(`Lane Pilot ${input.taskId}: ${reason}`);
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      // A writer that stopped to ask the owner is not a failed attempt: no retry, no fallback, the question goes to the PM.
      const answer = outputText(await bb.sdk.threads.output({ threadId:input.writerThreadId }).catch((cause: unknown) => { ctx.log(`writer ${input.taskId}: thread output unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return ""; }));
      // The provider's own limit notice instead of a report: the task never ran, so another model takes it, uncharged.
      const limit = providerLimitNotice(answer);
      if (limit) {
        const reason = `writer_provider_limit: ${limit}`;
        return providerFailed(reason);
      }
      // The provider cut the turn off mid-work: no answer to check yet; the same writer continues in place (sticky.ts).
      const dropped = providerStreamError(answer);
      if (dropped) return providerFailed(`${WRITER_STREAM_ERROR}: ${dropped}`);
      const question = needsHumanQuestion(answer);
      if (question) {
        // Asked again after the machine's default answer (question-timeout.ts): nobody is coming, the attempt ends and frees the task.
        const askedAgain = await wasAnsweredByDefault(bb.storage.kv as never, input.runId, input.taskId);
        const reason = askedAgain ? `verdict_block: question_unanswered: the writer asked again after the default answer. It asked: ${question}` : `needs_human: ${question}`;
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"skipped",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{reason:"needs_human"}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        // The parked question is a file in the task folder, not only attempt.reason: a person, the next session or a
        // reload sees what the writer waits for; a CHECKPOINT.md the writer left is kept with it (sma m_q_exec_ckpt).
        const parkedWorkspace = getAttempt(db, input.attemptId)?.workspace_path ?? input.config.writerWorkspacePath;
        if (parkedWorkspace) {
          await appendTaskQa(bb, { hostId:input.config.hostId, workspacePath:parkedWorkspace, taskId:input.taskId, question });
          const checkpoint = await host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:parkedWorkspace,
            relativePath:`.agents/plans/items/${input.taskId}/CHECKPOINT.md`, offset:0, maxLines:200 }, { hostId:input.config.hostId, timeoutMs:10_000 }).then((file) => file.content, () => null);
          if (checkpoint) await bestEffort(ctx.log, "writer questions record", recordTaskQuestions(bb.storage.kv, input.runId, input.taskId,
            { questions:[{ kind:"open", question }], checkpoint:checkpoint.slice(0, 2000), at:Date.now() }), undefined);
        }
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      const checked = await services.validateWriterResult({
        config:input.config, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
        attempt:countAttempts(db,input.runId,input.taskId), task:input.task, writerThreadId:input.writerThreadId, attemptId:input.attemptId,
        dirtBefore:input.dirtBefore,
      });
      if (checked.status !== "accepted") {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:checked.status}});
        const stopped = endedByStop(checked.reason ?? checked.status);
        if (stopped) return stopped;
        transitionAttempt(db, input.attemptId, checked.status, { reason:checked.reason, ...failureFieldsOf(checked) });
        return { ...checked, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      { const stopped = stoppedMeanwhile("validation"); if (stopped) return stopped; }
      let candidate = checked;
      let writerThreadId = input.writerThreadId;
      let review:"passed"|"not_required" = "not_required";
      const existingCritique = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === "code-critique");
      const storedLedger = repairLedgerFromResult(existingCritique?.result);
      let repairRound = storedLedger?.repairRound ?? 0;
      let previousFindings:ReturnType<typeof actionableFindings> = storedLedger?.findings?.length
        ? storedLedger.findings.filter((row) => row.severity === "blocking")
        : [];
      let lastArtifact = storedLedger?.artifactRevisionSha256 ?? "";
      let approvedArtifact = "";
      let frozenPolicy = storedLedger?.policy;
      const projectSettings = loadProjectSettings(db,input.projectId,getRunSettingsScopes(db,input.runId));
      // quality_mode (task, else project, else standard) switches the code critic off (quick) or on (full); in standard mode the task's
      // risk may switch it on (critic.code.default_for_risk, or the value the dispatch carried).
      const qualityMode = resolveQualityMode(input.task,projectSettings[QUALITY_MODE_SETTING]);
      const taskCriticDefault = await loadCriticCodeDefault(bb.storage.kv as never, input.taskId);
      const criticDefault = resolveCodeCriticDefault(projectSettings[CODE_CRITIC_DEFAULT_SETTING], taskCriticDefault);
      // Tests that existed on the base and that the writer changed: read once here, so the critic is switched on for them, and below for test_fit.
      const fitAttempt = getAttempt(db, input.attemptId);
      const basePathForTests = taskBasePath(db, input.runId, input.taskId);
      // ponytail: the first 400 lines only. A deletion past that line is missed; raise the cap if a real test file is longer.
      const readFit = (cwd:string | null | undefined, path:string) => cwd
        ? host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:cwd, relativePath:path, offset:0, maxLines:400 }, { hostId:input.config.hostId, timeoutMs:10_000 }).then((file) => file.content, () => null)
        : Promise.resolve(null);
      const editedTests = referenceTestEdits((candidate.produced ?? []).map((path) => ({ path, status:"M" }))).slice(0, 20);
      const editedScripts = checkScriptEdits(candidate.produced ?? [], input.task.verification.map((row) => row.command)).slice(0, 10);
      const fitConfigs = (candidate.produced ?? []).filter((path) => /(^|\/)package\.json$|\.(?:sh|ya?ml)$/.test(path)).slice(0, 10);
      // An attempt that worked in the project folder itself has no base copy: the «before» is git's, see headSides.
      const workedAt = fitAttempt?.workspace_path;
      const inPlace = !!workedAt && [basePathForTests, getRun(db, input.runId)?.writer_workspace_path].some((path) => !!path && resolve(path) === resolve(workedAt));
      const atHead = inPlace
        ? await headSides(bb, db, { runId:input.runId, taskId:input.taskId, hostId:input.config.hostId, cwd:workedAt, paths:[...new Set([...editedTests, ...editedScripts, ...fitConfigs])] })
        : new Map<string, string | null>();
      const readBefore = (path:string) => {
        const head = atHead.get(path);
        // Cut like readFit cuts the «after», or every assertion past its line 400 would read as removed.
        return head === undefined ? readFit(basePathForTests, path) : Promise.resolve(head === null ? null : head.split("\n").slice(0, 400).join("\n"));
      };
      const referenceBefore = new Map<string, string>();
      for (const path of editedTests) {
        const before = await readBefore(path);
        if (before !== null) referenceBefore.set(path, before);
      }
      const referenceTests = [...referenceBefore.keys()];
      const checkScripts: string[] = [];
      for (const path of editedScripts) {
        if (await readBefore(path) !== null) checkScripts.push(path);
      }
      const yardstick = [...referenceTests, ...checkScripts];
      const liveCritiquePolicy = frozenPolicy ?? parseCodeCritiqueSettings(withReferenceTestCritic(applyCodeCriticDefault(applyQualityMode(projectSettings,qualityMode),qualityMode,input.task.risk,criticDefault), yardstick));
      // Other tasks of this run whose code critique passed «approve»: the repeat skip below reads their freshness and owns_paths.
      const priorCriticApprovals = listStageReceipts(db, input.runId)
        .filter((row) => row.stageId === "code-critique" && row.taskId !== input.taskId)
        .map((row) => {
          const owns = (getTask(db, row.taskId)?.contract as { owns_paths?: unknown } | undefined)?.owns_paths;
          return { taskId:row.taskId, ownsPaths:Array.isArray(owns) ? owns as string[] : [], state:row.state,
            decision:(row.result as { decision?: unknown } | null)?.decision, updatedAt:row.updatedAt };
        });
      let repeatSkipChecked = false;
      const baselineHashes = Object.fromEntries(input.dirtBefore.map((row) => [row.path, row.sha256 || null]));
      let lastPatches: Record<string, string> | undefined;
      const captureEvidence = async () => {
        const dirt = await services.workspaceDirt(input.config, input.task.project_cwd, input.runId);
        const byPath = new Map((dirt.ok ? dirt.snapshots : []).map((row) => [row.path, row.sha256 || null]));
        const hashes = Object.fromEntries((candidate.produced ?? []).map((path) => [path, byPath.get(path) ?? null]));
        const files:Array<{ path:string; content:string|null|undefined }> = [];
        for (const path of candidate.produced ?? []) {
          let content: string | null | undefined;
          try {
            const file = await orMiss(bb.sdk.files.read({
              hostId:input.config.hostId, rootPath:input.task.project_cwd, path:resolve(input.task.project_cwd, path),
            }), null, isNotFound);
            content = typeof file?.content === "string" ? file.content : null;
          } catch (cause) {
            // One unreadable produced file is a named hold, not a silent pass; the rest still count.
            // undefined is the read-outage outcome, distinct from null (absent).
            ctx.log(`writer ${input.taskId}: the produced file ${path} could not be read (${cause instanceof Error ? cause.message : String(cause)}); its evidence is left out`);
            content = undefined;
          }
          files.push({ path, content });
        }
        lastPatches = await candidatePatches(bb, db, { runId:input.runId, taskId:input.taskId, hostId:input.config.hostId, cwd:input.task.project_cwd, paths:candidate.produced ?? [] });
        return buildCandidateEvidence({
          produced:candidate.produced ?? [],
          hashes,
          baselineHashes,
          files,
          patches:lastPatches,
          verification:(candidate.verification ?? []).map((row) => ({
            command:row.command, exitCode:row.exitCode,
            stdout:row.stdout, stderr:row.stderr,
          })),
          output:candidate.output,
          ownsPaths:input.task.owns_paths,
          neverTouch:input.task.never_touch,
          dirtOk:dirt.ok,
          dirtReason:dirt.ok ? undefined : dirt.reason,
          workspace:input.task.project_cwd,
          referenceTestEdits:yardstick,
        });
      };
      let criticNotes = "";
      const keepAdvisory = (row: { settings?: { mode?: string }; parsed?: Parameters<typeof advisoryFeedback>[0] } | undefined) => {
        if (row?.settings?.mode !== "advisory" || !row.parsed) return;
        const text = advisoryFeedback(row.parsed);
        if (text) criticNotes = text;
      };
      if (liveCritiquePolicy.enabled) {
      // What the barrier judged, kept with the attempt: the patches, the promise, the contract and the previous
      // verdict, plus the inputSha256 the stage receipt carries (sma av_inputs). Written in the attempt's
      // workspace (the same writer as persistPlan); a failed write never fails the finish.
      const archiveBarrierInput = async (state:"passed"|"blocked"|"skipped") => {
        // Beside the task's other receipts, in the run's bookkeeping folder: the attempt's own checkout stays clean.
        const workspace = input.task.project_cwd;
        if (!workspace) return;
        const receipt = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === "code-critique");
        const body = barrierInputBody({ state, inputSha256:receipt?.inputSha256 ?? null,
          diff:lastPatches ?? null, promise:input.task.promise ?? null, contract:input.task,
          priorVerdict:existingCritique?.result ?? null });
        await bestEffort(ctx.log, "barrier input archive", Promise.resolve().then(() => bb.sdk.files.write({ hostId:input.config.hostId, rootPath:workspace,
          path:`${acceptanceArtifactDir(workspace, input.runId, input.taskId)}/attempts/${input.attemptId}/barrier-input.json`,
          content:JSON.stringify(body, null, 2), contentEncoding:"utf8", createParents:true, expectedSha256:null })), undefined);
      };
      for (;;) {
        const evidence = await captureEvidence();
        // abide-style: the accepted writer rules against this diff, before the critic. A break is a remark on the
        // writer's repair turn, never a block; shadow (the default) only records what it would have said.
        const ruleRemark = ruleViolationRemark(await bestEffort(ctx.log, "writer rules on diff", judgeRulesOnDiff(jev(), db, input.projectId,
          Object.values(lastPatches ?? {}).join("\n"),
          { projectId:input.projectId, runId:input.runId, subject:input.taskId, settings:projectSettings },
          { kv: bb.storage.kv as never, target: input.taskId }), []));
        const ledger = repairLedgerFromResult(listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === "code-critique")?.result);
        if (ledger?.policy) frozenPolicy = ledger.policy;
        if (ledger?.repairRound) repairRound = Math.max(repairRound, ledger.repairRound);
        const disputes = repairRound > 0 ? parseWriterRepairReply(candidate.output) : null;
        if (disputes && disputes.replies.length > 0 && disputes.replies.every((row) => row.status === "disputed")) {
          const recritique = await runCodeCritique({
            stageHelperSettings: services.stageHelperSettings, bb, db, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            config:input.config, task:input.task, evidence, disputes, frozenPolicy, criticDefault:taskCriticDefault,
            workflow:pipelineWriterStep(db, input.runId, input.taskId) ?? undefined,
          });
          if (recritique.policy) frozenPolicy = recritique.policy;
          if (recritique.allowed) { keepAdvisory(recritique); review = recritique.review; approvedArtifact = evidence.artifactRevisionSha256; break; }
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason:recritique.reason},
            tree:evidence.artifactRevisionSha256,verdict:recritique.parsed?{status:String(recritique.parsed.status),summary:String(recritique.parsed.summary??"")}:null});
          transitionAttempt(db, input.attemptId, "blocked", { reason:recritique.reason });
          return { status:"blocked", reason:recritique.reason, attemptId:input.attemptId, writerThreadId };
        }
        const inflight = nextRepairAction({
          ledger, nextRound:Math.max(1, ledger?.repairRound ?? repairRound),
          attemptId:input.attemptId, artifactRevisionSha256:evidence.artifactRevisionSha256,
        });
        if (inflight === "unknown") {
          const reason = "code_critique_repair_unknown";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        if (inflight === "wait" && ledger?.repairThreadId) {
          writerThreadId = ledger.repairThreadId;
          repairRound = ledger.repairRound;
          lastArtifact = ledger.artifactRevisionSha256 || lastArtifact;
          await waitThreadIdle(bb,ledger.repairThreadId,"code_critique_repair_timeout",undefined,ledger.repairSentAt);
          candidate = await services.validateWriterResult({
            config:input.config, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            attempt:countAttempts(db,input.runId,input.taskId), task:input.task, writerThreadId:ledger.repairThreadId,
            attemptId:input.attemptId, dirtBefore:input.dirtBefore,
          });
          if (candidate.status !== "accepted") {
            recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
              attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:candidate.status}});
            const stopped = endedByStop(candidate.reason ?? candidate.status, writerThreadId);
            if (stopped) return stopped;
            transitionAttempt(db, input.attemptId, candidate.status, { reason:candidate.reason, ...failureFieldsOf(candidate) });
            return { ...candidate, attemptId:input.attemptId, writerThreadId };
          }
          recordStage(db, {
            runId:input.runId, taskId:input.taskId, stageId:"code-critique",
            state:"blocked",
            input:codeCritiqueSource({ evidence, task:input.task, agent:frozenPolicy?.agent ?? "code-critic" }),
            result:{ ...ledger, spawnAttempted:true, repairObserved:true, repairThreadId:ledger.repairThreadId, repairRound:ledger.repairRound },
            reason:"critique_changes_requested",
          });
          await archiveBarrierInput("blocked");
          continue;
        }
        if (lastArtifact && evidence.artifactRevisionSha256 === lastArtifact && repairRound > 0
          && !(disputes && disputes.replies.some((row) => row.status === "disputed"))) {
          const reason = "code_critique_revision_unchanged";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        // The same files a critic approved < 48 h ago and a small diff: skip the review, receipt says why (hub R10).
        // Only a task with no critique ledger of its own — a repair in flight always re-reviews — and only where a
        // skipped receipt is a legal stage move (no receipt yet, or a pending one a crash left behind).
        if (!repeatSkipChecked) {
          repeatSkipChecked = true;
          const patchMap = lastPatches ?? {};
          const producedPaths = candidate.produced ?? [];
          const skip = (!existingCritique || existingCritique.state === "pending") && !storedLedger && repairRound === 0
            && (!evidence.truncated || evidence.truncateReason === "packet_truncated")
            ? critiqueRepeatSkip({
                risk:input.task.risk, referenceTestEdits:yardstick,
                changedLines:producedPaths.length === 0 ? 0 : Object.keys(patchMap).length === 0 ? null : patchChangedLines(patchMap),
                ownsPaths:input.task.owns_paths, priorApprovals:priorCriticApprovals, now: Date.now(),
              })
            : null;
          if (skip) {
            recordStage(db, {
              runId:input.runId, taskId:input.taskId, stageId:"code-critique",
              state:"skipped",
              input:codeCritiqueSource({ evidence, task:input.task, agent:frozenPolicy?.agent ?? "code-critic" }),
              result:{ skipped:"repeat", priorTaskId:skip.priorTaskId, changedLines:patchChangedLines(patchMap) },
              reason:`repeat:${skip.priorTaskId}`,
            });
            await archiveBarrierInput("skipped");
            approvedArtifact = evidence.artifactRevisionSha256;
            break;
          }
        }
        const critique = await runCodeCritique({
          stageHelperSettings: services.stageHelperSettings, bb, db, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          config:input.config, task:input.task, evidence, frozenPolicy, criticDefault:taskCriticDefault,
          workflow:pipelineWriterStep(db, input.runId, input.taskId) ?? undefined,
        });
        if (critique.policy) frozenPolicy = critique.policy;
        if (critique.allowed) { await archiveBarrierInput("passed"); keepAdvisory(critique); review = critique.review; approvedArtifact = evidence.artifactRevisionSha256; break; }
        const parsed = critique.parsed;
        const critiqueSettings = frozenPolicy ? settingsFromFrozenPolicy(frozenPolicy) : critique.settings;
        if (!parsed || !critiqueSettings || !shouldRequestRepair({ settings:critiqueSettings, result:parsed, round:repairRound })) {
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason:critique.reason},
            tree:evidence.artifactRevisionSha256,verdict:parsed?{status:String(parsed.status),summary:String(parsed.summary??"")}:null});
          await archiveBarrierInput("blocked");
          transitionAttempt(db, input.attemptId, "blocked", { reason:critique.reason });
          return { status:"blocked", reason:critique.reason, attemptId:input.attemptId, writerThreadId };
        }
        const nextFindings = actionableFindings(parsed);
        if (previousFindings.length && sameUnresolvedFindings(previousFindings, nextFindings)) {
          const reason = "code_critique_repeated_finding";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        previousFindings = nextFindings;
        lastArtifact = evidence.artifactRevisionSha256;
        const nextRound = repairRound + 1;
        const spawnLedger = repairLedgerFromResult(critique.critique);
        const action = nextRepairAction({ ledger:spawnLedger, nextRound, attemptId:input.attemptId, artifactRevisionSha256:evidence.artifactRevisionSha256 });
        if (action === "unknown") {
          const reason = "code_critique_repair_unknown";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        const trace = getReasoningTrace(db, input.attemptId);
        const bound = getAttempt(db, input.attemptId);
        if (!trace || !bound) {
          const reason = "code_critique_writer_identity_unknown";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        const writerSnapshot:WriterIdentity = {
          attemptId:input.attemptId,
          providerId:trace.providerId,
          model:trace.model,
          reasoningLevel:trace.effectiveReasoningLevel,
          serviceTier:trace.serviceTier,
          environmentId:bound.environment_id,
          workspacePath:bound.workspace_path ?? input.task.project_cwd,
        };
        if (trace.attemptId !== input.attemptId || (spawnLedger?.writer && !sameWriterIdentity(spawnLedger.writer, writerSnapshot))) {
          const reason = "code_critique_writer_mismatch";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        const frozenFindings = spawnLedger?.findings?.length ? spawnLedger.findings : nextFindings;
        const frozenHash = spawnLedger?.findingsHash || findingsHash(frozenFindings);
        if (frozenHash !== findingsHash(nextFindings) && spawnLedger?.findingsHash) {
          const reason = "code_critique_findings_mutated";
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        let repairThreadId = action === "wait" ? spawnLedger?.repairThreadId : undefined;
        let repairSentAt = action === "wait" ? spawnLedger?.repairSentAt : undefined;
        const critiqueInput = codeCritiqueSource({ evidence, task:input.task, agent:critiqueSettings.agent });
        const ledgerBase = {
          ...parsed,
          artifactRevisionSha256:evidence.artifactRevisionSha256,
          evidenceSha256:evidence.evidenceSha256,
          revisionSha256:evidence.artifactRevisionSha256,
          findingsHash:frozenHash,
          findings:frozenFindings,
          repairRound:nextRound,
          writer:writerSnapshot,
          policy:frozenPolicy,
          reviewer:(critique.critique && typeof critique.critique === "object" && "reviewer" in critique.critique)
            ? (critique.critique as { reviewer?: unknown }).reviewer
            : undefined,
          mode:critiqueSettings.mode, autoFix:critiqueSettings.autoFix, maxRounds:critiqueSettings.maxRounds,
        };
        if (!repairThreadId) {
          recordStage(db, {
            runId:input.runId, taskId:input.taskId, stageId:"code-critique",
            state:"blocked", input:critiqueInput,
            result:{ ...ledgerBase, spawnAttempted:true },
            reason:critique.reason ?? "critique_changes_requested",
          });
          const dispatch = trace.dispatchContext;
          if (!dispatch) {
            const reason = "code_critique_dispatch_context_missing";
            recordStage(db, {
              runId:input.runId, taskId:input.taskId, stageId:"code-critique",
              state:"blocked", input:critiqueInput, result:{ ...ledgerBase, spawnAttempted:true }, reason,
            });
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
          }
          let helperPolicy:HelperPolicySnapshot;
          try {
            helperPolicy = requireHelperSpawn({ bb, db, projectId:input.projectId, runId:input.runId });
          } catch (cause) {
            const reason = `code_critique_helper_policy_missing:${cause instanceof Error ? cause.message : String(cause)}`;
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
          }
          if (helperPolicy.mode !== dispatch.helperMode || (helperPolicy.policy?.required === true) !== dispatch.helperRequired) {
            const reason = "code_critique_helper_policy_mismatch";
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
          }
          const repairPrompt = [ruleRemark, codeRepairPrompt({
            task:input.task, findings:frozenFindings, agent:dispatch.agent,
            setupLines:writerSetupLines(isLiveDecision(bound.workspace_decision)),
            contextBlocks:writerContextBlocks(input.task, dispatch.memoryText, dispatch.executionPacket, dispatch.pmReadContext, dispatch.rulesText ?? ""),
          })].filter(Boolean).join("\n\n");
          const environment = bound.environment_id
            ? { type:"reuse" as const, environmentId:bound.environment_id }
            : { type:"host" as const, hostId:input.config.hostId, workspace:{ type:"unmanaged" as const, path:writerSnapshot.workspacePath } };
          const placement = await helperChildPlacement({
            bb, db, projectId:input.projectId, runId:input.runId, role:"writer", taskTitle:input.task.title,
          });
          // The writer that wrote the code fixes the findings in its own thread, with its context; a new thread only
          // when that one is gone or busy.
          const writerIdle = stringAt(await orMiss(bb.sdk.threads.get({ threadId:writerThreadId }), null, isNotFound), "status") === "idle";
          if (writerIdle) {
            const sentAt = Date.now();
            recordStage(db, {
              runId:input.runId, taskId:input.taskId, stageId:"code-critique",
              state:"blocked", input:critiqueInput,
              result:{ ...ledgerBase, spawnAttempted:true, repairThreadId:writerThreadId, repairSentAt:sentAt },
              reason:critique.reason ?? "critique_changes_requested",
            });
            const sent = await Promise.resolve().then(() => sendServiceMessage(bb, { threadId:writerThreadId, text:repairPrompt, senderThreadId:input.pmThreadId })).then(() => true, () => false);
            if (sent) { repairThreadId = writerThreadId; repairSentAt = sentAt; }
          }
          let spawned: unknown;
          if (!repairThreadId) try {
            spawned = await fullAccessSpawn(bb, {
              ...placement,
              ...requiredPolicyField(bb, helperPolicy, writerSnapshot.providerId, "code-repair", { skills:recordedWriterSkills(dispatch) }),
              ...writerExecutionSelection(
                writerSnapshot.providerId,
                writerSnapshot.model,
                writerSnapshot.reasoningLevel,
                writerSnapshot.serviceTier,
              ),
              prompt:repairPrompt,
              environment,
              pluginMetadata:{
                role:"writer", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
                attemptId:input.attemptId, repairRound:nextRound,
                revisionSha256:evidence.revisionSha256, findingsHash:frozenHash, stageId:"writer-agent",
                writer:writerSnapshot,
                ...pipelineWriterTag(db, input.runId, input.taskId),
              },
            });
          } catch {
            const reason = "code_critique_repair_unknown";
            recordStage(db, {
              runId:input.runId, taskId:input.taskId, stageId:"code-critique",
              state:"blocked", input:critiqueInput,
              result:{ ...ledgerBase, spawnAttempted:true },
              reason,
            });
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
          }
          if (!repairThreadId) repairThreadId = stringAt(spawned, "id") ?? undefined;
          if (!repairThreadId) {
            const reason = "code_critique_repair_unknown";
            recordStage(db, {
              runId:input.runId, taskId:input.taskId, stageId:"code-critique",
              state:"blocked", input:critiqueInput,
              result:{ ...ledgerBase, spawnAttempted:true },
              reason,
            });
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
          }
          recordStage(db, {
            runId:input.runId, taskId:input.taskId, stageId:"code-critique",
            state:"blocked", input:critiqueInput,
            result:{ ...ledgerBase, spawnAttempted:true, repairThreadId, ...(repairSentAt ? { repairSentAt } : {}) },
            reason:critique.reason ?? "critique_changes_requested",
          });
        }
        writerThreadId = repairThreadId;
        repairRound = nextRound;
        await waitThreadIdle(bb,repairThreadId,"code_critique_repair_timeout",undefined,repairSentAt);
        candidate = await services.validateWriterResult({
          config:input.config, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          attempt:countAttempts(db,input.runId,input.taskId), task:input.task, writerThreadId:repairThreadId,
          attemptId:input.attemptId, dirtBefore:input.dirtBefore,
        });
        if (candidate.status !== "accepted") {
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:candidate.status}});
          const stopped = endedByStop(candidate.reason ?? candidate.status, writerThreadId);
          if (stopped) return stopped;
          transitionAttempt(db, input.attemptId, candidate.status, { reason:candidate.reason, ...failureFieldsOf(candidate) });
          return { ...candidate, attemptId:input.attemptId, writerThreadId };
        }
        recordStage(db, {
          runId:input.runId, taskId:input.taskId, stageId:"code-critique",
          state:"blocked", input:critiqueInput,
          result:{ ...ledgerBase, spawnAttempted:true, repairObserved:true, repairThreadId, repairRound:nextRound, ...(repairSentAt ? { repairSentAt } : {}) },
          reason:critique.reason ?? "critique_changes_requested",
        });
        continue;
      }
      const confirm = await captureEvidence();
      // A packet the critic could not read is a skipped receipt (runCodeCritique) and does not stop the writer.
      // A revision that moved after the critique still does.
      if (!confirm.truncated && (!approvedArtifact || confirm.artifactRevisionSha256 !== approvedArtifact)) {
        const reason = "code_critique_stale_revision";
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
      }
      }
      { const stopped = stoppedMeanwhile("the code critique", writerThreadId); if (stopped) return stopped; }
      // The plan against the fact: code checks the writer's evidence per acceptance item against the diff, never its prose. It records
      // its stage whatever the outcome; only plan_fact.mode=gate sends an item with no evidence that holds back to the writer.
      const planFact = await runPlanFactStage(ctx, { projectId:input.projectId, runId:input.runId, taskId:input.taskId, attempt:countAttempts(db,input.runId,input.taskId),
        hostId:input.config.hostId, task:input.task, answers:[candidate.output, answer], produced:candidate.produced ?? [], verification:candidate.verification ?? [] })
        .catch((cause:unknown) => { ctx.log(`plan-fact: ${input.taskId} could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (planFact?.refusal) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"plan_fact_unproven",reason:planFact.refusal}});
        const stopped = endedByStop(planFact.refusal, writerThreadId);
        if (stopped) return stopped;
        transitionAttempt(db, input.attemptId, "validation_failed", { reason:planFact.refusal });
        return { status:"validation_failed", reason:planFact.refusal, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
      }
      // Approach and lesson markers warn. A weakened test (test_fit) blocks acceptance; any other edit of a test that already existed stays a warning.
      const markers = writerMarkers(`${candidate.output ?? ""}\n${answer}`);
      const testEdits = referenceTests;
      const fitFiles: Array<{ path:string; before:string | null; after:string | null }> = [];
      for (const [path, before] of referenceBefore) fitFiles.push({ path, before, after: await readFit(fitAttempt?.workspace_path, path) });
      for (const path of fitConfigs) {
        fitFiles.push({ path, before: await readBefore(path), after: await readFit(fitAttempt?.workspace_path, path) });
      }
      const fitHits = testFitFindings(fitFiles, input.task.test_removals ?? []);
      // A hit a person already allowed for this very content passes; the rest holds the hand-in without burning the
      // attempt (sma av_test_edit_hold): blocked, worktree kept, the PM told, until that exact edit is allowed.
      const afterShaOf = (path:string) => sha256Hex(fitFiles.find((file) => file.path === path)?.after ?? "missing");
      const allowance = fitHits.length ? await testEditAllowance(bb.storage.kv as never, input.attemptId) : [];
      const heldHits = fitHits.filter((hit) => !allowance.some((row) => row.path === hit.path && row.afterSha256 === afterShaOf(hit.path)));
      if (heldHits.length) {
        const paths = heldHits.slice(0, 5).map((hit) => hit.path);
        const reason = `test_edit_hold: ${paths.join(", ")} (weakened reference tests wait for a person's allow of that exact edit: lane_pilot_update_task {taskId, allowTestEdits:true}; a removal that is the task goes into the contract's test_removals)`.slice(0, 500);
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"test_edit_hold",reason}});
        await bestEffort(ctx.log, "test edit hold record", bb.storage.kv.set(testEditHoldKey(input.attemptId),
          heldHits.map((hit) => ({ path:hit.path, afterSha256:afterShaOf(hit.path) })) as never), undefined);
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        const ownerWords = landingWordAsked(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)), input.task.risk);
        if (ownerWords) postOwnerItem(db as never, { key:`test-edit-hold:${input.attemptId}`, source:"writer", kind:"task_word", projectId:input.projectId, wake:false,
          what:`Писатель ослабил эталонный тест (${paths.join(", ")}) — сдача ждёт вашего разрешения`, why:reason.slice(0, 600) });
        await bestEffort(ctx.log, "test edit hold notice", sendServiceMessage(bb, { threadId:input.pmThreadId,
          text:`Lane Pilot: task ${input.taskId} weakened reference tests (${paths.join(", ")}) and its hand-in waits. Allow that exact edit with lane_pilot_update_task {taskId:"${input.taskId}", allowTestEdits:true}, or redispatch with the files in test_removals if removing them is the task.` }), undefined);
        return { status:"blocked", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
      }
      const markerWarnings = [
        ...(!markers.approach ? ["the report has no APPROACH line"] : []),
        ...(!markers.lesson && !markers.noLessonReason ? ["the report has no LESSON line (a lesson, or none with the reason)"] : []),
        ...(testEdits.length ? [`the writer changed tests that existed before the attempt (reference tests): ${testEdits.join(", ")} — the code critic reviews them in gate mode`] : []),
      ];
      if (criticNotes) {
        markerWarnings.push(criticNotes);
        void bestEffort(ctx.log, "writer critic notes notice", sendServiceMessage(bb, { threadId: writerThreadId, senderThreadId: input.pmThreadId, text: criticNotes }), undefined);
      }
      // The execution checklist, one row on the attempt (sma ag_checklist): the promise flags, the stagnation
      // (prior turns that ended on the same failure key), the scope reads and the reference-test edits, together —
      // they ride the attempt's one accept row (recorded at the acceptance below), so the gate list shows them in one place.
      const checklist = executionChecklist({ markers, planFact,
        priorReasons: priorAttemptStates(db, input.runId, input.taskId, input.attemptId).map((row) => row.reason).filter((r): r is string => typeof r === "string"),
        produced: candidate.produced ?? [], ownsPaths: input.task.owns_paths ?? [], referenceTestEdits: testEdits });
      // The diagnostic progress journal beside QA.md (sma k_lib_workerprog): files touched and commands run,
      // every cut marked. Kept in the run's bookkeeping folder beside the task's receipts, never in the attempt's checkout.
      {
        const journalWorkspace = input.task.project_cwd;
        if (journalWorkspace) {
          const journalEvents = await bestEffort(ctx.log, "progress journal events", Promise.resolve().then(() => listThreadEventsRaw(bb, { threadId: input.writerThreadId, order: "asc", limit: "500" } as never)), null);
          await bestEffort(ctx.log, "progress journal write", Promise.resolve().then(() => bb.sdk.files.write({ hostId:input.config.hostId, rootPath:journalWorkspace,
            path:`${acceptanceArtifactDir(journalWorkspace, input.runId, input.taskId)}/PROGRESS.md`,
            content:progressJournal({ attemptId: input.attemptId, taskId: input.taskId, produced: candidate.produced ?? [], events: (journalEvents as { events?: Array<Record<string, unknown>> } | null)?.events ?? [] }),
            contentEncoding:"utf8", createParents:true, expectedSha256:null })), undefined);
        }
      }
      if (markerWarnings.length) candidate.warnings = [...(candidate.warnings ?? []), ...markerWarnings];
      // The approach note the window's task screen shows (the gate keeps only the hash of its summary).
      await bestEffort(ctx.log, "writer approach record", recordTaskApproach(bb.storage.kv, input.runId, input.taskId, { approach:markers.approach, lesson:markers.lesson, noLessonReason:markers.noLessonReason, referenceTestEdits:testEdits, at:Date.now() }), undefined);
      // Stage questions from files and the execution checkpoint: the task folder's QUESTIONS.md and CHECKPOINT.md, read from the attempt's copy.
      const attemptRow = fitAttempt;
      const folderOf = (name:string) => `.agents/plans/items/${input.taskId}/${name}`;
      const readTaskFile = async (name:string) => attemptRow?.workspace_path ? await host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:attemptRow.workspace_path, relativePath:folderOf(name), offset:0, maxLines:200 }, { hostId:input.config.hostId, timeoutMs:10_000 }).then((file) => file.content, () => null) : null;
      const questionsText = await readTaskFile("QUESTIONS.md");
      const checkpoint = await readTaskFile("CHECKPOINT.md");
      const fileQuestions = questionsText ? questionsFromFile(questionsText) : [];
      if (fileQuestions.length || checkpoint) {
        await bestEffort(ctx.log, "writer questions record", recordTaskQuestions(bb.storage.kv, input.runId, input.taskId, { questions:fileQuestions, checkpoint:checkpoint?.slice(0, 2000) ?? null, at:Date.now() }), undefined);
        if (fileQuestions.length) candidate.warnings = [...(candidate.warnings ?? []), `the writer left ${fileQuestions.length} question(s) in QUESTIONS.md: ${fileQuestions.map((row) => `[${row.kind}] ${row.question}`).join("; ").slice(0, 600)}`];
      }
      // Drawing unchanged: the drawing a task follows is its input, not its output; a writer that edited it changed the yardstick.
      const drawingTouched = (input.task.drawing ?? []).filter((path) => (candidate.produced ?? []).some((changed) => changed.replace(/^\.\//, "") === path.replace(/^\.\//, "")));
      if (drawingTouched.length) {
        const reason = `drawing_changed: the task follows the drawing ${drawingTouched.join(", ")} and must not change it; undo those edits (the drawing is changed in the phase's design stage)`;
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"drawing_changed",reason}});
        transitionAttempt(db, input.attemptId, "validation_failed", { reason });
        return { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
      }
      // A model's opinion alone never accepts a task: some stage decided by code (the ownership and output gates, the checks)
      // must have passed for this candidate. The code critic's «passed» is advisory (STAGE_PROOF).
      const provenBy:StageId[] = [];
      if (candidate.status === "accepted") provenBy.push("writer-agent");
      const checks = candidate.verification ?? [];
      if (checks.length > 0 && checks.every((row) => row.exitCode === 0)) provenBy.push("verification");
      if (review === "passed") provenBy.push("code-critique");
      // Challenge gate (SMA): with critic.challenge_high on, a task of high or critical risk is accepted only after the code critic passed it.
      const challengeOn = String(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId))["critic.challenge_high"] ?? "off") === "on";
      if (challengeOn && (input.task.risk === "high" || input.task.risk === "critical") && review !== "passed") {
        const reason = `challenge_gate: a ${input.task.risk}-risk task needs the code critic's pass before acceptance (critic.challenge_high is on); the critic ${review ?? "did not run"}`;
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"challenge_gate",reason}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
      }
      const proofGap = acceptanceProofGap(provenBy);
      if (proofGap) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"no_code_proof",reason:proofGap}});
        transitionAttempt(db, input.attemptId, "blocked", { reason:proofGap });
        return { status:"blocked", reason:proofGap, attemptId:input.attemptId, writerThreadId };
      }
      // The owner's word before landing (SMA: Approving, Authorized by a person): with owner.words on, a verified task waits here,
      // in place and with its worktree, for the owner's yes the PM records (lane_pilot_queue word); a no or six silent hours block it.
      // On owner.words=risky (the default) only a task of risk high waits; a low or medium one lands by itself.
      const ownerWords = landingWordAsked(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)), input.task.risk);
      const wordsOf = async () => ((await bb.storage.kv.get(TASK_WORDS_KEY)) as Record<string, TaskWord[]> | null)?.[taskWordKey(input.runId, taskFamily(input.taskId))];
      { const stopped = stoppedMeanwhile("the plan-fact check", writerThreadId); if (stopped) return stopped; }
      let wordGap = landingWordGap(ownerWords, await wordsOf());
      if (wordGap && !wordGap.includes("said no")) {
        // The lead's journal: the question opens here and the prediction is written before the owner answers (src/rooms/lead).
        void services.taskWords.ask(db, { runId:input.runId, projectId:input.projectId, family:taskFamily(input.taskId), task:input.task }, loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)) as JevSettings);
        // The wait is a row on «Ждут владельца» with да / нет (Astra F-004, Gemini F-008: the screen that promises to show what waits did not
        // show this); the word closes it (answerTaskWord), the end of the wait below closes it too.
        try {
          const wordInput = (decision:"yes"|"no") => ({ runId:input.runId, taskId:input.taskId, decision, text: decision === "yes" ? "Да, сливайте" : "Нет, не сливать" });
          postOwnerItem(db as never, { key:`${taskWordItemPrefix(input.runId, taskFamily(input.taskId))}${input.attemptId}`, source:"writer", kind:"task_word", projectId:input.projectId, wake:false,
            what:`Задача проверена и ждёт вашего слова перед слиянием: ${input.task.title}`,
            why:`Риск задачи ${input.task.risk}: по вашему правилу такая работа не сливается без вашего «да». Без ответа за ${Math.round(OWNER_WORD_WAIT_MS / 3_600_000)} часов она остановится, и её можно будет отправить снова.`,
            evidence:[{ kind:"attempt", ref:input.attemptId }, { kind:"task", ref:input.taskId }],
            actions:[{ id:"yes", label:"Да, сливать", cli:rpcLine("task_word", wordInput("yes")), rpc:{ method:"task_word", input:wordInput("yes") } },
              { id:"no", label:"Нет", cli:rpcLine("task_word", wordInput("no")), rpc:{ method:"task_word", input:wordInput("no") } }] });
        } catch { /* the list is a mirror; the wait itself goes on */ }
        void bestEffort(ctx.log, "writer owner word notice", sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:writerThreadId,
          text:`Lane Pilot: task ${input.taskId} passed its checks and waits for the owner's word before it lands on main (owner.words asks it for this task: risk ${input.task.risk}). Ask him with lane_pilot_ask_owner, then record his answer with lane_pilot_queue {action:"word", taskId:"${input.taskId}", decision:"yes"|"no", text}. It waits up to 6 hours; no need to resend it.` }), undefined);
        // Up to six hours of waiting held a writer seat of the pool for nothing (Gemini F-008.2): the seat goes back now; `admitted` and the
        // live key stay, they protect the task's files until the word lands or the wait ends.
        input.releaseSlot?.();
        const since = Date.now();
        while (wordGap && !wordGap.includes("said no") && Date.now() - since < OWNER_WORD_WAIT_MS && !ctx.isDisposed()) {
          await new Promise((wake) => setTimeout(wake, 60_000));
          const stopped = stoppedMeanwhile("the owner's word", writerThreadId);
          if (stopped) { closeOwnerItemsByPrefix(db as never, taskWordItemPrefix(input.runId, taskFamily(input.taskId)), "stopped"); return stopped; }
          wordGap = landingWordGap(ownerWords, await wordsOf());
        }
        closeOwnerItemsByPrefix(db as never, taskWordItemPrefix(input.runId, taskFamily(input.taskId)), wordGap ? "wait over" : "answered");
      }
      if (wordGap) {
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"owner_word",reason:wordGap}});
        transitionAttempt(db, input.attemptId, "blocked", { reason:wordGap });
        return { status:"blocked", reason:wordGap, attemptId:input.attemptId, writerThreadId };
      }
      // The parallel finish scan (Gemini 7): three cheap nouls on the landing attempt — diff risk, UI, docs — for
      // receipts and the task's profile; it never changes the finish path. Awaited here: a stop during the scan
      // still cancels the merge below (stoppedMeanwhile at the next boundary).
      try {
        const scan = await jev()?.judge(writerFinishScanJudgment, {
          title: input.task.title, contract: JSON.stringify({ invariants: input.task.invariants, out_of_scope: input.task.out_of_scope }),
          produced: (candidate.produced ?? []).slice(0, 40).join("\n"),
          verification: (candidate.verification ?? []).slice(0, 10).map((row) => `${row.command}:${row.exitCode}`).join("\n"),
          summary: typeof candidate.output === "string" ? candidate.output : "",
        }, { projectId: input.projectId, runId: input.runId, subject: "writer-finish", settings: loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)) as JevSettings });
        if (scan?.by === "jev") bb.log.info(`Lane Pilot finish-scan ${input.taskId}: ${writerFinishScanJudgment.describe(scan.decision)}`);
      } catch { /* a scan is never a gate */ }
      { const stopped = stoppedMeanwhile("the finish scan", writerThreadId); if (stopped) return stopped; }
      const receipt = await services.persistWriterAcceptance({
        config:input.config, task:input.task, runId:input.runId, taskId:input.taskId,
        attempt:countAttempts(db, input.runId, input.taskId), attemptId:input.attemptId,
        pmThreadId:input.pmThreadId, writerThreadId, output:candidate.output, verification:candidate.verification,
        emergencyFallback:input.emergencyFallback, review,
        warnings:candidate.warnings, turns:countThreadTurns(db, input.runId, input.taskId, input.writerThreadId),
      });
      // Work in the attempt's own worktree counts only once it is in the run's base checkout (main).
      // A conflict fails the attempt, so the retry redoes the task on a fresh worktree of the new main.
      const bound = getAttempt(db, input.attemptId);
      // The task's own checkout: the run's folder, or the repository inside it the task works in (its main is the merge target).
      const basePath = taskBasePath(db, input.runId, input.taskId);
      let integration: { status:string; commit:string|null; conflicts:string[]; rebased?:boolean } | null = null;
      if (bound?.workspace_path && basePath && shouldMergeAttemptWorktree(bound.workspace_path, basePath)) {
        const checkSettings = loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId));
        const replayChecks = input.task.verification.some((command) => !command.secrets?.length) ? {
          workspacePath:input.task.project_cwd,
          backend:(checkSettings["sandbox.backend"] as "auto" | "macos-seatbelt" | "linux-bubblewrap" | undefined) ?? "auto",
          // A check with secrets cannot run on the host's replay (it has no Env Catalog); the post-merge check on main still runs it.
          // The same limit as the writer's own check: its history widens it (a replay at a raw 120 s killed checks the attempt had passed).
          commands:input.task.verification.filter((command) => !command.secrets?.length).slice(0, 20).map((command) => ({ command:command.command, cwd:command.cwd, timeoutSec:checkTimeoutSec(db, input.projectId, { command:command.command, cwd:command.cwd, root:input.task.project_cwd }, command.timeout_sec ?? 120) })),
        } : null;
        const replayMs = (replayChecks?.commands ?? []).reduce((sum, command) => sum + 2 * command.timeoutSec * 1000, 0);
        // The merge is acceptance too: the attempt stays «running» with its writer idle while it queues behind another task's
        // merge or replays its checks on a moved main, which the watcher reads like a check in flight (self-repair.ts).
        // Vampirism Fire 2026-10-25: vf-s7-cosmetics and vf-s7-cosmetics.2 were reported «stuck» 47–63 minutes, each in its
        // 7–18 minute replay of studio_test after green checks.
        const mergePool = `merge:${basePath}`;
        endMerge = beginChecks(input.writerThreadId, mergePool);
        const integrate = () => (checksMoved(mergePool), host.call("gitIntegrate", {
          requestedHostId:input.config.hostId, basePath, worktreePath:bound.workspace_path!,
          message:attemptMergeMessage(input.task, input.attemptId),
          // Only Lane Pilot's own worktree (no BB environment) is removed; a BB managed one belongs to BB. An area task
          // keeps it for the area's next task (the attempt-worktree sweep removes it after the sticky window).
          removeWorktree:bound.environment_id === null && !(input.task.area && areaHasLiveWork(db, input)),
          bookkeeping:bookkeepingSetting(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId))),
          ownsPaths:input.task.owns_paths.slice(0, 200),
          // When main moved and the attempt is replayed on it, the host runs these checks in the worktree before the merge.
          ...(replayChecks ? { replayChecks } : {}),
        }, { hostId:input.config.hostId, timeoutMs:180_000 + replayMs }).finally(() => checksMoved(mergePool)));
        // Written before the merge: a reply lost to a reload leaves main updated and this attempt «running»; the recovery
        // asks the machine's repository whether the work landed (merge-intent.ts). Dropped once the attempt's state caught up.
        await recordMergeIntent(bb.storage.kv as never, (hostId, cwd, command) => runOnHost(host, { hostId, cwd, command, timeoutSec: 30 }),
          { attemptId:input.attemptId, runId:input.runId, taskId:input.taskId, projectId:input.projectId, hostId:input.config.hostId,
            basePath, worktreePath:bound.workspace_path, message:attemptMergeMessage(input.task, input.attemptId) });
        const settleIntent = () => clearMergeIntent(bb.storage.kv as never, input.attemptId);
        // Another task merging into the same checkout is a queue, not a failure: wait for it and try again.
        let merged = await integrate();
        const queuedSince = Date.now();
        while (merged.status === "busy" && Date.now() - queuedSince < MERGE_QUEUE_MS && !ctx.isDisposed()) {
          await new Promise((wake) => setTimeout(wake, 20_000));
          merged = await integrate();
        }
        if (merged.status === "busy") {
          const blockedBy = mergeHolder(input.runId, merged.holder ?? null, queuedSince);
          const reason = `merge_queue_timeout: ${merged.reason ?? "another integration holds the base checkout"}`;
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"failed",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged,blockedBy}});
          await saveBlockedBy(bb.storage.kv, input.attemptId, blockedBy);
          // The PM is woken when the holder settles, or in 10 minutes, without the owner.
          await relayFor(ctx).remind({ projectId:input.projectId, threadId:input.pmThreadId, inMinutes:10, watchThreadId:blockedBy.holderThreadId,
            note:`Lane Pilot: task ${input.taskId} waited 15 minutes for merge: main checkout is held by ${blockedBy.holderTaskId ?? "another task"}. Writer's work is committed in its worktree; send the task again once the holder is free.` })
            .catch((cause) => ctx.log(`merge-block reminder failed: ${cause instanceof Error ? cause.message : String(cause)}`));
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          await settleIntent();
          return { status:"blocked", reason, blockedBy, attemptId:input.attemptId, writerThreadId };
        }
        // Someone's uncommitted edits in main block the merge: a redo would meet the same edits, so the finished work
        // waits for main to be clean and merges then (content-factory 2026-10-05: one task was rewritten three times).
        if (dirtyBase(merged)) {
          const files = merged.conflicts.join(", ");
          ctx.log(`writer ${input.taskId} waits for uncommitted edits in ${basePath} to be committed: ${files}`);
          // The chats that work in this folder are asked by name; the PM hears who was asked, or that nobody is known.
          const asked = await bestEffort(ctx.log, "writer guests commit ask", askGuestsToCommit(bb, basePath, merged.conflicts, input.taskId, input.pmThreadId), [] as string[]);
          void bestEffort(ctx.log, "writer guests notice", sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:writerThreadId,
            text:asked.length
              ? `Lane Pilot: task ${input.taskId} is ready, but main checkout ${basePath} has uncommitted changes in the same files: ${files}. Lane Pilot asked threads working in this folder to commit them: ${asked.map((thread) => `@thread:${thread}`).join(", ")}. The task will merge automatically once files are committed (waits up to 2 hours); no need to resend it.`
              : `Lane Pilot: task ${input.taskId} is ready, but main checkout ${basePath} has uncommitted changes in the same files: ${files}. Lane Pilot does not know whose chat it is: ask the owner to commit or put them away (or do it yourself if this chat made them). The task will merge automatically once the directory is clean (waits up to 2 hours); no need to resend it.` }), undefined);
          const since = Date.now();
          // Another task's merge may hold the checkout meanwhile: that is a wait too, never an acceptance without a merge.
          while ((dirtyBase(merged) || merged.status === "busy") && Date.now() - since < DIRTY_BASE_WAIT_MS && !ctx.isDisposed()) {
            await new Promise((wake) => setTimeout(wake, 60_000));
            merged = await integrate();
          }
          if (dirtyBase(merged) || merged.status === "busy") {
            const reason = `merge_blocked: base checkout has uncommitted changes in files this task changes: ${merged.conflicts.join(", ") || files}`;
            const blockedBy:BlockedBy = { kind:"human", holderTaskId:null, holderThreadId:null, holderAttemptId:null,
              since:new Date(since).toISOString(), retryAfterSec:600, detail:merged.conflicts.join(", ") };
            await saveBlockedBy(bb.storage.kv, input.attemptId, blockedBy);
            recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"failed",
              attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged,blockedBy}});
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            await settleIntent();
            return { status:"blocked", reason, blockedBy, attemptId:input.attemptId, writerThreadId };
          }
        }
        if (merged.status === "conflict" || merged.status === "failed") {
          // The task's checks went red on the attempt replayed on the new main: a free redo by the same writer, with their output.
          const replayRed = merged.status === "conflict" && Boolean(merged.reason?.startsWith(REPLAY_CHECK_FAILED));
          const reason = merged.status === "conflict"
            ? `merge_conflict: ${merged.reason?.startsWith("base checkout") ? merged.reason : "main changed since this attempt started"}: ${replayRed ? merged.reason : merged.conflicts.join(", ")}`
            : `merge_failed: ${merged.reason ?? "unknown"}`;
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged}});
          const stopped = endedByStop(reason, writerThreadId);
          if (!stopped) transitionAttempt(db, input.attemptId, "validation_failed", { reason, ...failureFieldsOf(merged) });
          await settleIntent();
          if (stopped) return stopped;
          return { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:replayRed && merged.checks?.length ? merged.checks : candidate.verification,
            attemptId:input.attemptId, writerThreadId };
        }
        integration = { status:merged.status, commit:merged.commit, conflicts:[], ...(merged.rebased ? { rebased:true } : {}) };
        // The base, the merge commit and the files it changed (deletions included) go on the attempt's record (SMA wall 4).
        services.rollback?.noteMerge(input.attemptId, merged);
        if (merged.status === "merged") {
          // The landed reactions run now, fire-and-forget as before: the merge intent is cleared below, and a
          // reload between merge and this launch leaves the intent for recovery to redo.
          verification.landed(input, basePath, merged.commit, candidate.produced ?? [], false, bound.workspace_path,
            (candidate.verification ?? []).filter((check) => check.exitCode === 0).map((check) => check.command));
        }
      } else if (bound && basePath && isLiveDecision(bound.workspace_decision)) {
        // A folder with no repository has no merge: the accepted task is in place, and the gate runs there once the queue drains.
        verification.landed(input, basePath, null, candidate.produced ?? [], true, null, undefined);
      }
      // #29 task-size metric: what this accepted task cost (files, diff lines, minutes, attempts) rides the receipt;
      // the project's median over these rows is what plan warnings measure new slices against.
      let sizeLines = 0;
      if (integration?.commit) {
        const stat = await bestEffort(ctx.log, "writer task size probe", runOnHost(host, { hostId:input.config.hostId, cwd:basePath!, command:`git diff --shortstat ${integration.commit}^ ${integration.commit}`, timeoutSec:15, timeoutMs:15_000 }), null);
        if (stat && stat.exitCode === 0) for (const m of stat.stdout.matchAll(/(\d+) insertions?|(\d+) deletions?/g)) sizeLines += Number(m[1] ?? m[2] ?? 0);
      }
      const firstAttempt = firstAttemptAt(db, input.taskId);
      const size = taskSizeOf({ files:(candidate.produced ?? []).length, lines:sizeLines, createdAt:firstAttempt, finishedAt:Date.now(), attempts:countAttempts(db,input.runId,input.taskId) });
      recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"passed",
        attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{acceptanceReceiptPersisted:true,integration,size,execution_checklist:checklist}});
      transitionAttempt(db, input.attemptId, "accepted");
      if (integration) await clearMergeIntent(bb.storage.kv as never, input.attemptId);
      return { ...receipt, verification:candidate.verification, produced:candidate.produced };
    } catch (cause) {
      const thread = await getThreadBounded(input.writerThreadId);
      if (stringAt(thread, "status") === "error") {
        return providerFailed(cause instanceof Error ? cause.message : String(cause));
      }
      throw cause;
    } finally { endMerge(); }
  }

  return { finishWriterAttempt, ...verification };
}

export type WriterFinishApi = ReturnType<typeof createWriterFinish>;

const BARRIER_DIFF_CAP = 200_000;
/** What the barrier judged, archived per attempt (sma av_inputs): diff, promise, contract, the previous verdict and the receipt hash. */
export function barrierInputBody(input: { state: "passed" | "blocked" | "skipped"; inputSha256: string | null; diff: unknown; promise: unknown; contract: unknown; priorVerdict: unknown }): Record<string, unknown> {
  // A patch over the cap is cut and says so: the inputSha256 still names exactly what was judged.
  const text = input.diff == null ? null : typeof input.diff === "string" ? input.diff : JSON.stringify(input.diff);
  const diff = text !== null && text.length > BARRIER_DIFF_CAP ? `${text.slice(0, BARRIER_DIFF_CAP)} [cut: ${text.length - BARRIER_DIFF_CAP} chars]` : input.diff ?? null;
  return { stage: "code-critique", state: input.state, inputSha256: input.inputSha256, diff,
    promise: input.promise ?? null, contract: input.contract ?? null, priorVerdict: input.priorVerdict ?? null };
}

/** The attempt's execution checklist, all flags in one object (sma ag_checklist). */
export function executionChecklist(input: {
  markers: { approach: string | null; lesson: string | null; noLessonReason: string | null };
  planFact: { check?: { items?: Array<{ item?: unknown; evidence?: unknown }> } | null } | null;
  priorReasons: string[]; produced: string[]; ownsPaths: string[]; referenceTestEdits: string[];
}): Record<string, unknown> {
  const lastReason = input.priorReasons[input.priorReasons.length - 1] ?? null;
  const stagnant = lastReason !== null && input.priorReasons.length > 1
    && failureFingerprint(input.priorReasons[input.priorReasons.length - 2]) === failureFingerprint(lastReason);
  return {
    promise: { approach: input.markers.approach !== null, lesson: input.markers.lesson ?? null, noLessonReason: input.markers.noLessonReason ?? null,
      planFactUnproven: (input.planFact?.check?.items ?? []).filter((item) => !item.evidence).map((item) => String(item.item)).slice(0, 20) },
    stagnation: { sameKeyTurns: stagnant, lastFailureReason: lastReason?.slice(0, 300) ?? null },
    scope: { outsideOwnsPaths: input.produced.filter((path) => !fileAllowedByOwns(path, input.ownsPaths)).slice(0, 50) },
    referenceTestEdits: input.referenceTestEdits,
  };
}
