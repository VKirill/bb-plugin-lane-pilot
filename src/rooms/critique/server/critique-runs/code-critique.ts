import { claimStageSpawn, getRun, listStageReceipts, openDatabase } from "../../../storage";
import { criticAcrossFamilies, criticOffSpent, criticPairCandidates, effortAfterMove, latestWriterPair, pairApartFromWriter, pickCriticByAccuracy, roleSelection, sdkCriticCatalog, usable } from "../../critic-pair";
import { criticStats } from "../../critic-stats";
import { bbServiceTier, findModelIn, listedServiceTier, modelFamily, resolveStageWriterSelection, writerExecutionSelection, writerServiceTier } from "@lane-pilot/models";
import { spawnClaimed } from "../../../contracts";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import { reconcileCritic } from "../../../stability";
import { MAX_FILE_EXCERPT_BYTES } from "../../code-critique";
import { codeCritiquePrompt, codeCritiqueSource, codeCritiqueStops, criticPersonas, critiqueFromStageResult, critiquePolicyFromResult, freezeCritiquePolicy, parseCodeCritique, parseCodeCritiqueSettings, persistLedgerFields, settingsFromFrozenPolicy, unionCriticFails } from "../../code-critique";
import { criticLevel } from "../../critic-level";
import type { CandidateEvidence, FrozenCritiquePolicy } from "../../code-critique";
import { sha256 } from "../../../tasks";
import { candidateCitations } from "../../citations";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, resolveCodeCriticDefault, resolveQualityMode, withReferenceTestCritic } from "../../../contracts/quality-mode";
import type { CodeCriticDefault } from "../../../contracts/task-enums";
import { clearSpawnMarker, graphStepMetadata, setAsideOnStartFailure, zcodeBusyPeek } from "../../../platform/server";
import type { StageHelperSettings } from "../../../platform/server";
import { reviewerMemoryFor } from "../../../memory/server";
import { CRITIC_OUTCOME_UNKNOWN, criticReconcilePort, helperChildPlacement, recordStage, requireHelperSpawn, requiredPolicyField } from "../../../runs/server";
import { fullAccessSpawn } from "../../../platform/server";
import { bestEffort, stringAt, orMiss, isNotFound } from "@lane-pilot/kit";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { limitProbe, logLimitMove } from "./limit-probe";
import { verdictReasons } from "./verdict-reasons";
import { readCodeCritique } from "./read-answer";
import { attemptEnvironment } from "./attempt-diffs";
import { verifySeriousFindings } from "./verify-findings";
import type { VerifierOutcome } from "./verify-findings";

