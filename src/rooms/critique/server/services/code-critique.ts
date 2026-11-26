import { claimStageSpawn, getRun, listStageReceipts, noteTaskFileRead, openDatabase, planSourcePaths, readTaskFile, resolveTaskFile, taskHomeOf, taskPlanDbCopy, writeReplacing, type TaskFileIo } from "../../../storage";
import { criticAcrossFamilies, criticOffSpent, criticPairCandidates, effortAfterMove, pairApartFromWriter, pickCriticByAccuracy, roleSelection, usable } from "../../models/critic-pair";
import { latestWriterPair } from "../repositories/critic-pair-repository";
import { sdkCriticCatalog } from "./critic-catalog";
import { criticStats } from "./critic-stats";
import { modelFamily, resolveStageWriterSelection, writerServiceTier } from "@lane-pilot/models";
import { spawnClaimed } from "../../../contracts";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import { reconcileCritic } from "../../../stability";
import { MAX_FILE_EXCERPT_BYTES } from "../../models/candidate-evidence";
import type { CandidateEvidence } from "../../models/candidate-evidence";
import { codeCritiquePrompt } from "../../code-critique-prompt";
import { codeCritiqueSource, codeCritiqueStops, criticPersonas, critiqueFromStageResult, parseCodeCritique, parseCodeCritiqueSettings, unionCriticFails } from "../../models/code-critique";
import type { CritiqueTaskContext } from "../../models/code-critique";
import { critiquePolicyFromResult, freezeCritiquePolicy, persistLedgerFields, settingsFromFrozenPolicy } from "../../models/code-critique-ledger";
import type { FrozenCritiquePolicy } from "../../models/code-critique-ledger";
import { criticLevel, pathsWidenedOf } from "../../models/critic-level";
import { sha256 } from "../../../tasks/server";
import { candidateCitations } from "../../models/citations";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, resolveCodeCriticDefault, resolveQualityMode, withReferenceTestCritic } from "../../../contracts/quality-mode";
import type { CodeCriticDefault } from "../../../contracts/task-enums";
import { clearSpawnMarker, graphStepMetadata, setAsideOnStartFailure, zcodeBusyPeek } from "../../../platform/server";
import type { StageHelperSettings } from "../../../platform/server";
import { reviewerMemoryFor } from "../../../memory/server";
import { CRITIC_OUTCOME_UNKNOWN, criticReconcilePort, recordStage } from "../../../runs/server";
import { bestEffort, sha256Hex, orMiss, isNotFound } from "@lane-pilot/kit";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { limitProbe, logLimitMove } from "./limit-probe";
import { verdictReasons } from "../../models/verdict-reasons";
import { readCodeCritique } from "./read-answer";
import { attemptEnvironment } from "./attempt-diffs";
import { verifySeriousFindings } from "./verify-findings";
import type { VerifierOutcome } from "./verify-findings";
import { parseVerifierAnswer, seriousFindings } from "../../models/code-verifier";
import type { JudgeVerdict } from "../../models/judge-verdict";
import { parseJudgeVerdict } from "../../models/judge-verdict";
import { logJudgeVerdict, runJudge } from "./judge-runner";

const codeCritiqueVerdict = (critique: ReturnType<typeof parseCodeCritique>): JudgeVerdict =>
  critique.status ?? (critique.decision === "approve" ? "pass" : "rework");

type CodeCritiqueReturn = { allowed: boolean; reason?: string; review: "passed" | "not_required"; critique?: unknown; parsed?: ReturnType<typeof parseCodeCritique>; settings?: ReturnType<typeof parseCodeCritiqueSettings>; policy?: FrozenCritiquePolicy };

