import { appetiteStop, breakerKey, runningWriterBudgetStop, tokenUsageFromEvent } from "@lane-pilot/resilience";
import { checkTimeoutSec } from "../check-timing";
import { pipelineWriterStep, pipelineWriterTag } from "./pipeline-tag";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { countAttempts, countThreadTurns, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getTaskPlan, listOpenAttempts, listStageReceipts, loadProjectSettings, transitionAttempt, taskBasePath } from "../../storage";
import { saveBlockedBy, type BlockedBy } from "../../runs/server";
import { relayFor } from "../../relay/server";
import type { HelperPolicySnapshot } from "../../native-agent";
import { writerExecutionSelection } from "@lane-pilot/models";
import { actionableFindings, advisoryFeedback, buildCandidateEvidence, codeCritiqueSource, codeRepairPrompt, findingsHash, nextRepairAction, parseCodeCritiqueSettings, parseWriterRepairReply, repairLedgerFromResult, sameUnresolvedFindings, sameWriterIdentity, settingsFromFrozenPolicy, shouldRequestRepair } from "../../critique";
import type { WriterIdentity } from "../../critique";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, resolveCodeCriticDefault, resolveQualityMode } from "../../critique";
import { loadCriticCodeDefault } from "./critic-override";
import { runPlanFactStage } from "./plan-fact";
import { candidatePatches, runCodeCritique } from "../../critique/server";
import { fullAccessSpawn } from "../../core/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { closeWriterStages, recordGateEvaluation, recordStage } from "../../runs/server";
import { stringAt } from "../../core/server";
import { wasAnsweredByDefault } from "./question-default";
import { needsHumanQuestion, outputText, providerLimitNotice, providerStreamError, WRITER_STREAM_ERROR, writerContextBlocks, writerSetupLines } from "./writer-task";
import { isLiveDecision } from "../live-folder";
import { TASK_WORDS_KEY, acceptanceProofGap, taskSizeOf, isMainfixTask, landingWordGap, ownerWordsOn, questionsFromFile, referenceTestEdits, taskWordKey, testFitFindings, writerMarkers } from "../../tasks";
import type { TaskWord } from "../../tasks";
import type { StageId } from "../../tasks";
import { readCheckRun } from "../../tasks/server";
import { IntegrationGateRunner, parseIntegrationGateSettings } from "../../verification/server";
import { gateResolverFor } from "../../verification/server";
import { THREAD_WATCH_EVENT_TYPES, listThreadEventsRaw, sleepUntilThreadSignal, startLimitWaiting, threadFailure, threadWatchMark, waitThreadIdle } from "@lane-pilot/thread-observe";
import { join, relative, resolve } from "node:path";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { isRunHalted } from "../../runs/server";
import { clearFollowUpCancelled, followUpCancelled, loadFollowUp } from "./sticky";
import { askGuestsToCommit } from "./checkout-guests";
import { shouldMergeAttemptWorktree } from "./spawn";
import { loadWriterNudge } from "./writer-silence";
import { recordedWriterSkills } from "./skill-pick";
import { createSkillMaterializer, recordedMaterializedSkills } from "./skill-materialize";
import { recordSkillSwitchMetric } from "../skill-switch";
import { REPLAY_CHECK_FAILED, WRITER_SILENT_REASON, beginChecks, checksMoved, failureFingerprint, isEnvironmentCheckFailure, taskFamily } from "../../runs";
import { bookkeepingSetting } from "@lane-pilot/settings-catalog";
import { attemptMergeMessage, clearMergeIntent, recordMergeIntent } from "../../verification/server";
import { sendServiceMessage } from "../../relay/server";
import { judgeRulesOnDiff, ruleViolationRemark } from "../../learning";
import { jev, type JevSettings } from "@lane-pilot/jev";
import { writerFinishScanJudgment } from "../finish-scan";
import { runOnHost } from "@lane-pilot/host-calls";
import { pollPause } from "@lane-pilot/kit";

const FOLLOW_UP_DELETED = "the owner deleted the queued instruction for this writer";

/** How long an accepted attempt waits for another task's merge into the same checkout before it reports the block. */
const MERGE_QUEUE_MS = 15 * 60_000;
/** How long finished work waits for someone's uncommitted edits in the base checkout to be committed or put away. */
const DIRTY_BASE_WAIT_MS = 2 * 3600_000;
/** How long a verified task waits for the owner's word to land when owner.words is on. */
const OWNER_WORD_WAIT_MS = 6 * 3600_000;
const dirtyBase = (merged:{ status:string; reason?:string|null }) => merged.status === "conflict" && Boolean(merged.reason?.startsWith("base checkout has uncommitted changes"));

/**
 * The follow-up task that makes main green after a merge. It keeps the merged task's scope and checks but not its
 * expected_outputs (a prose entry names no file): those files are already in main, and the fix may sit in another owned
 * file or nowhere. Inherited, they made the writer of a green main edit routes.ts only to «put the required file in the
 * diff» (SelfyStudio cards-checkout-typecheck-fix-mainfix, 2026-10-05). The objective carries each failing command with
 * its output tail, the full output goes to the task folder's logs/, and expected_outputs holds the commands themselves.
 */
