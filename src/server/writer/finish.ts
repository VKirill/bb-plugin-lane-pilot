import { runningWriterBudgetStop, tokenUsageFromEvent } from "@lane-pilot/resilience";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { countAttempts, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getTaskPlan, listOpenAttempts, listStageReceipts, loadProjectSettings, transitionAttempt } from "../../database";
import { saveBlockedBy, type BlockedBy } from "../blocked-by";
import { relayFor } from "../relay";
import type { HelperPolicySnapshot } from "../../helper-context";
import { writerExecutionSelection } from "../../jev-reasoning";
import { actionableFindings, buildCandidateEvidence, codeCritiqueSource, codeRepairPrompt, findingsHash, nextRepairAction, parseCodeCritiqueSettings, parseWriterRepairReply, repairLedgerFromResult, sameUnresolvedFindings, sameWriterIdentity, settingsFromFrozenPolicy, shouldRequestRepair } from "../../stages/code-critique";
import type { WriterIdentity } from "../../stages/code-critique";
import { runCodeCritique } from "../critique-runs";
import { fullAccessSpawn } from "../pm-spawn";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../run-routing";
import { closeWriterStages, recordGateEvaluation, recordStage } from "../stage-records";
import { stringAt } from "../values";
import { needsHumanQuestion, outputText, WRITER_SETUP_LINES, writerContextBlocks } from "../writer-task";
import { THREAD_WATCH_EVENT_TYPES, listThreadEventsRaw, threadFailure, waitThreadIdle } from "@lane-pilot/thread-observe";
import { join, relative, resolve } from "node:path";
import type { ServerCore } from "../core";
import type { Services } from "../services";
import { isRunHalted } from "../runs-halt";
import { loadFollowUp } from "./sticky";
import { askGuestsToCommit } from "../checkout-guests";
import { shouldMergeAttemptWorktree } from "./spawn";

/** How long an accepted attempt waits for another task's merge into the same checkout before it reports the block. */
const MERGE_QUEUE_MS = 15 * 60_000;
/** How long finished work waits for someone's uncommitted edits in the base checkout to be committed or put away. */
const DIRTY_BASE_WAIT_MS = 2 * 3600_000;
const dirtyBase = (merged:{ status:string; reason?:string|null }) => merged.status === "conflict" && Boolean(merged.reason?.startsWith("base checkout has uncommitted changes"));

