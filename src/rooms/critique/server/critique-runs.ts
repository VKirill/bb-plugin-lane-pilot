import { unownedExpectedOutputs } from "../../tasks";
import { hostContract, taskV2Schema } from "../../contracts";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { claimStageSpawn, countAttempts, getRun, getTask, getTaskPlan, listLiveTasksForRun, listOpenAttempts, listStageReceipts, openDatabase } from "../../storage";
import { criticAcrossFamilies, criticOffSpent, criticPairCandidates, effortAfterMove, latestWriterPair, pairApartFromWriter, pickCriticByAccuracy, roleSelection, sdkCriticCatalog, usable } from "../critic-pair";
import { criticStats } from "../critic-stats";
import {bbServiceTier, findModelIn, listedServiceTier, modelFamily, resolveStageWriterSelection, type SpentProbe, writerExecutionSelection, writerServiceTier} from "@lane-pilot/models";
import { spawnClaimed } from "../../contracts";
import { reconcileCritic } from "../../stability";
;
import { MAX_FILE_EXCERPT_BYTES } from "../code-critique";
import { codeCritiquePrompt, codeCritiqueSource, codeCritiqueStops, criticPersonas, critiqueFromStageResult, critiquePolicyFromResult, freezeCritiquePolicy, parseCodeCritique, parseCodeCritiqueSettings, persistLedgerFields, settingsFromFrozenPolicy, unionCriticFails } from "../code-critique";
import { critiqueFromScreen, screenCodeCritique } from "../critic-screen";
import type { CandidateEvidence, FrozenCritiquePolicy } from "../code-critique";
import { sha256 } from "../../tasks";
import { critiquePrompt, parseCritique, shouldRunPlanCritique } from "../critique";
import { ownerWordsOfRun } from "./owner-words";
import { binaryOutputs, dropIntendedGaps, findTaskPlaceholderPaths } from "../critique-coverage";
import type { CoverageFinding } from "../critique-coverage";
import { buildExecutionPacket } from "../../tasks/execution-packet";
import { parsePmReadResult, parsePmReadSettings, pmReadPrompt } from "../pm-read";
import { boundedAgentName } from "../../contracts/review-vocabulary";
import { candidateCitations } from "../citations";
import { parseSpecialistResult, shouldRunSpecialist, specialistPrompt, unreadableAnswer } from "../specialist";
import { helperExit, reasonForStatus } from "@lane-pilot/workflow-engine";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, resolveCodeCriticDefault, resolveQualityMode, withReferenceTestCritic } from "../../contracts/quality-mode";
import type { CodeCriticDefault } from "../../contracts/task-enums";
import type { Verdict, VerdictStatus } from "@lane-pilot/workflow-engine";
import { MAIN_ATTEMPT_LIMIT } from "../../contracts/state-machine";
import { GIT_PLUGIN_ID, gitCallRpc, gitFileSideReplySchema, gitFilesReplySchema, gitPatchKey, gitPatchesReplySchema, seenProviderLimit, setAsideOnStartFailure, spawnUsageOf, warmSpawnUsage, zcodeBusyPeek } from "../../platform/server";
import { configuredSetting } from "../../contracts/server";
import type { PluginCallRpc } from "../../platform/server";
export { setAsideOnStartFailure } from "../../platform/server";
import { fullAccessSpawn, graphStepMetadata } from "../../platform/server";
import { reviewerMemoryFor } from "../../memory/server";
import { clearSpawnMarker } from "../../platform/server";
import { CRITIC_OUTCOME_UNKNOWN, criticReconcilePort, helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { recordStage } from "../../runs/server";
import { settingOff, settingOn } from "@lane-pilot/models";
import { bestEffort, stringAt, orMiss, isNotFound } from "@lane-pilot/kit";
import { dependsOnTask } from "../../tasks";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StageHelperSettings } from "../../platform/server";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { resolve } from "node:path";
import { latestAttemptEnvironmentId } from "../../storage";
export { runPlanCritique } from "./critique-runs/plan-critique";
export { runPmRead } from "./critique-runs/pm-read";
import { readAnswer, readCodeCritique } from "./critique-runs/read-answer";
export { readAnswer, readCodeCritique } from "./critique-runs/read-answer";
import { attemptEnvironment } from "./critique-runs/attempt-diffs";
export { attemptEnvironment, candidatePatches, headSides } from "./critique-runs/attempt-diffs";
import { dependencyFindings } from "./critique-runs/dependency-findings";
export { dependencyFindings } from "./critique-runs/dependency-findings";
import { verdictReasons } from "./critique-runs/verdict-reasons";
import { limitProbe, logLimitMove } from "./critique-runs/limit-probe";