async function settleExistingCodeCritiqueThread(input: {
  bb: BbPluginApi; db: ReturnType<typeof openDatabase>; base: { runId: string; taskId: string; stageId: "code-critique"; input: string };
  threadId: string; providerId?: string | null; model?: string | null; cites: ReturnType<typeof candidateCitations>;
  parsed: ReturnType<typeof parseCodeCritiqueSettings>; policy?: FrozenCritiquePolicy; resultBase: Record<string, unknown>; reviewer?: Record<string, unknown>;
}): Promise<CodeCritiqueReturn> {
  const startMs = Date.now();
  await waitThreadIdle(input.bb, input.threadId, "critique_thread_timeout");
  const raw = (await input.bb.sdk.threads.output({ threadId: input.threadId })).output;
  if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
  const critique = await readCodeCritique(input.bb, input.threadId, raw, input.cites);
  logJudgeVerdict(input.bb, "code-critic", codeCritiqueVerdict(critique), startMs);
  const blocked = codeCritiqueStops(input.parsed.mode, critique);
  const result = { ...input.resultBase, ...critique, ...(input.reviewer ? { reviewer: input.reviewer } : {}), rawOutput: raw.slice(0, 12_000), policy: input.policy };
  recordStage(input.db, { ...input.base, state: blocked ? "blocked" : "passed", providerId: input.providerId, model: input.model, threadId: input.threadId, result, reason: blocked ? verdictReasons(critique, "code-critique").receipt : undefined });
  return blocked
    ? { allowed: false, reason: verdictReasons(critique, "code-critique").returned, critique: result, parsed: critique, settings: input.parsed, review: "not_required", policy: input.policy }
    : { allowed: true, critique: result, parsed: critique, settings: input.parsed, review: "passed", policy: input.policy };
}

/**
 * The task home's plan-source snapshot for the code critic, resolved through the manifest like every other stage (docs/task-folder.md).
 * The shared `.agents/plans/*` files the plan names are not in the attempt checkout: the critic gets the snapshot's repo path and its
 * content hash goes into the stage input, so a rewritten snapshot re-runs the critique. A task on the old layout gets no context and its
 * input is unchanged. A homed task whose plan names shared files the snapshot does not cover — or whose snapshot cannot be read — is a
 * named block, never a silent pass on the shared path that is not there.
 */
export async function codeCritiqueTaskContext(bb: BbPluginApi, db: ReturnType<typeof openDatabase>, taskId: string): Promise<{ context?: CritiqueTaskContext; blockReason?: string }> {
  const home = taskHomeOf(db, taskId);
  if (!home) return {};
  const io: TaskFileIo = {
    read: async (absPath) => {
      const file = await orMiss(Promise.resolve().then(() => bb.sdk.files.read({ hostId: home.host_id, rootPath: home.base_path, path: absPath })), null, isNotFound);
      const content = file && typeof file === "object" ? (file as { content?: unknown }).content : null;
      return typeof content === "string" ? content : null;
    },
    write: async (absPath, content) => {
      await writeReplacing(bb.sdk.files, { hostId: home.host_id, rootPath: home.base_path, path: absPath, content, createParents: true });
    },
  };
  const contractRow = resolveTaskFile(db, taskId, "contract");
  if (contractRow) {
    const contractRead = await readTaskFile(db, io, { taskId, kind: "contract", reader: "code-critique" }).catch(() => null);
    if (!contractRead) {
      noteTaskFileRead(db, { taskId, path: contractRow.path, kind: "contract", reader: "code-critique:db-copy", sha256: contractRow.sha256, legacy: false });
    }
  }
  const researchRow = resolveTaskFile(db, taskId, "research");
  if (researchRow) {
    await readTaskFile(db, io, { taskId, kind: "research", reader: "code-critique" }).catch(() => null);
  }
  const plan = resolveTaskFile(db, taskId, "plan");
  const planRead = plan ? await readTaskFile(db, io, { taskId, kind: "plan", reader: "code-critique" }) : null;
  // A PLAN.md unreadable on its host yields to the dispatch-saved copy under the manifest row's hash — the same rule stagePlanText applies.
  let planText = planRead?.text ?? null;
  if (plan && !planRead) {
    const copy = taskPlanDbCopy(db, taskId, plan.sha256);
    if (copy !== null) {
      noteTaskFileRead(db, { taskId, path: plan.path, kind: "plan", reader: "code-critique:db-copy", sha256: plan.sha256, legacy: false });
      planText = copy;
    }
  }
  if (plan && planText === null) return { blockReason: `code_critique_plan_unreadable:${plan.repoPath}` };
  const refs = planText === null ? [] : planSourcePaths(planText, home.base_path);
  const snapshot = resolveTaskFile(db, taskId, "plan-source");
  if (!snapshot) {
    return refs.length ? { blockReason: `code_critique_plan_source_missing:${refs.join(",")}` } : {};
  }
  const source = await readTaskFile(db, io, { taskId, kind: "plan-source", reader: "code-critique" });
  if (!source) return { blockReason: `code_critique_plan_source_unreadable:${snapshot.repoPath}` };
  const head = source.text.split("\n## ")[0] ?? "";
  const covered = new Set([...head.matchAll(/source_path: (.+)/g)].map((match) => match[1]!.trim()));
  const missing = refs.filter((ref) => !covered.has(ref));
  if (missing.length) return { blockReason: `code_critique_plan_source_missing:${missing.join(",")}` };
  return { context: { planSource: { path: source.repoPath, sha256: source.sha256 ?? sha256Hex(source.text) } } };
}