export function createWriterFinish(ctx: ServerCore, services: Services) {
  const { bb, db, getThreadBounded, host } = ctx;

  /** Who holds the checkout: the open attempt whose task the holder's commit message names. */
  function mergeHolder(runId: string, holder: string | null, since: number): BlockedBy {
    const projectId = getRun(db, runId)?.project_id;
    const taskId = holder?.split(":")[0]?.trim() || null;
    const attempt = taskId ? listOpenAttempts(db).find((row) => row.task_id === taskId && row.project_id === projectId) : undefined;
    return { kind:"merge-lock", holderTaskId:taskId, holderThreadId:attempt?.thread_id ?? null, holderAttemptId:attempt?.id ?? null,
      since:new Date(since).toISOString(), retryAfterSec:60, detail:holder };
  }

  async function finishWriterAttempt(input: {
    projectId:string; config:PrototypeConfig; task:TaskV2;
    runId:string; taskId:string; attemptId:string; pmThreadId:string; writerThreadId:string;
    dirtBefore:import("../../cli-outcome").DirtSnapshot[];
    emergencyFallback?:{reason:string;primaryAttemptId:string;providerId:string;model:string};
  }): Promise<Record<string,unknown>> {
    try {
      const budget = services.runBudgetFor(input.runId, loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)));
      const watchBudget = budget.snapshot().limits.maxWallMs !== undefined || budget.snapshot().limits.maxTokens !== undefined;
      const noteWriterTokens = async () => {
        if (budget.snapshot().limits.maxTokens === undefined) return;
        try {
          const usageListed = await bb.sdk.threads.events.list({ threadId:input.writerThreadId, types:["thread/tokenUsage/updated"], order:"desc", limit:"50" });
          const usage = Array.isArray(usageListed) ? tokenUsageFromEvent(usageListed[0]) : null;
          if (usage) budget.noteTokens(usage.threadId, usage.totalTokens);
        } catch {
          // Usage is informational; a host that cannot list events does not fail the attempt.
        }
      };
      const stopRunningWriter = async (reason:string) => {
        const current = await getThreadBounded(input.writerThreadId).catch(() => null);
        const status = stringAt(current, "status");
        if (["active", "starting"].includes(status ?? "")) await bb.sdk.threads.stop({ threadId:input.writerThreadId }).catch(() => undefined);
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        closeWriterStages(db, {
          runId:input.runId, taskId:input.taskId, plan:getTaskPlan(db, input.taskId) ?? "",
          terminal:"failed", attempt:countAttempts(db, input.runId, input.taskId), reason, threadId:input.writerThreadId,
        });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      };
      // A continued thread is idle from its previous task until the new turn starts: wait for the turn sent after `since`.
      const followUpSince = await loadFollowUp(bb.storage.kv, input.attemptId);
      if (followUpSince !== null) {
        try {
          if (!watchBudget) {
            await waitThreadIdle(bb, input.writerThreadId, "writer_follow_up", undefined, followUpSince);
          } else {
            let waiting = true;
            const idle = waitThreadIdle(bb, input.writerThreadId, "writer_follow_up", undefined, followUpSince)
              .finally(() => { waiting = false; });
            while (waiting) {
              await noteWriterTokens();
              const budgetStop = runningWriterBudgetStop(budget.check());
              if (budgetStop) return await stopRunningWriter(budgetStop);
              await Promise.race([idle, new Promise((wake) => setTimeout(wake, 2_000))]);
            }
            await idle;
          }
        } catch (cause) {
          if (ctx.state.disposed) throw new Error("Lane Pilot was reloaded while the writer ran");
          const reason = cause instanceof Error ? cause.message : String(cause);
          transitionAttempt(db, input.attemptId, "provider_error", { reason });
          return { status:"provider_error", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
        }
      }
      // A writer runs as long as it works, unless the run's wall or token budget is gone; BB's events say when it has failed.
      let completedThread: unknown;
      for (;;) {
        if (ctx.state.disposed) throw new Error("Lane Pilot was reloaded while the writer ran");
        const pollStarted = Date.now();
        const currentThread = await getThreadBounded(input.writerThreadId);
        const currentStatus = stringAt(currentThread, "status");
        const listed = currentStatus === "idle" ? null : await listThreadEventsRaw(bb, { threadId:input.writerThreadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50" });
        const failure = currentStatus === "error" ? "writer thread status error" : listed?.ok ? threadFailure(listed.events) : null;
        if (failure) {
          transitionAttempt(db, input.attemptId, "provider_error", { reason:failure });
          if (["active", "starting"].includes(currentStatus ?? "")) await bb.sdk.threads.stop({ threadId:input.writerThreadId }).catch(() => undefined);
          return { status:"provider_error", reason:failure, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
        }
        if (currentStatus === "idle") {
          completedThread = currentThread;
          break;
        }
        if (watchBudget) {
          await noteWriterTokens();
          const budgetStop = runningWriterBudgetStop(budget.check());
          if (budgetStop) return await stopRunningWriter(budgetStop);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 2_000 - (Date.now() - pollStarted))));
      }
      const currentAttempt = getAttempt(db, input.attemptId);
      if (currentAttempt?.state === "cancel_requested" || currentAttempt?.state === "canceled") {
        if (currentAttempt.state === "cancel_requested") transitionAttempt(db, input.attemptId, "canceled", { threadId:input.writerThreadId, reason:"writer stop observed before validation" });
        return { status:"canceled", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      // A writer that stopped to ask the owner is not a failed attempt: no retry, no fallback, the question goes to the PM.
      const question = needsHumanQuestion(outputText(await bb.sdk.threads.output({ threadId:input.writerThreadId }).catch(() => "")));
      if (question) {
        const reason = `needs_human: ${question}`;
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
      const liveCritiquePolicy = frozenPolicy ?? parseCodeCritiqueSettings(loadProjectSettings(db,input.projectId,getRunSettingsScopes(db,input.runId)));
      const baselineHashes = Object.fromEntries(input.dirtBefore.map((row) => [row.path, row.sha256 || null]));
      const captureEvidence = async () => {
        const dirt = await services.workspaceDirt(input.config, input.task.project_cwd);
        const byPath = new Map((dirt.ok ? dirt.snapshots : []).map((row) => [row.path, row.sha256 || null]));
        const hashes = Object.fromEntries((candidate.produced ?? []).map((path) => [path, byPath.get(path) ?? null]));
        const files:Array<{ path:string; content:string|null }> = [];
        for (const path of candidate.produced ?? []) {
          const file = await bb.sdk.files.read({
            hostId:input.config.hostId, rootPath:input.task.project_cwd, path:resolve(input.task.project_cwd, path),
          }).catch(() => ({ content:null }));
          files.push({ path, content:typeof file.content === "string" ? file.content : null });
        }
        return buildCandidateEvidence({
          produced:candidate.produced ?? [],
          hashes,
          baselineHashes,
          files,
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
      if (liveCritiquePolicy.enabled) {
      for (;;) {
        const evidence = await captureEvidence();
        const ledger = repairLedgerFromResult(listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === "code-critique")?.result);
        if (ledger?.policy) frozenPolicy = ledger.policy;
        if (ledger?.repairRound) repairRound = Math.max(repairRound, ledger.repairRound);
        const disputes = repairRound > 0 ? parseWriterRepairReply(candidate.output) : null;
        if (disputes && disputes.replies.length > 0 && disputes.replies.every((row) => row.status === "disputed")) {
          const recritique = await runCodeCritique({
            bb, db, projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            config:input.config, task:input.task, evidence, disputes, frozenPolicy,
          });
          if (recritique.policy) frozenPolicy = recritique.policy;
          if (recritique.allowed) { review = recritique.review; approvedArtifact = evidence.artifactRevisionSha256; break; }
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
          config:input.config, task:input.task, evidence, frozenPolicy,
        });
        if (critique.policy) frozenPolicy = critique.policy;
        if (critique.allowed) { review = critique.review; approvedArtifact = evidence.artifactRevisionSha256; break; }
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
          const repairPrompt = codeRepairPrompt({
            task:input.task, findings:frozenFindings, agent:dispatch.agent,
            setupLines:WRITER_SETUP_LINES,
            contextBlocks:writerContextBlocks(input.task, dispatch.memoryText, dispatch.executionPacket, dispatch.pmReadContext, dispatch.rulesText ?? ""),
          });
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
            const sent = await Promise.resolve().then(() => bb.sdk.threads.send({ threadId:writerThreadId, mode:"queue-if-active",
              input:[{ type:"text", text:repairPrompt, mentions:[] }] } as never)).then(() => true, () => false);
            if (sent) { repairThreadId = writerThreadId; repairSentAt = sentAt; }
          }
          let spawned: unknown;
          if (!repairThreadId) try {
            spawned = await fullAccessSpawn(bb, {
              ...placement,
              ...requiredPolicyField(bb, helperPolicy, writerSnapshot.providerId, "code-repair"),
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
      if (confirm.truncated || !approvedArtifact || confirm.artifactRevisionSha256 !== approvedArtifact) {
        const reason = confirm.truncated
          ? `code_critique_evidence_unknown:${confirm.truncateReason ?? "truncated"}`
          : "code_critique_stale_revision";
        recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"code_critique_blocked",reason}});
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId };
      }
      }
      const receipt = await services.persistWriterAcceptance({
        config:input.config, task:input.task, runId:input.runId, taskId:input.taskId,
        attempt:countAttempts(db, input.runId, input.taskId), attemptId:input.attemptId,
        pmThreadId:input.pmThreadId, writerThreadId, output:candidate.output, verification:candidate.verification,
        emergencyFallback:input.emergencyFallback, review,
      });
      // Work in the attempt's own worktree counts only once it is in the run's base checkout (main).
      // A conflict fails the attempt, so the retry redoes the task on a fresh worktree of the new main.
      const bound = getAttempt(db, input.attemptId);
      const basePath = getRun(db, input.runId)?.writer_workspace_path;
      let integration: { status:string; commit:string|null; conflicts:string[] } | null = null;
      if (bound?.workspace_path && basePath && shouldMergeAttemptWorktree(bound.workspace_path, basePath)) {
        const integrate = () => host.call("gitIntegrate", {
          requestedHostId:input.config.hostId, basePath, worktreePath:bound.workspace_path!,
          message:`${input.task.id}: ${input.task.title}`.slice(0, 500),
          // Only Lane Pilot's own worktree (no BB environment) is removed; a BB managed one belongs to BB. An area task
          // keeps it for the area's next task (the attempt-worktree sweep removes it after the sticky window).
          removeWorktree:bound.environment_id === null && !input.task.area,
        }, { hostId:input.config.hostId, timeoutMs:180_000 });
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
            note:`Задача ${input.taskId} ждала слияния 15 минут: основную копию держит ${blockedBy.holderTaskId ?? "другая задача"}. Работа исполнителя закоммичена в его рабочем дереве; отправь задачу заново, когда держатель освободится.` })
            .catch((cause) => ctx.log(`merge-block reminder failed: ${cause instanceof Error ? cause.message : String(cause)}`));
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          return { status:"blocked", reason, blockedBy, attemptId:input.attemptId, writerThreadId };
        }
        // Someone's uncommitted edits in main block the merge: a redo would meet the same edits, so the finished work
        // waits for main to be clean and merges then (content-factory 2026-10-05: one task was rewritten three times).
        if (dirtyBase(merged)) {
          const files = merged.conflicts.join(", ");
          ctx.log(`writer ${input.taskId} waits for uncommitted edits in ${basePath} to be committed: ${files}`);
          // The chats that work in this folder are asked by name; the PM hears who was asked, or that nobody is known.
          const asked = await askGuestsToCommit(bb, basePath, merged.conflicts, input.taskId).catch(() => [] as string[]);
          void bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active", input:[{ type:"text", mentions:[],
            text:asked.length
              ? `Lane Pilot: задача ${input.taskId} готова, но в основной папке ${basePath} лежат незакоммиченные правки в тех же файлах: ${files}. Lane Pilot попросил закоммитить их чаты, которые работают в этой папке: ${asked.map((thread) => `@thread:${thread}`).join(", ")}. Задача вольётся сама, как только файлы будут закоммичены (ждёт до 2 часов); отправлять её заново не нужно.`
              : `Lane Pilot: задача ${input.taskId} готова, но в основной папке ${basePath} лежат чужие незакоммиченные правки в тех же файлах: ${files}. Чей это чат, Lane Pilot не знает: попроси владельца закоммитить или убрать их (или сделай это сам, если это работа этого чата). Задача вольётся сама, как только папка очистится (ждёт до 2 часов); отправлять её заново не нужно.` }] } as never).catch(() => undefined);
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
            return { status:"blocked", reason, blockedBy, attemptId:input.attemptId, writerThreadId };
          }
        }
        if (merged.status === "conflict" || merged.status === "failed") {
          const reason = merged.status === "conflict"
            ? `merge_conflict: ${merged.reason?.startsWith("base checkout") ? merged.reason : "main changed since this attempt started"}: ${merged.conflicts.join(", ")}`
            : `merge_failed: ${merged.reason ?? "unknown"}`;
          recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged}});
          transitionAttempt(db, input.attemptId, "validation_failed", { reason });
          return { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:candidate.verification,
            attemptId:input.attemptId, writerThreadId };
        }
        integration = { status:merged.status, commit:merged.commit, conflicts:[] };
        if (merged.status === "merged") void checkMainAfterMerge({ projectId:input.projectId, pmThreadId:input.pmThreadId, config:input.config,
          runId:input.runId, task:input.task, basePath, worktreePath:bound.workspace_path });
      }
      recordGateEvaluation(db,{projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"passed",
        attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{acceptanceReceiptPersisted:true,integration}});
      transitionAttempt(db, input.attemptId, "accepted");
      return { ...receipt, verification:candidate.verification, produced:candidate.produced };
    } catch (cause) {
      const thread = await getThreadBounded(input.writerThreadId);
      if (stringAt(thread, "status") === "error") {
        transitionAttempt(db, input.attemptId, "provider_error", { reason:cause instanceof Error ? cause.message : String(cause) });
        return { status:"provider_error", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      throw cause;
    }
  }

  /**
   * The task's checks again on main once it is merged: green alone, two tasks can break main together (merge queues
   * test the merged result). The work stays merged — nothing is thrown away — and a follow-up task makes main green
   * on top of it, so an agent repairs it rather than the owner or the PM. A follow-up that breaks main again is
   * reported to the PM instead of chaining.
   */
  async function checkMainAfterMerge(input:{ projectId:string; pmThreadId:string; config:Parameters<typeof services.runVerification>[0];
    runId:string; task:TaskV2; basePath:string; worktreePath:string }) {
    if (!input.task.verification.length || !input.pmThreadId || await isRunHalted(bb.storage.kv as never, input.runId)) return;
    const onBase = (cwd:string) => resolve(cwd).startsWith(resolve(input.worktreePath)) ? join(input.basePath, relative(input.worktreePath, cwd)) : cwd;
    const onMain = { ...input.task, project_cwd:input.basePath, verification:input.task.verification.map((command) => ({ ...command, cwd:onBase(command.cwd) })) };
    const checks = await services.runVerification(input.config, onMain, input.runId).catch((cause:unknown) => {
      ctx.log(`post-merge check of ${input.task.id} could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    });
    // A check whose host call failed says nothing about main: read as red, it dispatched a mainfix for a green main.
    const unrun = checks?.filter((check) => check.hostError) ?? [];
    if (unrun.length) ctx.log(`post-merge check of ${input.task.id} could not run on the host: ${unrun.map((check) => `${check.command} (${check.stderr.slice(0, 160)})`).join(", ")}`);
    const red = checks?.filter((check) => check.exitCode !== 0 && !check.hostError) ?? [];
    if (!red.length) return;
    const tail = (check:typeof red[number]) => `${check.stderr ?? ""}\n${check.stdout ?? ""}`.trim().slice(-1200);
    ctx.log(`post-merge check of ${input.task.id} failed on main: ${red.map((check) => check.command).join(", ")}`);
    const tell = (text:string) => bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active", input:[{ type:"text", text, mentions:[] }] } as never).catch(() => undefined);
    if (/-mainfix\d*$/.test(input.task.id)) {
      await tell(`Lane Pilot: ${input.task.id} fixed main once already and main is red again after it (${red[0]!.command}). Look at what else merged meanwhile and dispatch the fix yourself.`);
      return;
    }
    const fix:TaskV2 = { ...onMain, id:`${input.task.id}-mainfix`.slice(0, 128), title:`Make main green after ${input.task.id}`.slice(0, 200),
      depends_on:[], risk:input.task.risk === "low" ? "medium" : input.task.risk,
      objective:`Main is red after merging ${input.task.id} (${input.task.title}): ${red.map((check) => `\`${check.command}\``).join(", ")} fails on main while it passed in the task's own worktree, so it clashes with work merged meanwhile. Make the check pass on main keeping what ${input.task.id} and the work merged before it intended; change the least code that does it.`,
      acceptance:[...red.map((check) => `\`${check.command}\` passes on main`), `${input.task.id}'s acceptance still holds: ${input.task.acceptance.join("; ")}`.slice(0, 600)] };
    const plan = `Post-merge repair, dispatched by Lane Pilot. Failing on main:\n${red.map((check) => `$ ${check.command} (exit ${check.exitCode})\n${tail(check)}`).join("\n\n")}\n\nRead the failure, find which merged change clashes (git log -5 on main), fix within owns_paths, run the checks.`;
    const sent = await services.dispatchWriter({ threadId:input.pmThreadId, projectId:input.projectId, task:fix, plan }).catch((cause:unknown) => ({ state:"rejected", reason:cause instanceof Error ? cause.message : String(cause) }));
    await tell(`Lane Pilot: ${input.task.id} is merged, but ${red.map((check) => check.command).join(", ")} fails on main with it. The work stays in main; ${String(sent.state) === "rejected" || String(sent.state) === "blocked" ? `the repair task could not start (${String((sent as { reason?:unknown }).reason ?? sent.state)}), dispatch it yourself` : `repair task ${fix.id} is on its way — no action needed`}.`);
  }

  return { finishWriterAttempt };
}