export function postMergeRepair(onMain:TaskV2, red:Array<{ command:string; exitCode:number; stdout?:string; stderr?:string }>):{
  fix:TaskV2; plan:string; logs:Array<{ path:string; content:string }>;
} {
  const tail = (check:typeof red[number], size=600) => `${check.stderr ?? ""}\n${check.stdout ?? ""}`.trim().slice(-size);
  const logName = (command:string, index:number) =>
    `${String(index + 1).padStart(2, "0")}-${command.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "check"}.log`;
  const fix:TaskV2 = { ...onMain, id:`${onMain.id}-mainfix`.slice(0, 128), title:`Make main green after ${onMain.id}`.slice(0, 200),
    // The task standard (the Tasks board): Lane Pilot's own task fills it, so the contract lint never sends it back.
    display_title:`Починка main после ${onMain.id}`.slice(0, 60), kind:"fix", area:onMain.area ?? "maintenance",
    depends_on:[], risk:onMain.risk === "low" ? "medium" : onMain.risk, expected_outputs:red.map((check) => check.command),
    objective:`Main is red after merging ${onMain.id} (${onMain.title}): these checks fail on main while they passed in the task's own worktree, so the merged work clashes with what landed meanwhile. Make each of them pass on main, keeping what ${onMain.id} and the work merged before it intended; change the least code that does it. Failing now:\n${red.map((check) => `\`${check.command}\` (exit ${check.exitCode}) output tail:\n${tail(check)}`).join("\n\n")}`,
    acceptance:[...red.map((check) => `\`${check.command}\` passes on main`), `${onMain.id}'s acceptance still holds: ${onMain.acceptance.join("; ")}`.slice(0, 600)] };
  const logs = red.map((check, index) => ({
    path:`.agents/plans/items/${fix.id}/logs/${logName(check.command, index)}`,
    content:`$ ${check.command}\nexit ${check.exitCode}\n\n${check.stdout ?? ""}\n${check.stderr ?? ""}`.trim() + "\n",
  }));
  const plan = `Post-merge repair, dispatched by Lane Pilot. Full output of every failing check: ${logs.map((log) => log.path).join(", ")}.\n\nRead the failure, find which merged change clashes (git log -5 on main), fix within owns_paths, run the checks. If every check already passes in your worktree before you change anything, main is green now: change no files and answer with the first line \`NEEDS_HUMAN: main is already green, nothing to fix\`.`;
  return { fix, plan, logs };
}

