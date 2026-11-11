import { breakerKey, RunBudgetExceeded } from "@lane-pilot/resilience";
import { normalizeModel, openTokenCursor } from "../../usage/server";
import { STATE_MACHINE_VERSION } from "../../contracts";
import { writerKnowledge } from "./writer-knowledge";
import { HARNESS_VERSION, endSpawnFailure, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, loadProjectSettings, saveReasoningTrace, setAttemptDirtBefore, setReasoningThread, transitionAttempt, taskBasePath, TRANSITION_KEY } from "../../storage";
import { automaticEffortRoutingEnabled, bbServiceTier, resolveJevReasoning, writerExecutionSelection, writerServiceTier, findModelIn, switchWord } from "@lane-pilot/models";
import { retargetTask } from "../../tasks";
import { parseMemorySettings } from "../../memory";
import { resolveRetryEffort } from "../../critique";
import { LIVE_FOLDER_REASON, isLiveDecision } from "../live-folder";
import { createLiveFolder } from "./live-folder";
import { createWriterSkillPick } from "./skill-pick";
import { createSkillMaterializer } from "./skill-materialize";
import { parseWorkspaceMode, createProviderGate, resolveAttemptWorkspace } from "../../verification";
import { HELPER_DISALLOWED_TOOLS, WRITER_MAX_TURNS } from "../../native-agent";
import { WriterSelectionError, coreHostsRequiredProvider } from "../../runs/server";
import { within } from "../../platform/server";
import { stringAt, bestEffort, isNotFound, orMiss } from "@lane-pilot/kit";
import { configuredSetting } from "../../contracts/server";
import { planDigest } from "./writer-task";
import { areaHistoryText, loadArea } from "./sticky";
import { resolve } from "node:path";
import type { ServerCore } from "../../contracts/server";

import type { HarnessApi } from "../../harness/server/harness";
import type { OwnerPresenceApi } from "../../owner-presence/server/presence";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { RuleScanApi } from "../../self-repair/server/rule-scan";
import type { ReconcileApi } from "../../stability/server/reconcile";
import type { WriterStateApi } from "./state";
import type { SpawnInput, SpawnResult } from "./spawn-types";
import { createSpawnWorktree } from "./spawn-worktree";
import { buildWriterLaunch } from "./spawn-brief";
import { spawnWriterAttemptWatched, startSteps } from "./spawn-watchdog";

export { isProjectRootCheckout, shouldMergeAttemptWorktree, worktreeCreateError } from "./spawn-probe";
export { START_STALL_MS } from "./spawn-watchdog";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  harness: HarnessApi;
  ownerPresence: OwnerPresenceApi;
  providerBreaker: WriterStateApi["providerBreaker"];
  reconcileAttemptThread: ReconcileApi["reconcileAttemptThread"];
  recoverLostHolderThread: ReconcileApi["recoverLostHolderThread"];
  rollback: RollbackApi;
  ruleScan: RuleScanApi;
}

/** How long the pair whose launch was refused for a provider swap is held out of the writer chain. */
const LAUNCH_PARITY_HOLD_MS = 30 * 60_000;
const LAUNCH_PARITY_READ_MS = 2_000;