export async function runCodeCritique(input:{
  bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;stageHelperSettings:StageHelperSettings;taskId:string;
  config:PrototypeConfig;task:TaskV2;evidence:CandidateEvidence;disputes?:unknown;frozenPolicy?:FrozenCritiquePolicy;
  /** This task's `critic.code.default_for_risk` when the dispatch carried one; else the project's setting decides. */
  criticDefault?:CodeCriticDefault;
  /** The graph step the review runs inside (the `writer` node of the task's pipeline run): the critic's thread carries its ids. */
  workflow?:{runId:string;stepKey?:string;nodeId?:string};
}): Promise<{allowed:boolean;reason?:string;review:"passed"|"not_required";critique?:unknown;parsed?:ReturnType<typeof parseCodeCritique>;settings?:ReturnType<typeof parseCodeCritiqueSettings>;policy?:FrozenCritiquePolicy}> {
  // The code check on the critic's opinion: a finding's line must exist in the file the critic was shown.
  const cites = candidateCitations(input.evidence.files, MAX_FILE_EXCERPT_BYTES);
  const projectSettings = await input.stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  const qualityMode = resolveQualityMode(input.task,projectSettings[QUALITY_MODE_SETTING]);
  const settings = withReferenceTestCritic(applyCodeCriticDefault(applyQualityMode(projectSettings,qualityMode),qualityMode,input.task.risk,resolveCodeCriticDefault(projectSettings[CODE_CRITIC_DEFAULT_SETTING],input.criticDefault)), input.evidence.referenceTestEdits);
  const existing = listStageReceipts(input.db, input.runId, input.taskId).find((row) => row.stageId === "code-critique");
  const frozen = input.frozenPolicy ?? critiquePolicyFromResult(existing?.result);
  let parsed:ReturnType<typeof parseCodeCritiqueSettings>;
  try { parsed = frozen ? settingsFromFrozenPolicy(frozen) : parseCodeCritiqueSettings(settings); }
  catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { allowed:false, reason:`code_critique_policy_invalid:${reason}`, review:"not_required" };
  }
  const source = codeCritiqueSource({ evidence:input.evidence, task:input.task, agent:parsed.agent, disputes:input.disputes });
  const hashFields = {
    artifactRevisionSha256: input.evidence.artifactRevisionSha256,
    evidenceSha256: input.evidence.evidenceSha256,
    revisionSha256: input.evidence.artifactRevisionSha256,
  };
  const base = { runId:input.runId, taskId:input.taskId, stageId:"code-critique" as const, input:source };
  const ledgerCarry = persistLedgerFields(existing?.result);
  if (existing && existing.inputSha256 === sha256(source)) {
    if (existing.state === "passed" || existing.state === "skipped") {
      return { allowed:true, review:existing.state === "skipped" ? "not_required" : "passed", critique:existing.result, settings:parsed, policy:frozen ?? critiquePolicyFromResult(existing.result) };
    }
    // A failed_infra receipt is the critic's outage, not a verdict on the task: the same input runs the critique again.
    if (existing.state === "blocked" || (existing.state === "failed" && !existing.reason?.startsWith("failed_infra"))) {
      return {
        allowed:false, reason:existing.reason ?? "code_critique_blocked", review:"not_required",
        critique:existing.result, parsed:critiqueFromStageResult(existing.result), settings:parsed,
        policy:frozen ?? critiquePolicyFromResult(existing.result),
      };
    }
    if ((existing.state === "running" || existing.state === "pending") && existing.threadId) {
      try {
        await waitThreadIdle(input.bb,existing.threadId,"critique_thread_timeout");
        const raw = (await input.bb.sdk.threads.output({ threadId:existing.threadId })).output;
        if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
        const critique = await readCodeCritique(input.bb, existing.threadId, raw, cites);
        const blocked = codeCritiqueStops(parsed.mode, critique);
        const result = { ...ledgerCarry, ...critique, ...hashFields, mode:parsed.mode, rawOutput:raw.slice(0, 12_000), policy:frozen ?? critiquePolicyFromResult(existing.result) };
        recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId:existing.providerId, model:existing.model,
          threadId:existing.threadId, result, reason:blocked ? verdictReasons(critique,"code-critique").receipt : undefined });
        return blocked
          ? { allowed:false, reason:verdictReasons(critique,"code-critique").returned, critique:result, parsed:critique, settings:parsed, review:"not_required", policy:result.policy }
          : { allowed:true, critique:result, parsed:critique, settings:parsed, review:"passed", policy:result.policy };
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        recordStage(input.db, { ...base, state:"failed", threadId:existing.threadId, reason, result:{ ...ledgerCarry, error:reason, policy:frozen } });
        return { allowed:false, reason:`code_critique_failed:${reason}`, review:"not_required", settings:parsed };
      }
    }
    if (existing.state === "running" || existing.state === "pending") {
      const recovered = await reconcileCritic(criticReconcilePort(input.bb, input.projectId), {
        lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "code-critique", role: "code-critic",
      });
      if (recovered.kind === "found") {
        await clearSpawnMarker(input.bb, { role:"code-critic", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId, stageId:"code-critique" });
        recordStage(input.db, { ...base, state:"running", providerId:existing.providerId, model:existing.model,
          threadId:recovered.threadId, result:{ ...ledgerCarry, ...hashFields, spawnAttempted:true, policy:frozen ?? critiquePolicyFromResult(existing.result) } });
        try {
          await waitThreadIdle(input.bb,recovered.threadId,"critique_thread_timeout");
          const raw = (await input.bb.sdk.threads.output({ threadId:recovered.threadId })).output;
          if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
          const critique = await readCodeCritique(input.bb, recovered.threadId, raw, cites);
          const blocked = codeCritiqueStops(parsed.mode, critique);
          const result = { ...ledgerCarry, ...critique, ...hashFields, mode:parsed.mode, rawOutput:raw.slice(0, 12_000), policy:frozen ?? critiquePolicyFromResult(existing.result) };
          recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId:existing.providerId, model:existing.model,
            threadId:recovered.threadId, result, reason:blocked ? verdictReasons(critique,"code-critique").receipt : undefined });
          return blocked
            ? { allowed:false, reason:verdictReasons(critique,"code-critique").returned, critique:result, parsed:critique, settings:parsed, review:"not_required", policy:result.policy }
            : { allowed:true, critique:result, parsed:critique, settings:parsed, review:"passed", policy:result.policy };
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          recordStage(input.db, { ...base, state:"failed", threadId:recovered.threadId, reason, result:{ ...ledgerCarry, error:reason, policy:frozen } });
          return { allowed:false, reason:`code_critique_failed:${reason}`, review:"not_required", settings:parsed };
        }
      }
      if (recovered.kind !== "not_found" || spawnClaimed(existing.result) || existing.state === "running") {
        const claimed = spawnClaimed(existing.result);
        if (recovered.kind !== "not_found" || claimed) {
          const reason = recovered.kind === "error"
            ? `${CRITIC_OUTCOME_UNKNOWN}:${recovered.message}`
            : recovered.kind === "blocked"
              ? `${CRITIC_OUTCOME_UNKNOWN}:${recovered.reason}`
              : `${CRITIC_OUTCOME_UNKNOWN}: critic spawn claimed without threadId; no second critic`;
          recordStage(input.db, { ...base, state:"blocked", reason, result:{ ...ledgerCarry, ...hashFields, spawnAttempted:true, policy:frozen ?? critiquePolicyFromResult(existing.result) } });
          return { allowed:false, reason, review:"not_required", settings:parsed };
        }
        /* running, unclaimed, not_found: crash before spawn — continue to claim/spawn, never pending */
      }
    }
  }
  if (!(existing && existing.inputSha256 === sha256(source) && existing.state === "running")) {
    // A critic still running on an older revision of the candidate is stopped and its receipt starts over: running -> pending was
    // refused and parked a finished task as internal_error (selfystudio 2026-10-30, after a reload recaptured the evidence).
    const superseded = existing?.state === "running" && existing.inputSha256 !== sha256(source);
    if (superseded && existing.threadId) await bestEffort(input.bb.log, "critique thread stop", input.bb.sdk.threads.stop({ threadId: existing.threadId }), undefined);
    recordStage(input.db, { ...base, state:"pending", replaceOnNewInput:true, supersede:superseded, result:{ ...ledgerCarry, ...hashFields, truncated:input.evidence.truncated } });
  }
  // The role table's code-critic (packages/models/src/role-models.ts), else what the stage ran on before it (its selection, else the writer's).
  const stageSelection = resolveStageWriterSelection({
    settings, config:input.config, stageProviderKey:"code_critique.provider", stageModelKey:"code_critique.model",
  });
  const criticCatalog = sdkCriticCatalog(input.bb, input.config.hostId);
  const roleCritic = frozen ? null : await roleSelection({ zcodeBusy:zcodeBusyPeek(input.bb), catalog:criticCatalog, settings, role:"code-critic", fallback:{ providerId:stageSelection.providerId, model:stageSelection.model } });
  const liveSelection = roleCritic ? { providerId:roleCritic.providerId, model:roleCritic.model } : stageSelection;
  let configuredEffort = frozen?.reasoningEffort ?? roleCritic?.effort ?? (typeof settings["code_critique.reasoning_effort"] === "string"
    ? settings["code_critique.reasoning_effort"] as string
    : typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : "medium");
  const savedTier = frozen?.serviceTier ?? settings["code_critique.service_tier"];
  const criticTier = savedTier === "fast" || savedTier === "standard" ? savedTier : writerServiceTier(settings);
  const writerPair = frozen ? null : latestWriterPair(input.db, input.runId, input.taskId);
  // Cross-family rule: the critic is of another family than the writer's model (a frozen policy keeps the pair it began with).
  const across = frozen ? null : await criticAcrossFamilies({ critic:liveSelection, writer:writerPair, effort:configuredEffort, tier:criticTier, catalog:criticCatalog });
  if (across?.changed) input.bb.log.info(`code critic for ${input.taskId}: ${across.pair.providerId}/${across.pair.model}, the other family than the writer's ${writerPair?.providerId}/${writerPair?.model}`);
  // G9: another model than the writer's when the host has one (a frozen policy keeps the pair it began with).
  const apart = frozen ? null : await pairApartFromWriter({
    current:across?.pair ?? liveSelection, writer:writerPair,
    candidates:criticPairCandidates(settings, input.config), effort:configuredEffort,
    tier:criticTier, catalog:criticCatalog,
  });
  if (apart?.changed) input.bb.log.info(`code critic for ${input.taskId}: ${apart.pair.providerId}/${apart.pair.model} instead of the writer's own pair`);
  // The provider's limit comes last: a critic whose provider is nearly spent takes the other family, even the writer's (said, never silent).
  const offSpent = frozen ? null : await criticOffSpent({ critic:apart?.pair ?? across?.pair ?? liveSelection, writer:writerPair, spent:await limitProbe(input.bb, input.config.hostId, settings), effort:configuredEffort, tier:criticTier, catalog:criticCatalog });
  logLimitMove(input.bb, `code critic for ${input.taskId}`, offSpent?.issues);
  let providerId = frozen?.providerId ?? offSpent?.pair.providerId ?? apart?.pair.providerId ?? liveSelection.providerId;
  let modelId = frozen?.model ?? offSpent?.pair.model ?? apart?.pair.model ?? liveSelection.model;
  if (!frozen) {
    const byModel = criticStats(input.db, input.projectId, Date.now() - 30 * 86_400_000, ["code-critique"])[0]?.calibration.byModel ?? [];
    const ranked = pickCriticByAccuracy({ providerId, model: modelId }, criticPairCandidates(settings, input.config), byModel);
    if (ranked.changed) {
      try {
        const nextEffort = effortAfterMove("code-critic", { model: liveSelection.model, effort: configuredEffort }, ranked.pair);
        if (await usable(criticCatalog, ranked.pair, nextEffort, criticTier)) {
          input.bb.log.info(`code critic for ${input.taskId}: ${ranked.pair.providerId}/${ranked.pair.model} by accuracy; ${providerId}/${modelId} moves to the fallbacks`);
          providerId = ranked.pair.providerId;
          modelId = ranked.pair.model;
        }
      } catch { /* the pair the other rules chose still runs */ }
    }
  }
  // A Gemini critic that a family rule or a limit moved to GPT or Claude runs on the effort that judge had before the Gemini (high), not on the Gemini's medium.
  if (!frozen) configuredEffort = effortAfterMove("code-critic", { model:liveSelection.model, effort:configuredEffort }, { providerId, model:modelId });
  // The independence the rule promises is checked on the pair that will really run, after every fallback: not met is said, never silent (F4/R4).
  if (!frozen && writerPair && modelFamily(modelId) && modelFamily(modelId) === modelFamily(writerPair.model)) input.bb.log.warn(`code critic for ${input.taskId}: ${providerId}/${modelId} is of the writer's own family (${writerPair.providerId}/${writerPair.model}); the other family has no usable model here, so the review is not independent`);
  const policy = frozen ?? freezeCritiquePolicy({
    settings:parsed, providerId, model:modelId, reasoningEffort:configuredEffort,
    serviceTier:typeof savedTier === "string" && savedTier ? String(savedTier) : "standard",
  });
  // An unreadable produced file is a named hold: the critic cannot read it either, so in gate mode it blocks
  // acceptance; in advisory mode the critic still reviews the readable files.
  if (input.evidence.unreadablePaths?.length && parsed.mode === "gate") {
    const reason = `code_critique_evidence_unreadable:${input.evidence.unreadablePaths.join(",")}`;
    recordStage(input.db, { ...base, state:"blocked", reason, result:{ ...ledgerCarry, ...hashFields, unreadable:true, policy } });
    return { allowed:false, reason, review:"not_required", settings:parsed, policy };
  }
  if (!parsed.enabled) {
    recordStage(input.db, { ...base, state:"skipped", reason:qualityMode === "quick" ? "quality_mode_quick" : "disabled_by_project_setting", result:{ ...ledgerCarry, ...hashFields, policy } });
    return { allowed:true, review:"not_required", settings:parsed, policy };
  }
  // packet_truncated alone no longer blocks: the critic reads the listed paths itself (W33). An unreadable file
  // (unreadablePaths) also lets the critic run: it reviews the readable files, and gate mode blocked above.
  if (input.evidence.truncated && !(input.evidence.unreadPaths?.length || input.evidence.unreadablePaths?.length)) {
    const reason = `code_critique_evidence_unknown:${input.evidence.truncateReason ?? "truncated"}`;
    recordStage(input.db, { ...base, state:"skipped", reason, result:{ ...ledgerCarry, ...hashFields, truncated:true, policy } });
    return { allowed:true, reason, review:"not_required", settings:parsed, policy };
  }
  const screened = await screenCodeCritique(settings, { projectId: input.projectId, runId: input.runId, taskId: input.taskId, task: input.task, evidence: input.evidence });
  if (screened) {
    const critique = critiqueFromScreen(screened);
    const blocked = codeCritiqueStops(parsed.mode, critique);
    const result = { ...ledgerCarry, ...hashFields, ...critique, mode: parsed.mode, by: "jev", policy };
    // pending -> passed is refused: the screen's verdict goes through running (muse-release-030 parked as internal_error, 2026-11-03).
    recordStage(input.db, { ...base, state: "running", result });
    recordStage(input.db, { ...base, state: blocked ? "blocked" : "passed", result, reason: blocked ? verdictReasons(critique, "code-critique").receipt : undefined });
    return blocked
      ? { allowed: false, reason: verdictReasons(critique, "code-critique").returned, critique: result, parsed: critique, settings: parsed, review: "not_required", policy }
      : { allowed: true, critique: result, parsed: critique, settings: parsed, review: "passed", policy };
  }
  const snapshot = {
    ...ledgerCarry,
    // The carried repair ledger's spawnAttempted is about the repair writer of the previous round;
    // left in place it made claimStageSpawn refuse, so a repaired revision was never re-critiqued.
    spawnAttempted:false,
    ...hashFields,
    mode:parsed.mode, autoFix:parsed.autoFix, maxRounds:parsed.maxRounds,
    reviewer:{ providerId, model:modelId },
    policy,
  };
  recordStage(input.db, { ...base, state:"running", providerId, model:modelId, result:snapshot });
  let threadId:string|null = null;
  try {
    if (!claimStageSpawn(input.db, input.runId, input.taskId, "code-critique")) {
      const current = listStageReceipts(input.db, input.runId, input.taskId).find((row) => row.stageId === "code-critique");
      if (current?.threadId) {
        threadId = current.threadId;
        await waitThreadIdle(input.bb,threadId,"critique_thread_timeout");
        const raw = (await input.bb.sdk.threads.output({ threadId })).output;
        if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
        const critique = await readCodeCritique(input.bb, threadId, raw, cites);
        const blocked = codeCritiqueStops(parsed.mode, critique);
        const result = { ...snapshot, ...critique, policy, reviewer:{ providerId, model:modelId, reasoningEffort:configuredEffort, serviceTier: writerServiceTier(settings) === "fast" ? "fast" : "standard", mode:parsed.mode, maxRounds:parsed.maxRounds, autoFix:parsed.autoFix }, rawOutput:raw.slice(0, 12_000) };
        recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
          threadId, result, reason:blocked ? verdictReasons(critique,"code-critique").receipt : undefined });
        return blocked
          ? { allowed:false, reason:verdictReasons(critique,"code-critique").returned, critique:result, parsed:critique, settings:parsed, review:"not_required", policy }
          : { allowed:true, critique:result, parsed:critique, settings:parsed, review:"passed", policy };
      }
      const recovered = await reconcileCritic(criticReconcilePort(input.bb, input.projectId), {
        lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "code-critique", role: "code-critic",
      });
      if (recovered.kind === "found") {
        await clearSpawnMarker(input.bb, { role:"code-critic", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId, stageId:"code-critique" });
        recordStage(input.db, { ...base, state:"running", providerId, model:modelId, threadId:recovered.threadId, result:{ ...snapshot, spawnAttempted:true, threadId:recovered.threadId, policy } });
        threadId = recovered.threadId;
        await waitThreadIdle(input.bb,threadId,"critique_thread_timeout");
        const raw = (await input.bb.sdk.threads.output({ threadId })).output;
        if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
        const critique = await readCodeCritique(input.bb, threadId, raw, cites);
        const blocked = codeCritiqueStops(parsed.mode, critique);
        const result = { ...snapshot, ...critique, policy, rawOutput:raw.slice(0, 12_000) };
        recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
          threadId, result, reason:blocked ? verdictReasons(critique,"code-critique").receipt : undefined });
        return blocked
          ? { allowed:false, reason:verdictReasons(critique,"code-critique").returned, critique:result, parsed:critique, settings:parsed, review:"not_required", policy }
          : { allowed:true, critique:result, parsed:critique, settings:parsed, review:"passed", policy };
      }
      const reason = recovered.kind === "error"
        ? `${CRITIC_OUTCOME_UNKNOWN}:${recovered.message}`
        : recovered.kind === "blocked"
          ? `${CRITIC_OUTCOME_UNKNOWN}:${recovered.reason}`
          : `${CRITIC_OUTCOME_UNKNOWN}: critic spawn claimed without threadId; no second critic`;
      recordStage(input.db, { ...base, state:"blocked", providerId, model:modelId, reason, result:{ ...snapshot, spawnAttempted:true, policy } });
      return { allowed:false, reason, review:"not_required", settings:parsed, policy };
    }
    // The critic's own crash — an unreadable answer after the form retry, a thread that never settles, an unavailable
    // provider — is the critic's failure, not the task's: the role's next usable pair takes over, and when the pool is
    // spent the stage is marked failed_infra and the task goes on like with a disabled critic (hub 2026-10-30).
    const pairs: { providerId:string; model:string }[] = [{ providerId, model: modelId }];
    if (!frozen) {
      for (const candidate of criticPairCandidates(settings, input.config)) {
        if (pairs.length >= 3) break;
        if (pairs.some((pair) => pair.providerId === candidate.providerId && pair.model === candidate.model)) continue;
        try { if (await usable(criticCatalog, candidate, configuredEffort, criticTier)) pairs.push(candidate); } catch { /* unusable pairs are skipped */ }
      }
    }
    let lastError: string | null = null;
    for (const [round, pair] of pairs.entries()) {
      providerId = pair.providerId; modelId = pair.model;
      if (round) recordStage(input.db, { ...base, state:"running", providerId, model:modelId, result:{ ...snapshot, criticFallback:round, policy } });
      try {
        const [providers, catalog] = await Promise.all([
          input.bb.sdk.providers.list({ hostId:input.config.hostId }),
          input.bb.sdk.providers.models({ providerId, hostId:input.config.hostId }),
        ]);
        const provider = providers.find((row) => row.id === providerId && row.available);
        const model = findModelIn(catalog.models, modelId);
        if (!provider || !model) throw new Error("critique_provider_or_model_unavailable");
        const levels = model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
        if (!new Set<string>(levels).has(configuredEffort)) throw new Error(`critique_reasoning_effort_unsupported:${configuredEffort}`);
        const tier = savedTier === "fast" || savedTier === "standard" ? savedTier : writerServiceTier(settings);
        const serviceTier = listedServiceTier(provider, bbServiceTier(tier));
        if (serviceTier && !(provider.serviceTiers ?? []).some((item) => item.id === serviceTier)) {
          throw new Error(`critique_service_tier_unsupported:${serviceTier}`);
        }
        const helperPolicy = requireHelperSpawn(input);
        const placement = await helperChildPlacement({
          bb:input.bb, db:input.db, projectId:input.projectId, runId:input.runId, role:"code-critic", taskTitle:input.task.title,
        });
        const reviewerSnapshot = {
          providerId, model:modelId, reasoningEffort:configuredEffort,
          serviceTier:tier, mode:parsed.mode, maxRounds:parsed.maxRounds, autoFix:parsed.autoFix,
        };
        const personas = criticPersonas(input.task.risk);
        const critiques = [];
        const raws: string[] = [];
        for (const persona of personas) {
          const spawned = await fullAccessSpawn(input.bb, {
            ...placement,
            ...requiredPolicyField(input.bb, helperPolicy, providerId, "code-critic"),
            ...writerExecutionSelection(providerId, modelId, configuredEffort, serviceTier),
            prompt:codeCritiquePrompt({ evidence:input.evidence, task:input.task, agent:parsed.agent, disputes:input.disputes, memoryText:reviewerMemoryFor(input.db, input.projectId, input.runId, input.task), persona }),
            environment:attemptEnvironment(input.db, input.runId, input.taskId, input.task.project_cwd)
              ?? { type:"host", hostId:input.config.hostId, workspace:{ type:"unmanaged", path:input.task.project_cwd } },
            pluginMetadata:{ role:"code-critic", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
              stageId:"code-critique", parentPmThreadId:getRun(input.db, input.runId)?.pm_thread_id ?? null,
              revisionSha256:input.evidence.revisionSha256, helperMode:helperPolicy.mode,
              helperRequired:helperPolicy.policy?.required===true, reviewer:reviewerSnapshot, ...(persona ? { persona } : {}), ...graphStepMetadata(input.workflow) },
          });
          threadId = stringAt(spawned, "id");
          if (!threadId) throw new Error("critique_thread_id_missing");
          recordStage(input.db, { ...base, state:"running", providerId, model:modelId, threadId, result:{ ...snapshot, threadId, policy } });
          await waitThreadIdle(input.bb,threadId,"critique_thread_timeout");
          const raw = (await input.bb.sdk.threads.output({ threadId })).output;
          if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
          raws.push(raw);
          critiques.push(await readCodeCritique(input.bb, threadId, raw, cites));
        }
        const critique = unionCriticFails(critiques);
        const raw = raws.join("\n");
        const blocked = codeCritiqueStops(parsed.mode, critique);
        const result = { ...snapshot, ...critique, policy, reviewer:{ providerId, model:modelId, reasoningEffort:configuredEffort, serviceTier:tier, mode:parsed.mode, maxRounds:parsed.maxRounds, autoFix:parsed.autoFix }, rawOutput:raw.slice(0, 12_000) };
        recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
          threadId, result, reason:blocked ? verdictReasons(critique,"code-critique").receipt : undefined });
        return blocked
          ? { allowed:false, reason:verdictReasons(critique,"code-critique").returned, critique:result, parsed:critique, settings:parsed, review:"not_required", policy }
          : { allowed:true, critique:result, parsed:critique, settings:parsed, review:"passed", policy };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (threadId) {
          const thread = await orMiss(input.bb.sdk.threads.get({ threadId }), null, isNotFound);
          if (stringAt(thread, "status") === "active" || stringAt(thread, "status") === "starting") {
            await bestEffort(input.bb.log, "critique thread stop", input.bb.sdk.threads.stop({ threadId }), undefined);
          }
        }
        threadId = null;
        // The critic's own crash retries on the role's next pair: an answer that still does not read, a dead or empty
        // thread, the provider's own start error or an unusable pair. A host refusal or a bookkeeping error does not.
        const retryable = (cause instanceof Error && cause.name === "ZodError")
          || /critique_output_empty|critique_thread_timeout|critique_thread_id_missing|critique_provider_or_model_unavailable|critique_reasoning_effort_unsupported|critique_service_tier_unsupported|thread\.start failed|thread_failed/i.test(message);
        if (!retryable) throw cause;
        lastError = message;
      }
    }
    const infraReason = `failed_infra:${lastError ?? "critic pool exhausted"}`;
    recordStage(input.db, { ...base, state:"failed", providerId, model:modelId, reason:infraReason,
      result:{ ...ledgerCarry, ...hashFields, error:infraReason, criticPairs:pairs, policy } });
    return { allowed:true, reason:infraReason, review:"not_required", settings:parsed, policy };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (threadId) {
      const thread = await orMiss(input.bb.sdk.threads.get({ threadId }), null, isNotFound);
      if (stringAt(thread, "status") === "active" || stringAt(thread, "status") === "starting") {
        await bestEffort(input.bb.log, "critique thread stop", input.bb.sdk.threads.stop({ threadId }), undefined);
      }
    }
    setAsideOnStartFailure(input.bb, `code critique for ${input.taskId}`, providerId, modelId, reason);
    recordStage(input.db, { ...base, state:"failed", providerId, model:modelId, threadId, reason, result:{ ...ledgerCarry, error:reason, policy } });
    return { allowed:false, reason:`code_critique_failed:${reason}`, review:"not_required", settings:parsed, policy };
  }
}