export async function runCodeCritique(input:{
  bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;stageHelperSettings:StageHelperSettings;taskId:string;
  config:PrototypeConfig;task:TaskV2;evidence:CandidateEvidence;disputes?:unknown;frozenPolicy?:FrozenCritiquePolicy;
  /** This task's `critic.code.default_for_risk` when the dispatch carried one; else the project's setting decides. */
  criticDefault?:CodeCriticDefault;
  /** The graph step the review runs inside (the `writer` node of the task's pipeline run): the critic's thread carries its ids. */
  workflow?:{runId:string;stepKey?:string;nodeId?:string};
  /** Sends the verifier's prompt to a pair and returns its answer (tests pass a fake; the default starts a read-only helper thread). */
  verifierRun?:(prompt:string,pair:{providerId:string;model:string})=>Promise<string>;
}): Promise<{allowed:boolean;reason?:string;review:"passed"|"not_required";critique?:unknown;parsed?:ReturnType<typeof parseCodeCritique>;settings?:ReturnType<typeof parseCodeCritiqueSettings>;policy?:FrozenCritiquePolicy}> {
  // The code check on the critic's opinion: a finding's line must exist in the file the critic was shown.
  const cites = candidateCitations(input.evidence.files, MAX_FILE_EXCERPT_BYTES);
  const projectSettings = await input.stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  const qualityMode = resolveQualityMode(input.task,projectSettings[QUALITY_MODE_SETTING]);
  const riskSettings = withReferenceTestCritic(applyCodeCriticDefault(applyQualityMode(projectSettings,qualityMode),qualityMode,input.task.risk,resolveCodeCriticDefault(projectSettings[CODE_CRITIC_DEFAULT_SETTING],input.criticDefault)), input.evidence.referenceTestEdits);
  // The critic's level by rule (critic-level.ts): strict runs it in gate mode, skip leaves a named receipt, normal is the settings above.
  // A project that turned the critic off itself keeps that; quality_mode full or a project that turned it on never skips.
  const level = criticLevel({ taskId:input.taskId, kind:input.task.kind, risk:input.task.risk, paths:input.evidence.files.map((file) => file.path),
    checks:input.evidence.verification, referenceTestEdits:input.evidence.referenceTestEdits,
    pinned:qualityMode === "full" || projectSettings["code_critique.enabled"] === true });
  const settings = level.tier === "strict" && projectSettings["code_critique.enabled"] !== false
    ? { ...riskSettings, "code_critique.enabled":true, "code_critique.mode":"gate" } : riskSettings;
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
  if (level.tier === "skip" && !frozen) {
    const reason = `critic_level_skip:${level.reason}`;
    recordStage(input.db, { ...base, state:"skipped", reason, result:{ ...ledgerCarry, ...hashFields, criticLevel:level, policy } });
    return { allowed:true, reason, review:"not_required", settings:parsed, policy };
  }
  const snapshot = {
    ...ledgerCarry,
    // The carried repair ledger's spawnAttempted is about the repair writer of the previous round;
    // left in place it made claimStageSpawn refuse, so a repaired revision was never re-critiqued.
    spawnAttempted:false,
    ...hashFields,
    mode:parsed.mode, autoFix:parsed.autoFix, maxRounds:parsed.maxRounds,
    reviewer:{ providerId, model:modelId },
    criticLevel:level,
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
            prompt:codeCritiquePrompt({ evidence:input.evidence, task:input.task, agent:parsed.agent, disputes:input.disputes, memoryText:reviewerMemoryFor(input.db, input.projectId, input.runId, input.task), persona, ...(level.tier === "strict" ? { focus:level.reason } : {}) }),
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
        let critique = unionCriticFails(critiques);
        const raw = raws.join("\n");
        // A strict critique that stops on a critical or high finding gets one independent look at those findings by a model of another family.
        let verifier: VerifierOutcome | null = null;
        if (level.tier === "strict") {
          const verifierThread: { id: string | null } = { id: null };
          const checked = await verifySeriousFindings({
            critique, critic:{ providerId, model:modelId }, effort:configuredEffort, tier, catalog:criticCatalog, task:input.task, workspace:input.task.project_cwd,
            run: input.verifierRun ?? (async (prompt, pair) => {
              const [providers, models] = await Promise.all([input.bb.sdk.providers.list({ hostId:input.config.hostId }), input.bb.sdk.providers.models({ providerId:pair.providerId, hostId:input.config.hostId })]);
              const peerProvider = providers.find((row) => row.id === pair.providerId && row.available);
              if (!peerProvider || !findModelIn(models.models, pair.model)) throw new Error("verifier_provider_or_model_unavailable");
              const peerTier = listedServiceTier(peerProvider, bbServiceTier(tier));
              const started = await fullAccessSpawn(input.bb, {
                ...placement,
                ...requiredPolicyField(input.bb, helperPolicy, pair.providerId, "code-critic"),
                ...writerExecutionSelection(pair.providerId, pair.model, configuredEffort, peerTier && (peerProvider.serviceTiers ?? []).some((item) => item.id === peerTier) ? peerTier : null),
                prompt,
                environment:attemptEnvironment(input.db, input.runId, input.taskId, input.task.project_cwd)
                  ?? { type:"host", hostId:input.config.hostId, workspace:{ type:"unmanaged", path:input.task.project_cwd } },
                pluginMetadata:{ role:"code-critic", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId, stageId:"code-critique-verifier",
                  parentPmThreadId:getRun(input.db, input.runId)?.pm_thread_id ?? null, helperMode:helperPolicy.mode, helperRequired:helperPolicy.policy?.required===true, verifier:true, ...graphStepMetadata(input.workflow) },
              });
              verifierThread.id = stringAt(started, "id");
              if (!verifierThread.id) throw new Error("verifier_thread_id_missing");
              try {
                await waitThreadIdle(input.bb, verifierThread.id, "critique_thread_timeout");
                const answer = (await input.bb.sdk.threads.output({ threadId:verifierThread.id })).output;
                if (typeof answer !== "string" || !answer.trim()) throw new Error("verifier_output_empty");
                return answer;
              } catch (cause) {
                const thread = await orMiss(input.bb.sdk.threads.get({ threadId:verifierThread.id }), null, isNotFound);
                if (stringAt(thread, "status") === "active" || stringAt(thread, "status") === "starting") await bestEffort(input.bb.log, "verifier thread stop", input.bb.sdk.threads.stop({ threadId:verifierThread.id }), undefined);
                throw cause;
              }
            }),
          });
          critique = checked.critique;
          verifier = checked.outcome;
        }
        const blocked = codeCritiqueStops(parsed.mode, critique);
        const result = { ...snapshot, ...critique, ...(verifier ? { verifier } : {}), policy, reviewer:{ providerId, model:modelId, reasoningEffort:configuredEffort, serviceTier:tier, mode:parsed.mode, maxRounds:parsed.maxRounds, autoFix:parsed.autoFix }, rawOutput:raw.slice(0, 12_000) };
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