export function createWriterFinish(ctx: ServerCore, services: Services) {
  const { bb, db, getThreadBounded, host } = ctx;
  const integrationGateRunner = new IntegrationGateRunner(ctx, services);
  const skillMaterial = createSkillMaterializer(ctx, (message) => bb.log.info(message));

  /** The project's gate (explicit, detected on its host, or none). */
  const gateFor = (projectId:string, runId:string, hostId:string, basePath:string) =>
    gateResolverFor(ctx)({ runId, hostId, basePath, gate:parseIntegrationGateSettings(loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId))) });

  /**
   * A task landed (merged, or accepted in place in a folder with no repository): the batch gate counts it. The gate runs
   * once the project has no other open attempt; with `every_n` it also runs every n merges.
   */
  function noteMergedForGate(input:{ projectId:string; runId:string; taskId:string; attemptId:string; writerThreadId:string | null; pmThreadId:string; config:{ hostId:string } },
    basePath:string, commitSha:string, produced:string[], live:boolean) {
    integrationGateRunner.noteMergedTask({ taskId:input.taskId, commitSha, threadId:input.writerThreadId, attemptId:input.attemptId, produced });
    const drained = !listOpenAttempts(db).some((row) => row.project_id === input.projectId && row.id !== input.attemptId);
    // Called without await: a throw here must never become an unhandled rejection, which kills the whole BB server.
    return integrationGateRunner.maybeRunGate({ runId:input.runId, projectId:input.projectId, pmThreadId:input.pmThreadId, basePath,
      configHostId:input.config.hostId, trigger:drained ? "drain" : "merge", ...(live ? { live:true } : {}) })
      .catch((cause:unknown) => { ctx.log(`integration-gate: failed after merging ${input.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`); return { ran:false }; });
  }

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
  };

  /** The attempt's end, whatever its outcome: the skill links and the compaction config an OpenCode writer got leave its worktree. */
  async function finishWriterAttempt(input: FinishInput): Promise<Record<string,unknown>> {
    let result: Record<string, unknown> | null = null;
    try {
      result = await finishWriterAttemptBody(input);
      return result;
    } finally {
      try {
        const skills = recordedWriterSkills(getReasoningTrace(db, input.attemptId)?.dispatchContext);
        const events = await bb.sdk.threads.events.list({ threadId: input.writerThreadId, limit: "100" } as never).then((r: any) => r?.events ?? [], () => []);
        const outcome = result?.status === "accepted" || result?.state === "accepted" ? "accepted" : "failed";
        recordSkillSwitchMetric(db, {
          attemptId: input.attemptId,
          taskId: input.taskId,
          runId: input.runId,
          projectId: input.projectId,
          events,
          skills,
          outcome,
        });
      } catch (cause) {
        ctx.log(`writer skill switch metric failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      await skillMaterial.remove({ attemptId:input.attemptId, hostId:input.config.hostId,
        workspacePath:getAttempt(db, input.attemptId)?.workspace_path ?? null,
        names:recordedMaterializedSkills(getReasoningTrace(db, input.attemptId)?.dispatchContext),
        providerId:getReasoningTrace(db, input.attemptId)?.providerId ?? null });
    }
  }

  async function finishWriterAttemptBody(input: FinishInput): Promise<Record<string,unknown>> {
    // The PM's stop and a failure can land together: an attempt whose stop was requested ends canceled whatever failed
    // (cancel_requested has only canceled, blocked and accepted to go to, and the owner asked for the stop).
    const endedByStop = (reason:string, threadId = input.writerThreadId):Record<string,unknown>|null => {
      if (getAttempt(db, input.attemptId)?.state !== "cancel_requested") return null;
      transitionAttempt(db, input.attemptId, "canceled", { threadId, reason:`writer stop observed after: ${reason}`.slice(0, 500) });
      return { status:"canceled", attemptId:input.attemptId, writerThreadId:threadId };
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
        } catch {
          // Usage is informational; a host that cannot list events does not fail the attempt.
        }
      };
      // Stage budget question: at four fifths of the task's appetite minutes the PM is asked once whether to extend them (lane_pilot_update_task)
      // or let the writer stop. The appetite's tokens are a forecast only (packages/resilience/src/appetite.ts): no question, no stop.
      let budgetAsked = false;
      const askBudgetOnce = () => {
        if (budgetAsked || !appetite?.minutes || !input.pmThreadId) return;
        const timeUsed = (Date.now() - attemptStartedAt) / (appetite.minutes * 60_000);
        if (timeUsed < 0.8) return;
        budgetAsked = true;
        void Promise.resolve().then(() => bb.sdk.threads.send({ threadId:input.pmThreadId!, mode:"queue-if-active", input:[{ type:"text", mentions:[], text:`[Lane Pilot] Task ${input.taskId} has spent ${Math.round(timeUsed * 100)}% of its appetite (${Math.round((Date.now() - attemptStartedAt) / 60_000)}/${appetite.minutes} min). Its writer stops at the appetite: raise it with lane_pilot_update_task now if the work is worth more, or let it stop.` }] } as never)).catch(() => undefined);
      };
      const overBudget = () => { askBudgetOnce(); return runningWriterBudgetStop(budget.check()) ?? appetiteStop(appetite, { tokens:writerTokens, elapsedMs:Date.now() - attemptStartedAt }); };
      const stopRunningWriter = async (reason:string) => {
        const current = await getThreadBounded(input.writerThreadId).catch(() => null);
        const status = stringAt(current, "status");
        if (["active", "starting"].includes(status ?? "")) await bb.sdk.threads.stop({ threadId:input.writerThreadId }).catch(() => undefined);
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        closeWriterStages(db, {
          runId:input.runId, taskId:input.taskId, plan:getTaskPlan(db, input.taskId) ?? "",
          terminal:"failed", attempt:countAttempts(db, input.runId, input.taskId), reason, threadId:input.writerThreadId,
        });
        services.promotions?.settleTask({ taskId: input.taskId, outcome: "failed", reason });
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
            idle.catch(() => undefined);
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
          if (["active", "starting"].includes(currentStatus ?? "")) await bb.sdk.threads.stop({ threadId:input.writerThreadId }).catch(() => undefined);
          return ended;
        }
        const listed = currentStatus === "idle" ? null : await listThreadEventsRaw(bb, { threadId:input.writerThreadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50" });
        const rawFailure = currentStatus === "error" ? "writer thread status error" : listed?.ok ? threadFailure(listed.events) : null;
        // A turn held in the concurrency-limit queue is waiting its turn: the provider's start limit is not a failure then.
        const failure = await startLimitWaiting(bb, input.writerThreadId, rawFailure) ? null : rawFailure;
        if (failure) {
          const ended = providerFailed(failure);
          if (["active", "starting"].includes(currentStatus ?? "")) await bb.sdk.threads.stop({ threadId:input.writerThreadId }).catch(() => undefined);
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
      // A writer that stopped to ask the owner is not a failed attempt: no retry, no fallback, the question goes to the PM.
      const answer = outputText(await bb.sdk.threads.output({ threadId:input.writerThreadId }).catch(() => ""));
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
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"skipped",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{reason:"needs_human"}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      const checked = await services.validateWriterResult({
        config:input.config, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
        attempt:countAttempts(db,input.runId,input.taskId), task:input.task, writerThreadId:input.writerThreadId, attemptId:input.attemptId,
        dirtBefore:input.dirtBefore,
      });
      if (checked.status !== "accepted") {
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:checked.status}});
        const stopped = endedByStop(checked.reason ?? checked.status);
        if (stopped) return stopped;
        transitionAttempt(db, input.attemptId, checked.status, { reason:checked.reason });
        return { ...checked, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
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
      const liveCritiquePolicy = frozenPolicy ?? parseCodeCritiqueSettings(applyCodeCriticDefault(applyQualityMode(projectSettings,qualityMode),qualityMode,input.task.risk,criticDefault));
      const baselineHashes = Object.fromEntries(input.dirtBefore.map((row) => [row.path, row.sha256 || null]));
      let lastPatches: Record<string, string> | undefined;
      const captureEvidence = async () => {
        const dirt = await services.workspaceDirt(input.config, input.task.project_cwd, input.runId);
        const byPath = new Map((dirt.ok ? dirt.snapshots : []).map((row) => [row.path, row.sha256 || null]));
        const hashes = Object.fromEntries((candidate.produced ?? []).map((path) => [path, byPath.get(path) ?? null]));
        const files:Array<{ path:string; content:string|null }> = [];
        for (const path of candidate.produced ?? []) {
          const file = await bb.sdk.files.read({
            hostId:input.config.hostId, rootPath:input.task.project_cwd, path:resolve(input.task.project_cwd, path),
          }).catch(() => ({ content:null }));
          files.push({ path, content:typeof file.content === "string" ? file.content : null });
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
        });
      };
      let criticNotes = "";
      const keepAdvisory = (row: { settings?: { mode?: string }; parsed?: Parameters<typeof advisoryFeedback>[0] } | undefined) => {
        if (row?.settings?.mode !== "advisory" || !row.parsed) return;
        const text = advisoryFeedback(row.parsed);
        if (text) criticNotes = text;
      };
      if (liveCritiquePolicy.enabled) {
      for (;;) {
        const evidence = await captureEvidence();
        // abide-style: the accepted writer rules against this diff, before the critic. A break is a remark on the
        // writer's repair turn, never a block; shadow (the default) only records what it would have said.
        const ruleRemark = ruleViolationRemark(await judgeRulesOnDiff(jev(), db, input.projectId,
          Object.values(lastPatches ?? {}).join("\n"),
          { projectId:input.projectId, runId:input.runId, subject:input.taskId, settings:projectSettings }).catch(() => []));
        const ledger = repairLedgerFromResult(listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === "code-critique")?.result);
        if (ledger?.policy) frozenPolicy = ledger.policy;
        if (ledger?.repairRound) repairRound = Math.max(repairRound, ledger.repairRound);
        const disputes = repairRound > 0 ? parseWriterRepairReply(candidate.output) : null;
        if (disputes && disputes.replies.length > 0 && disputes.replies.every((row) => row.status === "disputed")) {
          const recritique = await runCodeCritique({
            bb, db, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            config:input.config, task:input.task, evidence, disputes, frozenPolicy, criticDefault:taskCriticDefault,
            workflow:pipelineWriterStep(db, input.runId, input.taskId) ?? undefined,
          });
          if (recritique.policy) frozenPolicy = recritique.policy;
          if (recritique.allowed) { keepAdvisory(recritique); review = recritique.review; approvedArtifact = evidence.artifactRevisionSha256; break; }
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason:recritique.reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason:recritique.reason });
          return { status:"blocked", reason:recritique.reason, attemptId:input.attemptId, writerThreadId };
        }
        const inflight = nextRepairAction({
          ledger, nextRound:Math.max(1, ledger?.repairRound ?? repairRound),
          attemptId:input.attemptId, artifactRevisionSha256:evidence.artifactRevisionSha256,
        });
        if (inflight === "unknown") {
          const reason = "code_critique_repair_unknown";
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
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
            recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
              attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:candidate.status}});
            const stopped = endedByStop(candidate.reason ?? candidate.status, writerThreadId);
            if (stopped) return stopped;
            transitionAttempt(db, input.attemptId, candidate.status, { reason:candidate.reason });
            return { ...candidate, attemptId:input.attemptId, writerThreadId };
          }
          recordStage(db, {
            runId:input.runId, taskId:input.taskId, stageId:"code-critique",
            state:"blocked",
            input:codeCritiqueSource({ evidence, task:input.task, agent:frozenPolicy?.agent ?? "code-critic" }),
            result:{ ...ledger, spawnAttempted:true, repairObserved:true, repairThreadId:ledger.repairThreadId, repairRound:ledger.repairRound },
            reason:"critique_changes_requested",
          });
          continue;
        }
        if (lastArtifact && evidence.artifactRevisionSha256 === lastArtifact && repairRound > 0
          && !(disputes && disputes.replies.some((row) => row.status === "disputed"))) {
          const reason = "code_critique_revision_unchanged";
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        const critique = await runCodeCritique({
          bb, db, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          config:input.config, task:input.task, evidence, frozenPolicy, criticDefault:taskCriticDefault,
          workflow:pipelineWriterStep(db, input.runId, input.taskId) ?? undefined,
        });
        if (critique.policy) frozenPolicy = critique.policy;
        if (critique.allowed) { keepAdvisory(critique); review = critique.review; approvedArtifact = evidence.artifactRevisionSha256; break; }
        const parsed = critique.parsed;
        const critiqueSettings = frozenPolicy ? settingsFromFrozenPolicy(frozenPolicy) : critique.settings;
        if (!parsed || !critiqueSettings || !shouldRequestRepair({ settings:critiqueSettings, result:parsed, round:repairRound })) {
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason:critique.reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason:critique.reason });
          return { status:"blocked", reason:critique.reason, attemptId:input.attemptId, writerThreadId };
        }
        const nextFindings = actionableFindings(parsed);
        if (previousFindings.length && sameUnresolvedFindings(previousFindings, nextFindings)) {
          const reason = "code_critique_repeated_finding";
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
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
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        const trace = getReasoningTrace(db, input.attemptId);
        const bound = getAttempt(db, input.attemptId);
        if (!trace || !bound) {
          const reason = "code_critique_writer_identity_unknown";
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
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
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
        }
        const frozenFindings = spawnLedger?.findings?.length ? spawnLedger.findings : nextFindings;
        const frozenHash = spawnLedger?.findingsHash || findingsHash(frozenFindings);
        if (frozenHash !== findingsHash(nextFindings) && spawnLedger?.findingsHash) {
          const reason = "code_critique_findings_mutated";
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
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
          const writerIdle = stringAt(await bb.sdk.threads.get({ threadId:writerThreadId }).catch(() => null), "status") === "idle";
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
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:candidate.status}});
          const stopped = endedByStop(candidate.reason ?? candidate.status, writerThreadId);
          if (stopped) return stopped;
          transitionAttempt(db, input.attemptId, candidate.status, { reason:candidate.reason });
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
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
      }
      }
      // The plan against the fact: code checks the writer's evidence per acceptance item against the diff, never its prose. It records
      // its stage whatever the outcome; only plan_fact.mode=gate sends an item with no evidence that holds back to the writer.
      const planFact = await runPlanFactStage(ctx, { projectId:input.projectId, runId:input.runId, taskId:input.taskId, attempt:countAttempts(db,input.runId,input.taskId),
        hostId:input.config.hostId, task:input.task, answers:[candidate.output, answer], produced:candidate.produced ?? [], verification:candidate.verification ?? [] })
        .catch((cause:unknown) => { ctx.log(`plan-fact: ${input.taskId} could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (planFact?.refusal) {
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"plan_fact_unproven",reason:planFact.refusal}});
        const stopped = endedByStop(planFact.refusal, writerThreadId);
        if (stopped) return stopped;
        transitionAttempt(db, input.attemptId, "validation_failed", { reason:planFact.refusal });
        return { status:"validation_failed", reason:planFact.refusal, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
      }
      // Approach and lesson markers warn. A weakened test (test_fit) blocks acceptance; any other edit of a test that already existed stays a warning.
      const markers = writerMarkers(`${candidate.output ?? ""}\n${answer}`);
      const testEdits: string[] = [];
      const fitFiles: Array<{ path:string; before:string | null; after:string | null }> = [];
      const fitAttempt = getAttempt(db, input.attemptId);
      const basePathForTests = taskBasePath(db, input.runId, input.taskId);
      // ponytail: the first 400 lines only. A deletion past that line is missed; raise the cap if a real test file is longer.
      const readFit = (cwd:string | null | undefined, path:string) => cwd
        ? host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:cwd, relativePath:path, offset:0, maxLines:400 }, { hostId:input.config.hostId, timeoutMs:10_000 }).then((file) => file.content, () => null)
        : Promise.resolve(null);
      for (const path of referenceTestEdits((candidate.produced ?? []).map((path) => ({ path, status:"M" }))).slice(0, 20)) {
        const before = await readFit(basePathForTests, path);
        if (before === null) continue;
        testEdits.push(path);
        fitFiles.push({ path, before, after: await readFit(fitAttempt?.workspace_path, path) });
      }
      for (const path of (candidate.produced ?? []).filter((path) => /(^|\/)package\.json$|\.(?:sh|ya?ml)$/.test(path)).slice(0, 10)) {
        fitFiles.push({ path, before: await readFit(basePathForTests, path), after: await readFit(fitAttempt?.workspace_path, path) });
      }
      const fitHits = testFitFindings(fitFiles);
      if (fitHits.length) {
        const reason = `test_fit: ${fitHits.slice(0, 5).map((hit) => `${hit.path}: ${hit.evidence}`).join("; ")}`.slice(0, 500);
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"test_fit",reason}});
        transitionAttempt(db, input.attemptId, "validation_failed", { reason });
        return { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification, attemptId:input.attemptId, writerThreadId };
      }
      const markerWarnings = [
        ...(!markers.approach ? ["the report has no APPROACH line"] : []),
        ...(!markers.lesson && !markers.noLessonReason ? ["the report has no LESSON line (a lesson, or none with the reason)"] : []),
        ...(testEdits.length ? [`the writer changed tests that existed before the attempt (reference tests): ${testEdits.join(", ")} — the critic checks they were not weakened`] : []),
      ];
      if (criticNotes) {
        markerWarnings.push(criticNotes);
        void sendServiceMessage(bb, { threadId: writerThreadId, senderThreadId: input.pmThreadId, text: criticNotes }).catch(() => undefined);
      }
      if (markerWarnings.length) candidate.warnings = [...(candidate.warnings ?? []), ...markerWarnings];
      // The approach note the window's task screen shows (the gate keeps only the hash of its summary).
      await bb.storage.kv.set(`lp.task.approach:${input.runId}:${input.taskId}`, { approach:markers.approach, lesson:markers.lesson, noLessonReason:markers.noLessonReason, referenceTestEdits:testEdits, at:Date.now() } as never).catch(() => undefined);
      // Stage questions from files and the execution checkpoint: the task folder's QUESTIONS.md and CHECKPOINT.md, read from the attempt's copy.
      const attemptRow = fitAttempt;
      const folderOf = (name:string) => `.agents/plans/items/${input.taskId}/${name}`;
      const readTaskFile = async (name:string) => attemptRow?.workspace_path ? await host.call("readBoundedFile", { requestedHostId:input.config.hostId, projectCwd:attemptRow.workspace_path, relativePath:folderOf(name), offset:0, maxLines:200 }, { hostId:input.config.hostId, timeoutMs:10_000 }).then((file) => file.content, () => null) : null;
      const questionsText = await readTaskFile("QUESTIONS.md");
      const checkpoint = await readTaskFile("CHECKPOINT.md");
      const fileQuestions = questionsText ? questionsFromFile(questionsText) : [];
      if (fileQuestions.length || checkpoint) {
        await bb.storage.kv.set(`lp.task.questions:${input.runId}:${input.taskId}`, { questions:fileQuestions, checkpoint:checkpoint?.slice(0, 2000) ?? null, at:Date.now() } as never).catch(() => undefined);
        if (fileQuestions.length) candidate.warnings = [...(candidate.warnings ?? []), `the writer left ${fileQuestions.length} question(s) in QUESTIONS.md: ${fileQuestions.map((row) => `[${row.kind}] ${row.question}`).join("; ").slice(0, 600)}`];
      }
      // Drawing unchanged: the drawing a task follows is its input, not its output; a writer that edited it changed the yardstick.
      const drawingTouched = (input.task.drawing ?? []).filter((path) => (candidate.produced ?? []).some((changed) => changed.replace(/^\.\//, "") === path.replace(/^\.\//, "")));
      if (drawingTouched.length) {
        const reason = `drawing_changed: the task follows the drawing ${drawingTouched.join(", ")} and must not change it; undo those edits (the drawing is changed in the phase's design stage)`;
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
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
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"challenge_gate",reason}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
      }
      const proofGap = acceptanceProofGap(provenBy);
      if (proofGap) {
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"no_code_proof",reason:proofGap}});
        transitionAttempt(db, input.attemptId, "blocked", { reason:proofGap });
        return { status:"blocked", reason:proofGap, attemptId:input.attemptId, writerThreadId };
      }
      // The owner's word before landing (SMA: Approving, Authorized by a person): with owner.words on, a verified task waits here,
      // in place and with its worktree, for the owner's yes the PM records (lane_pilot_queue word); a no or six silent hours block it.
      const ownerWords = ownerWordsOn(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)));
      const wordsOf = async () => ((await bb.storage.kv.get(TASK_WORDS_KEY).catch(() => null)) as Record<string, TaskWord[]> | null)?.[taskWordKey(input.runId, taskFamily(input.taskId))];
      let wordGap = landingWordGap(ownerWords, await wordsOf());
      if (wordGap && !wordGap.includes("said no")) {
        void sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:writerThreadId,
          text:`Lane Pilot: task ${input.taskId} passed its checks and waits for the owner's word before it lands on main (owner.words is on). Ask him with lane_pilot_ask_owner, then record his answer with lane_pilot_queue {action:"word", taskId:"${input.taskId}", decision:"yes"|"no", text}. It waits up to 6 hours; no need to resend it.` }).catch(() => undefined);
        const since = Date.now();
        while (wordGap && !wordGap.includes("said no") && Date.now() - since < OWNER_WORD_WAIT_MS && !ctx.isDisposed()) {
          await new Promise((wake) => setTimeout(wake, 60_000));
          wordGap = landingWordGap(ownerWords, await wordsOf());
        }
      }
      if (wordGap) {
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"owner_word",reason:wordGap}});
        transitionAttempt(db, input.attemptId, "blocked", { reason:wordGap });
        return { status:"blocked", reason:wordGap, attemptId:input.attemptId, writerThreadId };
      }
      // The parallel finish scan (Gemini 7): three cheap nouls on the landing attempt — diff risk, UI, docs — for
      // receipts and the task's profile; it never changes the finish path.
      try {
        const scan = await jev()?.judge(writerFinishScanJudgment, {
          title: input.task.title, contract: JSON.stringify({ invariants: input.task.invariants, out_of_scope: input.task.out_of_scope }),
          produced: (candidate.produced ?? []).slice(0, 40).join("\n"),
          verification: (candidate.verification ?? []).slice(0, 10).map((row) => `${row.command}:${row.exitCode}`).join("\n"),
          summary: typeof candidate.output === "string" ? candidate.output : "",
        }, { projectId: input.projectId, runId: input.runId, subject: "writer-finish", settings: loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)) as JevSettings });
        if (scan?.by === "jev") bb.log.info(`Lane Pilot finish-scan ${input.taskId}: ${writerFinishScanJudgment.describe(scan.decision)}`);
      } catch { /* a scan is never a gate */ }
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
          removeWorktree:bound.environment_id === null && !input.task.area,
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
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"failed",
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
          const asked = await askGuestsToCommit(bb, basePath, merged.conflicts, input.taskId, input.pmThreadId).catch(() => [] as string[]);
          void sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:writerThreadId,
            text:asked.length
              ? `Lane Pilot: task ${input.taskId} is ready, but main checkout ${basePath} has uncommitted changes in the same files: ${files}. Lane Pilot asked threads working in this folder to commit them: ${asked.map((thread) => `@thread:${thread}`).join(", ")}. The task will merge automatically once files are committed (waits up to 2 hours); no need to resend it.`
              : `Lane Pilot: task ${input.taskId} is ready, but main checkout ${basePath} has uncommitted changes in the same files: ${files}. Lane Pilot does not know whose chat it is: ask the owner to commit or put them away (or do it yourself if this chat made them). The task will merge automatically once the directory is clean (waits up to 2 hours); no need to resend it.` }).catch(() => undefined);
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
            recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"failed",
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
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged}});
          const stopped = endedByStop(reason, writerThreadId);
          if (!stopped) transitionAttempt(db, input.attemptId, "validation_failed", { reason });
          await settleIntent();
          if (stopped) return stopped;
          return { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:replayRed && merged.checks?.length ? merged.checks : candidate.verification,
            attemptId:input.attemptId, writerThreadId };
        }
        integration = { status:merged.status, commit:merged.commit, conflicts:[], ...(merged.rebased ? { rebased:true } : {}) };
        // The base, the merge commit and the files it changed (deletions included) go on the attempt's record (SMA wall 4).
        services.rollback?.noteMerge(input.attemptId, merged);
        if (merged.status === "merged") {
          const gate = await gateFor(input.projectId, input.runId, input.config.hostId, basePath);
          if (gate) {
            void noteMergedForGate(input, basePath, merged.commit ?? "", candidate.produced, false);
          } else {
            void checkMainAfterMerge({ projectId:input.projectId, pmThreadId:input.pmThreadId, config:input.config,
              runId:input.runId, task:input.task, basePath, worktreePath:bound.workspace_path, attemptId:input.attemptId, mergeCommit:merged.commit ?? undefined,
              greenInWorktree:(candidate.verification ?? []).filter((check) => check.exitCode === 0).map((check) => check.command) });
          }
        }
      } else if (bound && basePath && isLiveDecision(bound.workspace_decision)) {
        // A folder with no repository has no merge: the accepted task is in place, and the gate runs there once the queue drains.
        if (await gateFor(input.projectId, input.runId, input.config.hostId, basePath)) void noteMergedForGate(input, basePath, "", candidate.produced, true);
      }
      // #29 task-size metric: what this accepted task cost (files, diff lines, minutes, attempts) rides the receipt;
      // the project's median over these rows is what plan warnings measure new slices against.
      let sizeLines = 0;
      if (integration?.commit) {
        const stat = await runOnHost(host, { hostId:input.config.hostId, cwd:basePath!, command:`git diff --shortstat ${integration.commit}^ ${integration.commit}`, timeoutSec:15, timeoutMs:15_000 }).catch(() => null);
        if (stat && stat.exitCode === 0) for (const m of stat.stdout.matchAll(/(\d+) insertions?|(\d+) deletions?/g)) sizeLines += Number(m[1] ?? m[2] ?? 0);
      }
      const firstAttempt = (db.prepare("SELECT MIN(created_at) AS c FROM lane_pilot_attempt WHERE task_id=?").get(input.taskId) as { c?: number } | undefined)?.c ?? null;
      const size = taskSizeOf({ files:(candidate.produced ?? []).length, lines:sizeLines, createdAt:firstAttempt, finishedAt:Date.now(), attempts:countAttempts(db,input.runId,input.taskId) });
      recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"passed",
        attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{acceptanceReceiptPersisted:true,integration,size}});
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

  /**
   * The task's checks again on main once it is merged: green alone, two tasks can break main together (merge queues
   * test the merged result). The work stays merged — nothing is thrown away — and a follow-up task makes main green
   * on top of it, so an agent repairs it rather than the owner or the PM. A follow-up that breaks main again is
   * reported to the PM instead of chaining.
   */
  async function checkMainAfterMerge(input:{ projectId:string; pmThreadId:string; config:Parameters<typeof services.runVerification>[0];
    runId:string; task:TaskV2; basePath:string; worktreePath:string;
    /** The merge this check follows: one merge commit of one attempt is one check, never another's. */ attemptId?:string; mergeCommit?:string;
    /** Checks this attempt ran green in its own worktree: red on the base, green there and red on main again is a clash of the merge. */ greenInWorktree?:readonly string[] }) {
    if (!input.task.verification.length || !input.pmThreadId || await isRunHalted(bb.storage.kv as never, input.runId)) return;
    const onBase = (cwd:string) => resolve(cwd).startsWith(resolve(input.worktreePath)) ? join(input.basePath, relative(input.worktreePath, cwd)) : cwd;
    const onMain = { ...input.task, project_cwd:input.basePath, verification:input.task.verification.map((command) => ({ ...command, cwd:onBase(command.cwd) })) };
    const checks = await services.runVerification(input.config, onMain, input.runId, undefined, { background:true, jobKey:`post-merge:${input.attemptId ?? input.task.id}:${input.mergeCommit ?? ""}` }).catch((cause:unknown) => {
      ctx.log(`post-merge check of ${input.task.id} could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    });
    // A check whose host call failed says nothing about main: read as red, it dispatched a mainfix for a green main.
    const unrun = checks?.filter((check) => check.hostError) ?? [];
    if (unrun.length) ctx.log(`post-merge check of ${input.task.id} could not run on the host: ${unrun.map((check) => `${check.command} (${check.stderr.slice(0, 160)})`).join(", ")}`);
    const failing = checks?.filter((check) => check.exitCode !== 0 && !check.hostError) ?? [];
    // «What turned red» (src/rooms/baseline): the checks that were green on the base before this task and are red on main with it.
    const turnedRed = checks ? services.baseline?.afterMerge({ runId:input.runId, taskId:input.task.id, mergeCommit:input.mergeCommit, checks }) ?? [] : [];
    const tell = (text:string) => bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active", input:[{ type:"text", text, mentions:[] }] } as never).catch(() => undefined);
    // A check the machine broke (EACCES, EPERM, EEXIST: root-owned files after a deploy) is no clash of merged work, and
    // no writer can fix it inside owns_paths: an infra incident and one message to the PM, no -mainfix.
    const environment = failing.filter((check) => isEnvironmentCheckFailure(check));
    if (environment.length) {
      const evidence = `${environment[0]!.stderr ?? ""}\n${environment[0]!.stdout ?? ""}`.split("\n").find((line) => isEnvironmentCheckFailure({ stderr:line }))?.trim().slice(0, 300) ?? "";
      ctx.log(`infra: post-merge check of ${input.task.id} is red on main from the environment, no repair task: ${environment.map((check) => check.command).join(", ")} (${evidence})`);
      const noted = `post-merge-infra:${input.runId}:${failureFingerprint(evidence)}`;
      if (!await bb.storage.kv.get(noted).catch(() => null)) {
        await bb.storage.kv.set(noted, Date.now() as never).catch(() => undefined);
        await tell(`Lane Pilot: ${input.task.id} is merged, but ${environment.map((check) => check.command).join(", ")} is red on main because of the machine, not the code: ${evidence}. No repair task was created (a writer cannot fix file permissions). Fix it in ${input.basePath} (for example chown the root-owned files back to the Lane Pilot user), then run the check again.`);
      }
    }
    const red = failing.filter((check) => !isEnvironmentCheckFailure(check));
    if (!red.length) return;
    ctx.log(`post-merge check of ${input.task.id} failed on main: ${red.map((check) => check.command).join(", ")}`);
    if (isMainfixTask(input.task.id)) {
      await tell(`Lane Pilot: ${input.task.id} fixed main once already and main is red again after it (${red[0]!.command}). Look at what else merged meanwhile and dispatch the fix yourself.`);
      return;
    }
    // Only a reproducible regression of this task gets a writer: a red that was red on the base too is not its doing, and one
    // that passes on a re-run is flaky. Without a baseline record for a check, the re-run alone decides.
    // A fix turns a check red on the base green: green in its own worktree and red again on main is the merge's doing, not an old red.
    const ownGreen = new Set(input.greenInWorktree ?? []);
    const redBefore = (services.baseline?.redBefore?.({ runId:input.runId, taskId:input.task.id, checks:checks ?? [] }) ?? []).filter((command) => !ownGreen.has(command));
    const candidates = red.filter((check) => !redBefore.includes(check.command));
    // A red that already failed its own re-run (runWithFlakyRerun: `reran`) as a product red both times is reproduced; running it again
    // only repeated the same command twice more (2026-10-29 audit). A re-run that timed out or broke reproduced nothing (audit N-05).
    const reproduced = candidates.filter((check) => {
      const rerun = (check as { rerun?:{ exitCode:number; stdout?:string; stderr?:string; hostError?:boolean; threw?:boolean } }).rerun;
      return !!rerun && rerun.exitCode !== 124 && readCheckRun(check, { command: check.command }).verdict === "product_fail" && readCheckRun({ ...check, hostError:false, threw:false, ...rerun }, { command: check.command }).verdict === "product_fail";
    });
    const toRerun = candidates.filter((check) => !reproduced.includes(check));
    let confirmed = candidates;
    let flaky:string[] = [];
    if (toRerun.length) {
      const names = new Set(toRerun.map((check) => check.command));
      const again = await services.runVerification(input.config, { ...onMain, verification:onMain.verification.filter((command) => names.has(command.command)) }, input.runId, undefined,
        { background:true, jobKey:`post-merge:${input.attemptId ?? input.task.id}:${input.mergeCommit ?? ""}:rerun` }).catch(() => null);
      // Only a re-run that is a product red again reproduces the defect (readCheckRun, the reading replay and the gate share). One the
      // machine or the host broke, that threw, or that ran no test says nothing: the first red stays recorded, no writer is sent.
      const readings = new Map((again ?? []).map((check) => [check.command, readCheckRun(check, { command: check.command })] as const));
      flaky = toRerun.filter((check) => readings.get(check.command)?.verdict === "pass").map((check) => check.command);
      confirmed = [...reproduced, ...toRerun.filter((check) => readings.get(check.command)?.verdict === "product_fail")];
      const unsettled = toRerun.filter((check) => !flaky.includes(check.command) && !confirmed.includes(check));
      if (unsettled.length) ctx.log(`post-merge check of ${input.task.id}: red on main once, the re-run did not reproduce it (${unsettled.map((check) => `${check.command}: ${readings.get(check.command)?.verdict ?? "no result"}`).join(", ")}); no repair task, the red stays recorded`);
    }
    if (flaky.length || redBefore.length) {
      ctx.log(`post-merge check of ${input.task.id} on main: no repair task for ${[...flaky, ...redBefore].join(", ")} (${flaky.length ? "flaky" : "red before this task too"})`);
      await tell(`Lane Pilot: ${input.task.id} is merged.${flaky.length ? ` ${flaky.join(", ")} failed on main once and passed on a re-run (flaky), so it is not this task's regression.` : ""}${redBefore.length ? ` ${redBefore.join(", ")} is red on main, but it was red before this task too (on the base), so it is not this task's regression.` : ""} No repair task was created for ${flaky.length && redBefore.length ? "them" : "it"}${confirmed.length ? "" : "; look at it yourself if it matters"}.`);
    }
    if (!confirmed.length) return;
    const { fix, plan, logs } = postMergeRepair(onMain, confirmed);
    // The writer reads the failure from its task folder; a full log per failing check, best-effort.
    for (const log of logs) {
      await bb.sdk.files.write({ hostId:input.config.hostId, rootPath:input.basePath, path:`${input.basePath}/${log.path}`,
        content:log.content, contentEncoding:"utf8", createParents:true, expectedSha256:null }).catch(() => undefined);
    }
    const sent = await services.dispatchWriter({ threadId:input.pmThreadId, projectId:input.projectId, task:fix, plan }).catch((cause:unknown) => ({ state:"rejected", reason:cause instanceof Error ? cause.message : String(cause) }));
    await tell(`Lane Pilot: ${input.task.id} is merged, but ${confirmed.map((check) => check.command).join(", ")} fails on main with it${turnedRed.length ? ` (${turnedRed.join(", ")} passed on the base before this task)` : ""}. The work stays in main; ${String(sent.state) === "rejected" || String(sent.state) === "blocked" || (sent as { ok?:unknown }).ok === false ? `the repair task could not start (${String((sent as { reason?:unknown }).reason ?? (sent as { hint?:unknown }).hint ?? sent.state)}), dispatch it yourself` : `repair task ${fix.id} is on its way — no action needed`}.`);
  }

  return { finishWriterAttempt, checkMainAfterMerge, noteMergedForGate };
}