export async function runSpecialistReview(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;stageHelperSettings:StageHelperSettings;taskId:string;config:PrototypeConfig;task:TaskV2;plan:string;workflow?:{runId:string;stepKey:string;nodeId:string};/** Set on the one rerun after the first pick's thread would not start. */afterStartFailure?:boolean})
  : Promise<{allowed:boolean;reason?:string;review?:unknown}> {
  const settings = await input.stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  const policy = shouldRunSpecialist({enabled:settings["specialist.enabled"],when:settings["specialist.when"],risk:input.task.risk});
  const agent=boundedAgentName(settings["specialist.agent"],"specialist-reviewer");
  const source = `${input.plan}\n\n${JSON.stringify(input.task)}\n\nagent=${agent}`;
  const base = {runId:input.runId,taskId:input.taskId,stageId:"specialist-review" as const,input:source};
  const kept = listStageReceipts(input.db,input.runId,input.taskId).find((row) => row.stageId === "specialist-review");
  if (kept?.state === "passed" && kept.inputSha256 === sha256(source)) return {allowed:true,review:kept.result};
  // An updated task goes through its review again over the receipt of the earlier contract (lane_pilot_update_task).
  // The rerun after a thread that would not start opens the stage it just recorded failed.
  recordStage(input.db,{...base,state:"pending",replaceOnNewInput:true,restart:true,reopen:input.afterStartFailure});
  if (!policy.run) {
    const failedPolicy = policy.reason?.startsWith("invalid_") || policy.reason?.startsWith("unsupported_");
    recordStage(input.db,{...base,state:failedPolicy ? "blocked" : "skipped",reason:policy.reason ?? undefined});
    return failedPolicy ? {allowed:false,reason:policy.reason ?? "specialist_policy_invalid"} : {allowed:true};
  }

  const legacy=resolveStageWriterSelection({settings,config:input.config,stageProviderKey:"specialist.provider",stageModelKey:"specialist.model"});
  const selection=await roleSelection({zcodeBusy:zcodeBusyPeek(input.bb),catalog:sdkCriticCatalog(input.bb,input.config.hostId),settings,role:"specialist-reviewer",fallback:{providerId:legacy.providerId,model:legacy.model},spent:await limitProbe(input.bb,input.config.hostId,settings)});
  logLimitMove(input.bb,`specialist review for ${input.taskId}`,selection.issues);
  const providerId=selection.providerId;
  const modelId=selection.model;
  const effort = selection.effort ?? (typeof settings["specialist.reasoning_effort"] === "string" && settings["specialist.reasoning_effort"]
    ? settings["specialist.reasoning_effort"] as string : "high");
  const savedTier = settings["specialist.service_tier"];
  const serviceTier = savedTier === "fast" ? "fast" : "standard";
  let threadId:string|null = null;
  recordStage(input.db,{...base,state:"running",providerId,model:modelId});
  try {
    const [providers,catalog] = await Promise.all([
      input.bb.sdk.providers.list({hostId:input.config.hostId}),
      input.bb.sdk.providers.models({providerId,hostId:input.config.hostId}),
    ]);
    const provider = providers.find((row) => row.id === providerId && row.available);
    const model = findModelIn(catalog.models, modelId);
    if (!provider || !model) throw new Error("specialist_provider_or_model_unavailable");
    if (!model.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) {
      throw new Error(`specialist_reasoning_effort_unsupported:${effort}`);
    }
    const tier = listedServiceTier(provider, bbServiceTier(serviceTier));
    if (tier && !(provider.serviceTiers ?? []).some((item) => item.id === tier)) throw new Error(`specialist_service_tier_unsupported:${tier}`);
    const helperPolicy=requireHelperSpawn(input);
    // An answer that does not read (magicseo T3.2, 2026-10-30: Gemini answered the rubric items {id,result,evidence} and no
    // status) is asked for again in the same thread (readAnswer); a second unreadable answer passes the task as the code
    // critic's failed_infra does, rather than blocking it on the reviewer's form. The receipt says the review did not run.
    const placement = await helperChildPlacement({
      bb:input.bb, db:input.db, projectId:input.projectId, runId:input.runId, role:"specialist-reviewer", taskTitle:input.task.title,
    });
    const spawned = await fullAccessSpawn(input.bb, {
      ...placement,
      ...requiredPolicyField(input.bb, helperPolicy, providerId, "specialist-reviewer"),
      ...writerExecutionSelection(providerId,modelId,effort,tier),
      prompt:specialistPrompt({task:input.task,plan:input.plan,agent}),
      environment:{type:"host",hostId:input.config.hostId,workspace:{type:"unmanaged",path:input.task.project_cwd}},
      pluginMetadata:{role:"specialist-reviewer",lanePilotRunId:input.runId,lanePilotTaskId:input.taskId,
        stageId:"specialist-review",parentPmThreadId:getRun(input.db,input.runId)?.pm_thread_id ?? null,
        helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true,...graphStepMetadata(input.workflow)},
    });
    threadId = stringAt(spawned,"id");
    if (!threadId) throw new Error("specialist_thread_id_missing");
    recordStage(input.db,{...base,state:"running",providerId,model:modelId,threadId});
    await waitThreadIdle(input.bb,threadId,"specialist_thread_timeout");
    const raw = (await input.bb.sdk.threads.output({threadId})).output;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("specialist_output_empty");
    let review;
    try {
      // Like the plan critic it may cite a file it opened, which the hub cannot see: file, line and quoted evidence are still required.
      review = await readAnswer(input.bb, threadId, raw, (text) => parseSpecialistResult(text), "status, summary, findings and evidence", "specialist_thread_timeout");
    } catch (cause) {
      if (!unreadableAnswer(cause)) throw cause;
      const reason = `failed_infra:specialist answer unreadable twice: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 600)}`;
      recordStage(input.db,{...base,state:"failed",providerId,model:modelId,threadId,reason,result:{error:reason}});
      return {allowed:true,reason};
    }
    const blocked = review.decision === "block";
    const why = verdictReasons(review, "specialist-review");
    recordStage(input.db,{...base,state:blocked ? "blocked" : "passed",providerId,model:modelId,threadId,
      result:{...review,rawOutput:raw.slice(0,12_000)},reason:blocked ? why.receipt : undefined});
    return blocked ? {allowed:false,reason:why.returned,review} : {allowed:true,review};
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (threadId) {
      const thread = await orMiss(input.bb.sdk.threads.get({threadId}), null, isNotFound);
      if (stringAt(thread,"status") === "active" || stringAt(thread,"status") === "starting") {
        await bestEffort(input.bb.log, "critique thread stop", input.bb.sdk.threads.stop({ threadId }), undefined);
      }
    }
    recordStage(input.db,{...base,state:"failed",providerId,model:modelId,threadId,reason,result:{error:reason}});
    // The provider is broken, not the plan: one more run, which picks the peer now that this pair is set aside.
    if (setAsideOnStartFailure(input.bb,`specialist review for ${input.taskId}`,providerId,modelId,reason) && !input.afterStartFailure) return runSpecialistReview({...input,afterStartFailure:true});
    return {allowed:false,reason:`specialist_review_failed:${reason}`};
  }
}