export function createWriterSpawn(ctx: ServerCore, services: Services) {
  const { bb, db, effectiveProjectSettings, host } = ctx;
  const liveFolder = createLiveFolder(ctx);
  const skillPick = createWriterSkillPick(ctx);
  const skillMaterial = createSkillMaterializer(ctx, (message) => bb.log.info(message));
  const providerGate = createProviderGate({ kv:bb.storage.kv, serialized:(work) => ctx.serializedKv(work), version:HARNESS_VERSION, warn:(message) => bb.log.warn(message) });
  const worktree = createSpawnWorktree({ bb, db, host, liveFolder, providerGate, services });

  async function spawnWriterAttemptOnce(input: SpawnInput): Promise<SpawnResult> {
    let selectedProviderId:string|null=null;
    let selectedModel:string|null=null;
    let lastExecution:{reasoningLevel:string;serviceTier:"default"|"fast"|null;selectionSource:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"}}|null=null;
    transitionAttempt(db, input.attemptId, "spawn_requested");
    const at=(step:string)=>startSteps.set(input.attemptId,step);
    at("settings");
    // A half-open trial this attempt reserved and has not handed to a running writer (2026-10-29 audit A-034).
    let unusedTrial: { key: string; token: number } | null = null;
    let writerHoldsTrial = false;
    try {
      // The stored settings with the start's writer choice on top: before this every Jev pick that differed from the project's writer
      // was dropped here (Vampirism Fire 2026-10-25/26: picks gemini-flash, sonnet, sonnet, haiku all ran as composer-2.5).
      const settings = { ...(await effectiveProjectSettings(input.projectId,getRunSettingsScopes(db,input.runId))).values, ...(input.writerSettings ?? {}) };
      // F-01: files outside the contract become read-only in the attempt's worktree (writer.owns_barrier).
      const ownsBarrier = configuredSetting(settings,"writer.owns_barrier") !== "off";
      const workspaceMode = parseWorkspaceMode(settings["adoc.040"]);
      // Old saved adoc.041 / adoc.042 still load. They do not choose the worktree (resolveAttemptWorkspace).
      const minScoreValue = settings["adoc.041"];
      const minScore = minScoreValue === undefined || minScoreValue === null || minScoreValue === "" ? 4 : Number(minScoreValue);
      const multiWriteEnabled = settings["adoc.042"] === undefined ? true : settings["adoc.042"] === true || settings["adoc.042"] === 1 || settings["adoc.042"] === "true";
      // Every writer attempt, of a native Lane chat or a dispatched task of any risk, gets its own worktree (in_place is
      // gone, decision 2026-10-06): parallel writers never share a checkout, and acceptance merges each one into main.
      const nativeRun = getRun(db, input.runId)?.kind === "cli";
      const routed = resolveAttemptWorkspace({mode:workspaceMode,risk:input.task.risk,
        expectedOutputCount:input.task.expected_outputs.length,minScore,multiWriteEnabled});
      // A folder without git has no worktree to give: the writer edits the live files in the run's folder.
      const live = await liveFolder.isLiveFolder(input.runId,input.config.hostId,taskBasePath(db,input.runId,input.taskId) ?? input.task.project_cwd);
      const workspaceDecision = live ? {...routed,strategy:"inherit_run" as const,reason:LIVE_FOLDER_REASON as typeof routed.reason} : routed;
      const sourcePreflight=await worktree.workspaceDirt(input.config,input.task.project_cwd,input.runId);
      if(!sourcePreflight.ok) throw new WriterSelectionError(`attempt_workspace_snapshot_failed:${sourcePreflight.reason}`);
      let dirtBefore=sourcePreflight.snapshots;
      const memorySettings=parseMemorySettings(settings);
      // The rules that apply and the notes that name this task's paths (writer-knowledge.ts, shared with the turn that continues a thread and the memory probe).
      const memoryRoot=taskBasePath(db,input.runId,input.taskId)??input.task.project_cwd;
      const readBytes=async(relativePath:string)=>{
        if(relativePath.split("/").includes("..")) return null;
        const file=await orMiss(bb.sdk.files.read({hostId:input.config.hostId,rootPath:memoryRoot,path:resolve(memoryRoot,relativePath)}), null, isNotFound);
        const content=file&&typeof file==="object"?(file as {content?:unknown}).content:null;
        return typeof content==="string"?new TextEncoder().encode(content):null;
      };
      at("knowledge");
      const knowledge=await writerKnowledge({db,host,chainForRun:(runId)=>services.ruleScan.chainForRun(runId),log:(line)=>bb.log.warn(line),kv:bb.storage.kv as never},
        {projectId:input.projectId,runId:input.runId,hostId:input.config.hostId,task:input.task,memorySettings,readBytes});
      const { mixed, similar }=knowledge;
      // A fresh writer of an area hears what its earlier tasks decided, in place of the thread that remembered it.
      const areaHistory=input.task.area?areaHistoryText(await loadArea(bb.storage.kv,input.projectId,input.task.area)):"";
      const relevantMemory={text:[areaHistory,mixed.text,similar].filter(Boolean).join("\n\n")};
      const writerProviderId = input.emergency?.providerId ?? (typeof settings["writer.provider"] === "string"
        ? settings["writer.provider"] as string : input.config.writerProviderId);
      const writerModel = input.emergency?.model ?? (typeof settings["writer.model"] === "string" && settings["writer.model"]
        ? settings["writer.model"] as string : input.config.writerModel);
      selectedProviderId=writerProviderId;
      selectedModel=writerModel;
      if (!input.emergency) {
        const trialKey = breakerKey(writerProviderId, writerModel);
        const gate = services.providerBreaker.decide(trialKey);
        if (!gate.allow) {
          const reason = `writer_provider_unavailable:breaker_open:${gate.reason}`;
          return { ok:false, status:endSpawnFailure(db, input.attemptId, reason), reason, attemptId:input.attemptId };
        }
        if (gate.state === "half_open") unusedTrial = { key: trialKey, token: gate.trialToken };
        // The owner is at the keyboard on this provider (src/rooms/owner-presence): the writer chain takes the next one.
        const present = services.ownerPresence?.holds(writerProviderId) ?? null;
        if (present) {
          const reason = `writer_provider_unavailable:${present}`;
          return { ok:false, status:endSpawnFailure(db, input.attemptId, reason), reason, attemptId:input.attemptId };
        }
      }
      // The core cannot host this provider under the PM's session policy: the chain takes the next writer instead of a 500.
      if (!coreHostsRequiredProvider(bb, writerProviderId)) {
        const reason = `writer_provider_unavailable:core_unsupported:${writerProviderId}`;
        return { ok:false, status:endSpawnFailure(db, input.attemptId, reason), reason, attemptId:input.attemptId };
      }
      const requestedServiceTier = input.emergency ? "default" as const : bbServiceTier(writerServiceTier(settings));
      let providers:Awaited<ReturnType<typeof bb.sdk.providers.list>>;
      let catalog:Awaited<ReturnType<typeof bb.sdk.providers.models>>;
      try {
        [providers, catalog] = await Promise.all([
          bb.sdk.providers.list({ hostId:input.config.hostId }),
          bb.sdk.providers.models({ providerId:writerProviderId, hostId:input.config.hostId }),
        ]);
      } catch {
        throw new WriterSelectionError("writer_live_catalog_unavailable");
      }
      const provider = providers.find((row) => row.id === writerProviderId);
      if (!provider?.available) throw new WriterSelectionError(`writer_provider_unavailable:${writerProviderId}`);
      const model = findModelIn(catalog.models, writerModel);
      if (!model) throw new WriterSelectionError(`writer_model_unavailable:${writerProviderId}/${writerModel}`);
      const tierIds = new Set(provider.serviceTiers?.map((tier) => tier.id) ?? []);
      // «fast» is a speed wish, not a condition: a writer whose provider has no fast tier runs on its default tier
      // (2026-11-07: a fallback to Antigravity was refused for «fast» and the lead's skill task was blocked).
      const effectiveServiceTier = tierIds.has(requestedServiceTier) ? requestedServiceTier : null;
      const manual = input.emergency
        ? (input.emergency.reasoningLevel && model.supportedReasoningEfforts.some((item) => item.reasoningEffort === input.emergency!.reasoningLevel) ? input.emergency.reasoningLevel
          : model.supportedReasoningEfforts.some((item) => item.reasoningEffort === "low") ? "low" : model.supportedReasoningEfforts[0]?.reasoningEffort ?? "medium")
        : typeof settings["writer.reasoning_effort"] === "string"
          ? settings["writer.reasoning_effort"] as string : "medium";
      const digest = planDigest(input.plan);
      const enabled = automaticEffortRoutingEnabled(settings);
      let jev:Awaited<ReturnType<typeof host.call<"classifyPlan">>>;
      if (!enabled) {
        jev = { hostId:input.config.hostId, status:"disabled", effort:null, reason:"jev_disabled_by_project_setting",
          planSha256:digest.sha256, sentPlanSha256:null, sourceLength:digest.length, sentLength:null };
      } else {
        try {
          jev = await host.call("classifyPlan", { requestedHostId:input.config.hostId, plan:input.plan }, { hostId:input.config.hostId, timeoutMs:35_000 });
        } catch {
          // The RPC boundary itself can fail before the host adapter returns its normal fail-open result.
          jev = { hostId:input.config.hostId, status:"error", effort:null, reason:"host_classify_rpc_failed",
            planSha256:digest.sha256, sentPlanSha256:null, sourceLength:digest.length, sentLength:null };
        }
      }
      const noSentProof = jev.sentPlanSha256 === null && jev.sentLength === null;
      const validSentProof = jev.sentPlanSha256 === digest.sha256 && jev.sentLength === digest.length;
      const allowedWithoutSentProof = jev.status === "disabled" || jev.reason === "host_classify_rpc_failed";
      if (jev.planSha256 !== digest.sha256 || jev.sourceLength !== digest.length
        || (noSentProof ? !allowedWithoutSentProof : !validSentProof)) {
        throw new Error("Jev full-plan transport proof mismatch");
      }
      const supported = new Set<string>(model.supportedReasoningEfforts.map((item) => item.reasoningEffort));
      const jevDecision = jev.status === "ok" ? jev.effort : null;
      const choice = resolveJevReasoning({
        status:jev.status, jevDecision, manualLevel:manual,
        supportedLevels:supported,
      });
      const retryEffort = resolveRetryEffort({current:choice.effective,supportedLevels:supported,
        retryIndex:input.retryIndex ?? 0,enabled});
      const fallbackReason = [choice.fallbackReason,
        jev.status !== "ok" && jev.reason ? `${jev.reason}` : null,
        choice.manualSupported === false ? `manual_fallback_unsupported:${manual}` : null,
        retryEffort.changed ? `retry_effort_escalated:${retryEffort.before}->${retryEffort.after}` : null,
      ].filter(Boolean).join(";") || null;
      const requested = choice.requested;
      const effective = retryEffort.after;
      const reasoningLevelSource = enabled && jev.status === "ok" && jevDecision ? "client-preference" as const : "explicit" as const;
      const selectionSource = {
        providerId:writerProviderId, model:writerModel, reasoningLevel:effective,
        serviceTier:effectiveServiceTier, reasoningLevelSource,
      };
      const trace = {
        stamp:{stateMachineVersion:STATE_MACHINE_VERSION, harnessVersion:HARNESS_VERSION, transitionKey:TRANSITION_KEY},
        planSha256:digest.sha256, sentPlanSha256:jev.sentPlanSha256, sourceLength:digest.length, sentLength:jev.sentLength,
        jevStatus:jev.status, jevDecision, requestedReasoningLevel:requested,
        effectiveReasoningLevel:effective, fallbackReason,
        retryEffort,
        providerId:writerProviderId, model:writerModel, serviceTier:effectiveServiceTier,
        requestedServiceTier,
        runId:input.runId, attemptId:input.attemptId, threadId:null,
        // The launch's fixed bounds, next to the chosen model and effort (sma as_build_args).
        maxTurns:WRITER_MAX_TURNS, disallowedTools:HELPER_DISALLOWED_TOOLS,
        effortMode: enabled ? "automatic" as const : "manual" as const,
        selectionSource,
      } as const;
      saveReasoningTrace(db, trace);
      bb.log.info(`Lane Pilot writer reasoning trace ${JSON.stringify(trace)}`);
      if (choice.manualSupported === false) {
        throw new WriterSelectionError(`manual_writer_reasoning_effort_unsupported:${effective}; supported=${[...supported].join(",")}`);
      }
      const execution = writerExecutionSelection(writerProviderId, writerModel, effective, effectiveServiceTier, {
        reasoningLevel: reasoningLevelSource,
      });
      lastExecution = { reasoningLevel:effective, serviceTier:effectiveServiceTier, selectionSource };
      const run = getRun(db, input.runId);
      if (!run?.writer_workspace_path) throw new Error("writer run has no immutable workspace binding");
      // The task's checkout: the run's folder, or a git repository inside it the task was moved into at dispatch. Such a
      // repository is not the BB project's root source and not the run's environment: Lane Pilot's own worktree of it.
      const base = taskBasePath(db,input.runId,input.taskId) ?? run.writer_workspace_path;
      const nestedBase = resolve(base) !== resolve(run.writer_workspace_path);
      at("worktree");
      const boundWorkspace = await worktree.bindAttemptWorkspace({ input, settings, workspaceDecision, nativeRun, ownsBarrier,
        base, nestedBase, run:run as typeof run & {writer_workspace_path:string}, execution, writerProviderId, dirtBefore });
      const workspacePath = boundWorkspace.workspacePath;
      const environment = boundWorkspace.environment;
      const providerEnvironment = boundWorkspace.providerEnvironment;
      dirtBefore = boundWorkspace.dirtBefore;
      setAttemptDirtBefore(db,input.attemptId,dirtBefore);
      const attemptTask=retargetTask(input.task,workspacePath);
      if(live) {
        // The owned files are copied aside before the writer touches them; a rejected attempt is rolled back from them. They are
        // listed apart from the snapshot, which names only the changed files of a nested repository.
        const owned=await liveFolder.liveOwnedList(input.config.hostId,workspacePath,input.task);
        if(!owned.ok) throw new WriterSelectionError(`attempt_workspace_backup_failed:${owned.reason}`);
        const saved=await liveFolder.backupLiveFolder({hostId:input.config.hostId,folder:workspacePath,backupId:input.attemptId,files:owned.paths});
        if(!saved.ok) throw new WriterSelectionError(`attempt_workspace_backup_failed:${saved.reason}`);
      }
      const built = await buildWriterLaunch({ bb, db, skillPick, skillMaterial, harness:services.harness },
        { input, settings, attemptTask, workspacePath, live, knowledge, relevantMemory, writerProviderId, writerModel, execution, at });
      const launch = built.launch;
      const executionPacketSha256 = built.executionPacketSha256;
      // The watchdog below ended this start while it waited: a thread made now would belong to no attempt.
      if (getAttempt(db, input.attemptId)?.state !== "spawn_requested") {
        const reason = "the writer start ended while it was being prepared";
        return { ok:false, status:endSpawnFailure(db, input.attemptId, reason), reason, attemptId:input.attemptId };
      }
      at("launch");
      const spawned = providerEnvironment ? await worktree.launchOnProvider({ input, providerEnvironment, fallback:environment, launch }) : await launch(environment);
      const writerThreadId = stringAt(spawned, "id") ?? "";
      if (!writerThreadId) throw new Error("threads.spawn returned no writer thread id");
      // Canceled while its thread was being made: stop the thread it got and end here.
      if (getAttempt(db, input.attemptId)?.state === "cancel_requested") {
        await bestEffort(bb.log, "writer thread stop", bb.sdk.threads.stop({ threadId:writerThreadId }), undefined);
        transitionAttempt(db, input.attemptId, "canceled", { threadId:writerThreadId, reason:"canceled while its writer was starting" });
        return { ok:false, status:"canceled", reason:"canceled while its writer was starting", attemptId:input.attemptId };
      }
      if (getAttempt(db, input.attemptId)?.state !== "spawn_requested") {
        await bestEffort(bb.log, "writer thread stop", bb.sdk.threads.stop({ threadId:writerThreadId }), undefined);
        return { ok:false, status:"spawn_rejected", reason:"the writer thread came after its start had ended", attemptId:input.attemptId };
      }
      transitionAttempt(db, input.attemptId, "running", { threadId:writerThreadId });
      // The spend book lists the attempt from its first second (SMA as_usage): a cursor row exists before any sync,
      // so an attempt that dies early still shows up with zero totals until events land.
      openTokenCursor(db, { threadId:writerThreadId, projectId:input.projectId, providerId:input.config.writerProviderId ?? "" });
      // A BB environment, a folder in place: the base is asked of git (a worktree Lane Pilot made recorded its own already).
      // A folder without git has no commit to name, and Lane Pilot never touches git there.
      { const bound = getAttempt(db, input.attemptId); if (bound?.workspace_path && !isLiveDecision(bound.workspace_decision)) services.rollback?.ensureBase(input.attemptId, input.config.hostId, bound.workspace_path); }
      setReasoningThread(db, input.attemptId, writerThreadId);
      const spawnedTrace = getReasoningTrace(db, input.attemptId);
      if (spawnedTrace) bb.log.info(`Lane Pilot writer execution ${JSON.stringify({ attemptId:input.attemptId, threadId:writerThreadId, providerId:spawnedTrace.providerId, model:spawnedTrace.model, reasoningLevel:spawnedTrace.effectiveReasoningLevel, serviceTier:spawnedTrace.serviceTier })}`);
      // Launch profile parity (SMA m_md_parity). Unset writer.launch_parity keeps the old check as it was: a fire-and-forget read of the
      // thread that only logs a warning. With `refuse` it is awaited, and a thread on another PROVIDER than asked is refused (a model
      // alias or a clamped/renamed reasoning effort is only a warning); the refused pair is held so the chain moves on instead of retrying it.
      if (switchWord(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)), "writer.launch_parity") !== "refuse") {
        void bb.sdk.threads.get({ threadId:writerThreadId }).then((thread) => {
          const got = { providerId:stringAt(thread, "providerId"), model:stringAt(thread, "model") };
          if ((got.providerId && got.providerId !== selectedProviderId) || (got.model && selectedModel && got.model !== selectedModel)) {
            bb.log.warn(`Lane Pilot launch profile mismatch for ${input.attemptId}: asked ${selectedProviderId}/${selectedModel}, the thread runs ${got.providerId}/${got.model}`);
          }
        }, () => undefined);
      } else {
        // Bounded: a thread read that never answers must not hold the start; an unread thread is not a mismatch.
        const thread = await within(bb.sdk.threads.get({ threadId:writerThreadId }), LAUNCH_PARITY_READ_MS).catch(() => null);
        const got = { providerId:stringAt(thread, "providerId"), model:stringAt(thread, "model"), reasoningLevel:stringAt(thread, "reasoningLevel") ?? stringAt(thread, "reasoningEffort") };
        const asked = `${selectedProviderId}/${selectedModel}/${lastExecution?.reasoningLevel ?? "?"}`;
        const ran = `${got.providerId}/${got.model}/${got.reasoningLevel ?? "?"}`;
        if (got.providerId && got.providerId !== selectedProviderId) {
          await bestEffort(bb.log, "writer thread stop", bb.sdk.threads.stop({ threadId:writerThreadId }), undefined);
          // The hold resolves a half-open trial this start reserved (record clears it), so nothing is left for the finally block to release.
          services.providerBreaker.record(breakerKey(selectedProviderId, selectedModel), "exhausted", Date.now(), Date.now() + LAUNCH_PARITY_HOLD_MS);
          unusedTrial = null;
          const reason = `writer_provider_unavailable:launch_profile_mismatch:${asked} vs ${ran}`;
          return { ok:false, status:endSpawnFailure(db, input.attemptId, reason, writerThreadId), reason, attemptId:input.attemptId };
        }
        if ((got.model && selectedModel && normalizeModel(got.model) !== normalizeModel(selectedModel))
          || (got.reasoningLevel && lastExecution?.reasoningLevel && got.reasoningLevel !== lastExecution.reasoningLevel)) {
          bb.log.warn(`Lane Pilot launch profile mismatch for ${input.attemptId}: asked ${asked}, the thread runs ${ran}`);
        }
      }
      writerHoldsTrial = true;
      return { ok:true, threadId:writerThreadId, providerId:selectedProviderId, model:selectedModel,
        reasoningLevel:lastExecution?.reasoningLevel, serviceTier:lastExecution?.serviceTier, selectionSource:lastExecution?.selectionSource,
        dirtBefore, workspacePath, executionPacketSha256 };
    } catch (cause) {
      if (cause instanceof RunBudgetExceeded) {
        const reason = cause.message;
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { ok:false, status:"blocked", reason, attemptId:input.attemptId };
      }
      if (cause instanceof WriterSelectionError) {
        const reason = cause.message;
        return { ok:false, status:endSpawnFailure(db, input.attemptId, reason), reason, attemptId:input.attemptId };
      }
      // Only a spawn that is still being made is unknown. A failure after the thread was bound (the attempt is running) is
      // a bookkeeping error: reconcile below finds the thread it already has. Any other state is not a spawn's to change.
      const during = getAttempt(db, input.attemptId)?.state;
      if (during === "cancel_requested") {
        // The stop was requested while the spawn was being made and the spawn failed: nothing is left to reconcile for.
        const reason = cause instanceof Error ? cause.message : String(cause);
        bb.log.warn(`Lane Pilot writer spawn for ${input.attemptId} failed after its stop was requested: ${reason}`);
        return { ok:false, status:endSpawnFailure(db, input.attemptId, reason), reason, attemptId:input.attemptId };
      }
      if (during === "spawn_requested") transitionAttempt(db, input.attemptId, "spawn_unknown", { reason:cause instanceof Error ? cause.message : String(cause) });
      else if (during !== "running" && during !== "spawn_unknown") throw cause;
      // Reconcile overwrites this reason; keep the spawn error itself in the log.
      bb.log.warn(`Lane Pilot writer spawn for ${input.attemptId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      const attempt = getAttempt(db, input.attemptId);
      if (!attempt) throw new Error(`persisted attempt disappeared after spawn_unknown: ${input.attemptId}`);
      writerHoldsTrial = true;
      return { ok:true, threadId: await services.reconcileAttemptThread(input.projectId, attempt), providerId:selectedProviderId, model:selectedModel, dirtBefore:attempt.dirt_before,
        workspacePath:attempt.workspace_path ?? input.task.project_cwd };
    } finally {
      startSteps.delete(input.attemptId);
      if (!writerHoldsTrial && unusedTrial) services.providerBreaker.releaseTrial(unusedTrial.key, unusedTrial.token);
    }
  }

  async function spawnWriterAttempt(input: SpawnInput): Promise<SpawnResult> {
    return spawnWriterAttemptWatched({ db, log:(message) => bb.log.warn(message) }, input, spawnWriterAttemptOnce);
  }

  return { spawnWriterAttempt, workspaceDirt:worktree.workspaceDirt, isLiveFolder:liveFolder.isLiveFolder, backupLiveFolder:liveFolder.backupLiveFolder, restoreLiveFolder:liveFolder.restoreLiveFolder };
}

export type WriterSpawnApi = ReturnType<typeof createWriterSpawn>;