export async function runCodeCritique(input: {
  bb: BbPluginApi; db: ReturnType<typeof openDatabase>; projectId: string; runId: string; stageHelperSettings: StageHelperSettings; taskId: string;
  config: PrototypeConfig; task: TaskV2; evidence: CandidateEvidence; disputes?: unknown; frozenPolicy?: FrozenCritiquePolicy;
  /** This task's `critic.code.default_for_risk` when the dispatch carried one; else the project's setting decides. */
  criticDefault?: CodeCriticDefault;
  /** The graph step the review runs inside (the `writer` node of the task's pipeline run): the critic's thread carries its ids. */
  workflow?: { runId: string; stepKey?: string; nodeId?: string };
  /** Sends the verifier's prompt to a pair and returns its answer (tests pass a fake; the default starts a read-only helper thread). */
  verifierRun?: (prompt: string, pair: { providerId: string; model: string }) => Promise<string>;
}): Promise<{ allowed: boolean; reason?: string; review: "passed" | "not_required"; critique?: unknown; parsed?: ReturnType<typeof parseCodeCritique>; settings?: ReturnType<typeof parseCodeCritiqueSettings>; policy?: FrozenCritiquePolicy }> {
  // The code check on the critic's opinion: a finding's line must exist in the file the critic was shown.
  const cites = candidateCitations(input.evidence.files, MAX_FILE_EXCERPT_BYTES);
  const projectSettings = await input.stageHelperSettings(input.bb, input.db, input.projectId, input.runId);
  const qualityMode = resolveQualityMode(input.task, projectSettings[QUALITY_MODE_SETTING]);
  const riskSettings = withReferenceTestCritic(applyCodeCriticDefault(applyQualityMode(projectSettings, qualityMode), qualityMode, input.task.risk, resolveCodeCriticDefault(projectSettings[CODE_CRITIC_DEFAULT_SETTING], input.criticDefault)), input.evidence.referenceTestEdits);
  // The critic's level by rule (critic-level.ts): strict runs it in gate mode, skip leaves a named receipt, normal is the settings above.
  // A project that turned the critic off itself keeps that; quality_mode full or a project that turned it on never skips.
  const level = criticLevel({ taskId: input.taskId, kind: input.task.kind, risk: input.task.risk, paths: input.evidence.files.map((file) => file.path),
    checks: input.evidence.verification, referenceTestEdits: input.evidence.referenceTestEdits, repoScope: input.task.repo_scope === true,
    pathsWidened: await pathsWidenedOf(input.bb.storage.kv as never, input.runId, input.taskId),
    pinned: qualityMode === "full" || projectSettings["code_critique.enabled"] === true });
  const settings = level.tier === "strict" && projectSettings["code_critique.enabled"] !== false
    ? { ...riskSettings, "code_critique.enabled": true, "code_critique.mode": "gate" } : riskSettings;
  const existing = listStageReceipts(input.db, input.runId, input.taskId).find((row) => row.stageId === "code-critique");
  const frozen = input.frozenPolicy ?? critiquePolicyFromResult(existing?.result);
  let parsed: ReturnType<typeof parseCodeCritiqueSettings>;
  try { parsed = frozen ? settingsFromFrozenPolicy(frozen) : parseCodeCritiqueSettings(settings); }
  catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { allowed: false, reason: `code_critique_policy_invalid:${reason}`, review: "not_required" };
  }
  const taskHome = await codeCritiqueTaskContext(input.bb, input.db, input.taskId);
  const source = codeCritiqueSource({ evidence: input.evidence, task: input.task, agent: parsed.agent, context: taskHome.context });
  const hashFields = {
    artifactRevisionSha256: input.evidence.artifactRevisionSha256,
    evidenceSha256: input.evidence.evidenceSha256,
    revisionSha256: input.evidence.artifactRevisionSha256,
  };
  const base = { runId: input.runId, taskId: input.taskId, stageId: "code-critique" as const, input: source };
  const ledgerCarry = persistLedgerFields(existing?.result);
  if (existing && existing.inputSha256 === sha256(source)) {
    if (existing.state === "passed" || existing.state === "skipped") {
      return { allowed: true, review: existing.state === "skipped" ? "not_required" : "passed", critique: existing.result, settings: parsed, policy: frozen ?? critiquePolicyFromResult(existing.result) };
    }
    // A failed_infra receipt is the critic's outage, not a verdict on the task: the same input runs the critique again.
    if (existing.state === "blocked" || (existing.state === "failed" && !existing.reason?.startsWith("failed_infra"))) {
      return {
        allowed: false, reason: existing.reason ?? "code_critique_blocked", review: "not_required",
        critique: existing.result, parsed: critiqueFromStageResult(existing.result), settings: parsed,
        policy: frozen ?? critiquePolicyFromResult(existing.result),
      };
    }
    if ((existing.state === "running" || existing.state === "pending") && existing.threadId) {
      try {
        return await settleExistingCodeCritiqueThread({ bb: input.bb, db: input.db, base, threadId: existing.threadId, providerId: existing.providerId, model: existing.model, cites, parsed, policy: frozen ?? critiquePolicyFromResult(existing.result), resultBase: { ...ledgerCarry, ...hashFields, mode: parsed.mode } });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        recordStage(input.db, { ...base, state: "failed", threadId: existing.threadId, reason, result: { ...ledgerCarry, error: reason, policy: frozen } });
        return { allowed: false, reason: `code_critique_failed:${reason}`, review: "not_required", settings: parsed };
      }
    }
    if (existing.state === "running" || existing.state === "pending") {
      const recovered = await reconcileCritic(criticReconcilePort(input.bb, input.projectId), { lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "code-critique", role: "code-critic" });
      if (recovered.kind === "found") {
        await clearSpawnMarker(input.bb, { role: "code-critic", lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "code-critique" });
        const recoveredPolicy = frozen ?? critiquePolicyFromResult(existing.result);
        recordStage(input.db, { ...base, state: "running", providerId: existing.providerId, model: existing.model, threadId: recovered.threadId, result: { ...ledgerCarry, ...hashFields, spawnAttempted: true, policy: recoveredPolicy } });
        try {
          return await settleExistingCodeCritiqueThread({ bb: input.bb, db: input.db, base, threadId: recovered.threadId, providerId: existing.providerId, model: existing.model, cites, parsed, policy: recoveredPolicy, resultBase: { ...ledgerCarry, ...hashFields, mode: parsed.mode } });
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          recordStage(input.db, { ...base, state: "failed", threadId: recovered.threadId, reason, result: { ...ledgerCarry, error: reason, policy: frozen } });
          return { allowed: false, reason: `code_critique_failed:${reason}`, review: "not_required", settings: parsed };
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
          recordStage(input.db, { ...base, state: "blocked", reason, result: { ...ledgerCarry, ...hashFields, spawnAttempted: true, policy: frozen ?? critiquePolicyFromResult(existing.result) } });
          return { allowed: false, reason, review: "not_required", settings: parsed };
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
    recordStage(input.db, { ...base, state: "pending", replaceOnNewInput: true, supersede: superseded, result: { ...ledgerCarry, ...hashFields, truncated: input.evidence.truncated } });
  }
  // The role table's code-critic (packages/models/src/role-models.ts), else what the stage ran on before it (its selection, else the writer's).
  const stageSelection = resolveStageWriterSelection({
    settings, config: input.config, stageProviderKey: "code_critique.provider", stageModelKey: "code_critique.model",
  });
  const criticCatalog = sdkCriticCatalog(input.bb, input.config.hostId);
  const roleCritic = frozen ? null : await roleSelection({ zcodeBusy: zcodeBusyPeek(input.bb), catalog: criticCatalog, settings, role: "code-critic", fallback: { providerId: stageSelection.providerId, model: stageSelection.model } });
  const liveSelection = roleCritic ? { providerId: roleCritic.providerId, model: roleCritic.model } : stageSelection;
  let configuredEffort = frozen?.reasoningEffort ?? roleCritic?.effort ?? (typeof settings["code_critique.reasoning_effort"] === "string"
    ? settings["code_critique.reasoning_effort"] as string
    : typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : "medium");
  const savedTier = frozen?.serviceTier ?? settings["code_critique.service_tier"];
  const criticTier = savedTier === "fast" || savedTier === "standard" ? savedTier : writerServiceTier(settings);
  const writerPair = frozen ? null : latestWriterPair(input.db, input.runId, input.taskId);
  // Cross-family rule: the critic is of another family than the writer's model (a frozen policy keeps the pair it began with).
  const across = frozen ? null : await criticAcrossFamilies({ critic: liveSelection, writer: writerPair, effort: configuredEffort, tier: criticTier, catalog: criticCatalog });
  if (across?.changed) input.bb.log.info(`code critic for ${input.taskId}: ${across.pair.providerId}/${across.pair.model}, the other family than the writer's ${writerPair?.providerId}/${writerPair?.model}`);
  // G9: another model than the writer's when the host has one (a frozen policy keeps the pair it began with).
  const apart = frozen ? null : await pairApartFromWriter({
    current: across?.pair ?? liveSelection, writer: writerPair,
    candidates: criticPairCandidates(settings, input.config), effort: configuredEffort,
    tier: criticTier, catalog: criticCatalog,
  });
  if (apart?.changed) input.bb.log.info(`code critic for ${input.taskId}: ${apart.pair.providerId}/${apart.pair.model} instead of the writer's own pair`);
  // The provider's limit comes last: a critic whose provider is nearly spent takes the other family, even the writer's (said, never silent).
  const offSpent = frozen ? null : await criticOffSpent({ critic: apart?.pair ?? across?.pair ?? liveSelection, writer: writerPair, spent: await limitProbe(input.bb, input.config.hostId, settings), effort: configuredEffort, tier: criticTier, catalog: criticCatalog });
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
  if (!frozen) configuredEffort = effortAfterMove("code-critic", { model: liveSelection.model, effort: configuredEffort }, { providerId, model: modelId });
  // The independence the rule promises is checked on the pair that will really run, after every fallback: not met is said, never silent (F4/R4).
  if (!frozen && writerPair && modelFamily(modelId) && modelFamily(modelId) === modelFamily(writerPair.model)) input.bb.log.warn(`code critic for ${input.taskId}: ${providerId}/${modelId} is of the writer's own family (${writerPair.providerId}/${writerPair.model}); the other family has no usable model here, so the review is not independent`);
  const policy = frozen ?? freezeCritiquePolicy({
    settings: parsed, providerId, model: modelId, reasoningEffort: configuredEffort,
    serviceTier: typeof savedTier === "string" && savedTier ? String(savedTier) : "standard",
  });
  // An unreadable produced file is a named hold: the critic cannot read it either, so in gate mode it blocks
  // acceptance; in advisory mode the critic still reviews the readable files.
  if (input.evidence.unreadablePaths?.length && parsed.mode === "gate") {
    const reason = `code_critique_evidence_unreadable:${input.evidence.unreadablePaths.join(",")}`;
    recordStage(input.db, { ...base, state: "blocked", reason, result: { ...ledgerCarry, ...hashFields, unreadable: true, policy } });
    return { allowed: false, reason, review: "not_required", settings: parsed, policy };
  }
  if (!parsed.enabled) {
    recordStage(input.db, { ...base, state: "skipped", reason: qualityMode === "quick" ? "quality_mode_quick" : "disabled_by_project_setting", result: { ...ledgerCarry, ...hashFields, policy } });
    return { allowed: true, review: "not_required", settings: parsed, policy };
  }
  // packet_truncated alone no longer blocks: the critic reads the listed paths itself (W33). An unreadable file
  // (unreadablePaths) also lets the critic run: it reviews the readable files, and gate mode blocked above.
  if (input.evidence.truncated && !(input.evidence.unreadPaths?.length || input.evidence.unreadablePaths?.length)) {
    const reason = `code_critique_evidence_unknown:${input.evidence.truncateReason ?? "truncated"}`;
    recordStage(input.db, { ...base, state: "blocked", reason, result: { ...ledgerCarry, ...hashFields, truncated: true, policy } });
    return { allowed: false, reason, review: "not_required", settings: parsed, policy };
  }
  if (level.tier === "skip" && !frozen) {
    const reason = `critic_level_skip:${level.reason}`;
    recordStage(input.db, { ...base, state: "skipped", reason, result: { ...ledgerCarry, ...hashFields, criticLevel: level, policy } });
    return { allowed: true, reason, review: "not_required", settings: parsed, policy };
  }
  // A homed task whose manifest-listed plan-source snapshot is missing or unreadable fails closed before any critic spawn.
  if (taskHome.blockReason) {
    recordStage(input.db, { ...base, state: "blocked", reason: taskHome.blockReason, result: { ...ledgerCarry, ...hashFields, policy } });
    return { allowed: false, reason: taskHome.blockReason, review: "not_required", settings: parsed, policy };
  }
  const snapshot = {
    ...ledgerCarry,
    // The carried repair ledger's spawnAttempted is about the repair writer of the previous round;
    // left in place it made claimStageSpawn refuse, so a repaired revision was never re-critiqued.
    spawnAttempted: false,
    ...hashFields,
    mode: parsed.mode, autoFix: parsed.autoFix, maxRounds: parsed.maxRounds,
    reviewer: { providerId, model: modelId },
    criticLevel: level,
    policy,
  };
  recordStage(input.db, { ...base, state: "running", providerId, model: modelId, result: snapshot });
  let threadId: string | null = null;
  try {
    if (!claimStageSpawn(input.db, input.runId, input.taskId, "code-critique")) {
      const current = listStageReceipts(input.db, input.runId, input.taskId).find((row) => row.stageId === "code-critique");
      if (current?.threadId) {
        threadId = current.threadId;
        return await settleExistingCodeCritiqueThread({
          bb: input.bb,
          db: input.db,
          base,
          threadId,
          providerId,
          model: modelId,
          cites,
          parsed,
          policy,
          resultBase: snapshot,
          reviewer: { providerId, model: modelId, reasoningEffort: configuredEffort, serviceTier: writerServiceTier(settings) === "fast" ? "fast" : "standard", mode: parsed.mode, maxRounds: parsed.maxRounds, autoFix: parsed.autoFix },
        });
      }
      const recovered = await reconcileCritic(criticReconcilePort(input.bb, input.projectId), {
        lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "code-critique", role: "code-critic",
      });
      if (recovered.kind === "found") {
        await clearSpawnMarker(input.bb, { role: "code-critic", lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "code-critique" });
        recordStage(input.db, { ...base, state: "running", providerId, model: modelId, threadId: recovered.threadId, result: { ...snapshot, spawnAttempted: true, threadId: recovered.threadId, policy } });
        threadId = recovered.threadId;
        return await settleExistingCodeCritiqueThread({
          bb: input.bb,
          db: input.db,
          base,
          threadId,
          providerId,
          model: modelId,
          cites,
          parsed,
          policy,
          resultBase: snapshot,
        });
      }
      const reason = recovered.kind === "error"
        ? `${CRITIC_OUTCOME_UNKNOWN}:${recovered.message}`
        : recovered.kind === "blocked"
          ? `${CRITIC_OUTCOME_UNKNOWN}:${recovered.reason}`
          : `${CRITIC_OUTCOME_UNKNOWN}: critic spawn claimed without threadId; no second critic`;
      recordStage(input.db, { ...base, state: "blocked", providerId, model: modelId, reason, result: { ...snapshot, spawnAttempted: true, policy } });
      return { allowed: false, reason, review: "not_required", settings: parsed, policy };
    }
    // The critic's own crash — an unreadable answer after the form retry, a thread that never settles, an unavailable
    // provider — is the critic's failure, not the task's: the role's next usable pair takes over, and when the pool is
    // spent the stage is marked failed_infra and the task goes on like with a disabled critic (hub 2026-10-30).
    const pairs: { providerId: string; model: string }[] = [{ providerId, model: modelId }];
    if (!frozen) {
      for (const candidate of criticPairCandidates(settings, input.config)) {
        if (pairs.length >= 3) break;
        if (pairs.some((pair) => pair.providerId === candidate.providerId && pair.model === candidate.model)) continue;
        try { if (await usable(criticCatalog, candidate, configuredEffort, criticTier)) pairs.push(candidate); } catch { /* unusable pairs are skipped */ }
      }
    }
    const tier = savedTier === "fast" || savedTier === "standard" ? savedTier : writerServiceTier(settings);
    const environment = attemptEnvironment(input.db, input.runId, input.taskId, input.task.project_cwd)
      ?? { type: "host" as const, hostId: input.config.hostId, workspace: { type: "unmanaged" as const, path: input.task.project_cwd } };
    const personas = criticPersonas(input.task.risk);
    const parentPmThreadId = getRun(input.db, input.runId)?.pm_thread_id ?? null;
    const critiqueRun = await runJudge<ReturnType<typeof parseCodeCritique>>({
      bb: input.bb, db: input.db, projectId: input.projectId, runId: input.runId, hostId: input.config.hostId,
      role: "code-critic", taskTitle: input.task.title, pairs, effort: configuredEffort, tier,
      errorPrefix: "critique", timeoutCode: "critique_thread_timeout", environment,
      onAttemptStart: ({ round, pair }) => {
        providerId = pair.providerId; modelId = pair.model; threadId = null;
        if (round) recordStage(input.db, { ...base, state: "running", providerId, model: modelId, result: { ...snapshot, criticFallback: round, policy } });
      },
      onThreadSpawned: ({ threadId: spawnedId, pair }) => {
        threadId = spawnedId;
        recordStage(input.db, { ...base, state: "running", providerId: pair.providerId, model: pair.model, threadId: spawnedId, result: { ...snapshot, threadId: spawnedId, policy } });
      },
      // The critic's own crash retries on the role's next pair: an answer that still does not read, a dead or empty
      // thread, the provider's own start error or an unusable pair. A host refusal or a bookkeeping error does not.
      isRetryable: (cause, message) => (cause instanceof Error && cause.name === "ZodError")
        || /critique_output_empty|critique_thread_timeout|critique_thread_id_missing|critique_provider_or_model_unavailable|critique_reasoning_effort_unsupported|critique_service_tier_unsupported|thread\.start failed|thread_failed/i.test(message),
      stepsForRound: ({ pair, helperPolicy }) => {
        const reviewerSnapshot = { providerId: pair.providerId, model: pair.model, reasoningEffort: configuredEffort, serviceTier: tier, mode: parsed.mode, maxRounds: parsed.maxRounds, autoFix: parsed.autoFix };
        return personas.map((persona) => ({
          prompt: codeCritiquePrompt({ evidence: input.evidence, task: input.task, agent: parsed.agent, memoryText: reviewerMemoryFor(input.db, input.projectId, input.runId, input.task), persona, context: taskHome.context, ...(level.tier === "strict" ? { focus: level.reason } : {}) }),
          pluginMetadata: { role: "code-critic", lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "code-critique", parentPmThreadId, revisionSha256: input.evidence.revisionSha256, helperMode: helperPolicy.mode, helperRequired: helperPolicy.policy?.required === true, reviewer: reviewerSnapshot, ...(persona ? { persona } : {}), ...graphStepMetadata(input.workflow) },
          parse: (tid, raw) => readCodeCritique(input.bb, tid, raw, cites),
        }));
      },
      toVerdict: (results) => codeCritiqueVerdict(unionCriticFails(results)),
    });
    if (critiqueRun.status === "exhausted") {
      const infraReason = `failed_infra:${critiqueRun.lastError || "critic pool exhausted"}`;
      recordStage(input.db, { ...base, state: "failed", providerId, model: modelId, reason: infraReason, result: { ...ledgerCarry, ...hashFields, error: infraReason, criticPairs: pairs, policy } });
      return { allowed: false, reason: infraReason, review: "not_required", settings: parsed, policy };
    }
    providerId = critiqueRun.pair.providerId;
    modelId = critiqueRun.pair.model;
    threadId = critiqueRun.threadIds[critiqueRun.threadIds.length - 1] ?? threadId;
    let critique = unionCriticFails(critiqueRun.results);
    const raw = critiqueRun.raws.join("\n");
    // A strict critique that stops on a critical or high finding gets one independent look at those findings by a model of another family.
    let verifier: VerifierOutcome | null = null;
    if (level.tier === "strict") {
      const askedIds = seriousFindings(critique).map((finding) => finding.id);
      const checked = await verifySeriousFindings({
        critique, critic: { providerId, model: modelId }, effort: configuredEffort, tier, catalog: criticCatalog, task: input.task, workspace: input.task.project_cwd,
        run: input.verifierRun ?? (async (prompt, peerPair) => {
          const vRun = await runJudge({
            bb: input.bb, db: input.db, projectId: input.projectId, runId: input.runId, hostId: input.config.hostId,
            role: "code-verifier", policyRole: "code-critic", taskTitle: input.task.title, pairs: [peerPair],
            effort: configuredEffort, tier, checkEffort: false, coerceUnsupportedTier: true, errorPrefix: "verifier",
            timeoutCode: "critique_thread_timeout", stopLabel: "verifier thread stop", placement: critiqueRun.placement,
            helperPolicy: critiqueRun.helperPolicy, environment,
            stepsForRound: ({ helperPolicy: hp }) => [{ prompt, pluginMetadata: { role: "code-critic", lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "code-critique-verifier", parentPmThreadId, helperMode: hp.mode, helperRequired: hp.policy?.required === true, verifier: true, ...graphStepMetadata(input.workflow) } }],
            toVerdict: (_results, raws) => parseJudgeVerdict({ output: raws[0], parse: (text) => parseVerifierAnswer(text, askedIds), toVerdict: (verdicts) => (verdicts.some((item) => item.verdict === "refuted") ? "rework" : "pass") }).verdict,
          });
          if (vRun.status !== "ok") throw new Error(vRun.lastError);
          return vRun.raws[0]!;
        }),
      });
      critique = checked.critique;
      verifier = checked.outcome;
    }
    const blocked = codeCritiqueStops(parsed.mode, critique);
    const result = { ...snapshot, ...critique, ...(verifier ? { verifier } : {}), policy, reviewer: { providerId, model: modelId, reasoningEffort: configuredEffort, serviceTier: tier, mode: parsed.mode, maxRounds: parsed.maxRounds, autoFix: parsed.autoFix }, rawOutput: raw.slice(0, 12_000) };
    recordStage(input.db, { ...base, state: blocked ? "blocked" : "passed", providerId, model: modelId, threadId, result, reason: blocked ? verdictReasons(critique, "code-critique").receipt : undefined });
    return blocked
      ? { allowed: false, reason: verdictReasons(critique, "code-critique").returned, critique: result, parsed: critique, settings: parsed, review: "not_required", policy }
      : { allowed: true, critique: result, parsed: critique, settings: parsed, review: "passed", policy };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    setAsideOnStartFailure(input.bb, `code critique for ${input.taskId}`, providerId, modelId, reason);
    recordStage(input.db, { ...base, state: "failed", providerId, model: modelId, threadId, reason, result: { ...ledgerCarry, error: reason, policy } });
    return { allowed: false, reason: `code_critique_failed:${reason}`, review: "not_required", settings: parsed, policy };
  }
}
