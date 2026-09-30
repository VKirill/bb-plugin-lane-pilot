import { acceptanceArtifactDir, bbWriterReportMarkdown, buildAcceptanceV2, validateAcceptanceV2 } from "../acceptance-v2";
import { buildCliInvocation } from "../argv-builder";
import { requiredCliFlags } from "../cli-flags";
import { attemptProduced, classifyCliOutcome, parseDirtSnapshots } from "../cli-outcome";
import type { DirtSnapshot } from "../cli-outcome";
import { cliReceiptAttemptKey, cliReceiptRunKey } from "../constants";
import { taskV2Schema } from "../contracts";
import type { PrototypeConfig, TaskV2 } from "../contracts";
import { countAttempts, createAttempt, createTask, freeTaskId, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getRunWriterHost, getTask, getTaskGitBase, getTaskPlan, listOpenAttempts, listRunsWithAttempts, listStageReceipts, listTaskKinds, listTaskTerminalStates, listTasksForRun, loadProjectSettings, loadPrototypeConfig, saveProjectSetting, saveReasoningTrace, saveTaskGitBase, saveTaskPlan, searchMemoryRecords, setAttemptDirtBefore, setAttemptHolderThread, setAttemptWorkspace, setReasoningThread, setRunState, transitionAttempt } from "../database";
import type { HelperPolicySnapshot } from "../helper-context";
import { automaticEffortRoutingEnabled, bbServiceTier, resolveJevReasoning, writerExecutionSelection, writerServiceTier } from "../jev-reasoning";
import { reconcile } from "../reconcile";
import { spawnWithSeam } from "../spawn-seam";
import { actionableFindings, buildCandidateEvidence, codeCritiqueSource, codeRepairPrompt, findingsHash, nextRepairAction, parseCodeCritiqueSettings, parseWriterRepairReply, repairLedgerFromResult, sameUnresolvedFindings, sameWriterIdentity, settingsFromFrozenPolicy, shouldRequestRepair } from "../stages/code-critique";
import type { WriterIdentity } from "../stages/code-critique";
import { sha256 } from "../stages/contract";
import { emergencyFallbackDecision, sameWriterSelection } from "../stages/emergency-writer";
import { buildExecutionPacket, renderExecutionPacket } from "../stages/execution-packet";
import { memoryContext, parseMemorySettings } from "../stages/memory";
import { parseReadFirstHints, readFirstKindError } from "../stages/read-first";
import { resolveRetryEffort } from "../stages/retry-effort";
import { boundedAgentName } from "../stages/role";
import { RunWriterPool, buildRunExecutionProfile, buildRunPolicy, mapBounded } from "../stages/run-policy";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../state-machine";
import type { AttemptState } from "../state-machine";
import { validateTaskV2 } from "../task-v2";
import { classifyWriterOutput, isOutputPath } from "../validate-output";
import type { VerifyResult } from "../validate-output";
import { filterOwnershipNoise } from "../verification/git-ownership";
import { findUnownedChanges, findUnownedRunChanges, resolveRunOwnershipScope, validateOwnershipContract } from "../verification/ownership";
import { WORKSPACE_DIRT_COMMAND } from "../workspace-dirt";
import { parseWorkspaceMode, requireManagedWorktreeProvider, resolveAttemptWorkspace, resolveManagedWorkspace, waitManagedWorktreeReady } from "../workspace/routing";
import { runCodeCritique, runPlanCritique, runPmRead, runSpecialistReview } from "./critique-runs";
import { fullAccessSpawn } from "./pm-spawn";
import { WriterSelectionError, helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "./run-routing";
import { recordGateEvaluation, recordStage } from "./stage-records";
import { id, stringAt, valueAt } from "./values";
import { buildTask, outputText, planDigest, writerPatchFromOutput, writerPrompt } from "./writer-task";
import { THREAD_WATCH_EVENT_TYPES, listThreadEventsRaw, threadFailure, waitThreadIdle } from "@lane-pilot/thread-observe";
import { isAbsolute, relative, resolve } from "node:path";
import type { ServerCore } from "./core";
import type { Services } from "./services";

export function createWriterRun(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, cliSettingsFor, configForRun, db, effectiveProjectSettings, ensureRunScopes, getThreadBounded, host, markCanceledWriterStages, refreshRun, runPolicyFor } = ctx;

  const activeWriterTasks = new Set<string>();

  const runWriterPool = new RunWriterPool();

  async function spawnWriterAttempt(input: {
    projectId:string; runId:string; taskId:string; attemptId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; pmThreadId:string; pmReadContext?:string;
    emergency?:{providerId:string;model:string;reason:string}; retryIndex?:number;
  }): Promise<
    | { ok:true; threadId:string; providerId:string|null; model:string|null; reasoningLevel?:string; serviceTier?:"default"|"fast"|null; selectionSource?:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"}; dirtBefore:import("../cli-outcome").DirtSnapshot[]; workspacePath:string; executionPacketSha256?:string }
    | { ok:false; status:"spawn_rejected"; reason:string; attemptId:string }
  > {
    let selectedProviderId:string|null=null;
    let selectedModel:string|null=null;
    let lastExecution:{reasoningLevel:string;serviceTier:"default"|"fast"|null;selectionSource:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"}}|null=null;
    transitionAttempt(db, input.attemptId, "spawn_requested");
    try {
      const settings = (await effectiveProjectSettings(input.projectId,getRunSettingsScopes(db,input.runId))).values;
      const workspaceMode = parseWorkspaceMode(settings["adoc.040"]);
      const minScoreValue = settings["adoc.041"];
      const minScore = minScoreValue === undefined || minScoreValue === null || minScoreValue === "" ? 4 : Number(minScoreValue);
      const multiWriteEnabled = settings["adoc.042"] === undefined ? true : settings["adoc.042"] === true || settings["adoc.042"] === 1 || settings["adoc.042"] === "true";
      // A native Lane chat gives every writer attempt its own worktree unless the project says in_place:
      // parallel writers never share a checkout, and acceptance merges each one into main.
      const nativeRun = getRun(db, input.runId)?.kind === "cli";
      const workspaceDecision = resolveAttemptWorkspace({mode:workspaceMode,risk:input.task.risk,
        expectedOutputCount:input.task.expected_outputs.length,minScore:nativeRun&&workspaceMode==="auto"?0:minScore,multiWriteEnabled});
      const sourcePreflight=await workspaceDirt(input.config,input.task.project_cwd);
      if(!sourcePreflight.ok) throw new WriterSelectionError(`attempt_workspace_snapshot_failed:${sourcePreflight.reason}`);
      let dirtBefore=sourcePreflight.snapshots;
      const memorySettings=parseMemorySettings(settings);
      const taskMemoryQuery=`${input.task.title}\n${input.task.objective}\n${input.task.acceptance.join(" ")}`;
      const relevantMemory=memorySettings.enabled&&memorySettings.inject
        ? memoryContext(searchMemoryRecords(db,input.projectId,taskMemoryQuery,100,memorySettings.searchEngine,"subagent",memorySettings.personalBot),taskMemoryQuery,memorySettings.contextBudget)
        : {text:"",records:[],estimatedTokens:0};
      const writerProviderId = input.emergency?.providerId ?? (typeof settings["writer.provider"] === "string"
        ? settings["writer.provider"] as string : input.config.writerProviderId);
      const writerModel = input.emergency?.model ?? (typeof settings["writer.model"] === "string" && settings["writer.model"]
        ? settings["writer.model"] as string : input.config.writerModel);
      selectedProviderId=writerProviderId;
      selectedModel=writerModel;
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
      const model = catalog.models.find((row) => row.id === writerModel || row.model === writerModel);
      if (!model) throw new WriterSelectionError(`writer_model_unavailable:${writerProviderId}/${writerModel}`);
      const tierIds = new Set(provider.serviceTiers?.map((tier) => tier.id) ?? []);
      if (requestedServiceTier === "fast" && !tierIds.has("fast")) {
        throw new WriterSelectionError(`writer_service_tier_unavailable:${writerProviderId}/fast`);
      }
      const effectiveServiceTier = tierIds.has(requestedServiceTier) ? requestedServiceTier : null;
      const manual = input.emergency
        ? (model.supportedReasoningEfforts.some((item) => item.reasoningEffort === "low") ? "low" : model.supportedReasoningEfforts[0]?.reasoningEffort ?? "medium")
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
        planSha256:digest.sha256, sentPlanSha256:jev.sentPlanSha256, sourceLength:digest.length, sentLength:jev.sentLength,
        jevStatus:jev.status, jevDecision, requestedReasoningLevel:requested,
        effectiveReasoningLevel:effective, fallbackReason,
        retryEffort,
        providerId:writerProviderId, model:writerModel, serviceTier:effectiveServiceTier,
        requestedServiceTier,
        runId:input.runId, attemptId:input.attemptId, threadId:null,
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
      let workspacePath = run.writer_workspace_path;
      let environment:{type:"reuse";environmentId:string}|{type:"host";hostId:string;workspace:{type:"unmanaged";path:string}} = run.writer_environment_id
        ? { type:"reuse" as const, environmentId:run.writer_environment_id }
        : { type:"host" as const, hostId:input.config.hostId, workspace:{ type:"unmanaged" as const, path:input.task.project_cwd } };
      if (workspaceDecision.strategy === "provision_attempt_worktree") {
        const bound=getAttempt(db,input.attemptId);
        if (bound?.workspace_path && bound.environment_id) {
          workspacePath=bound.workspace_path;
          environment={type:"reuse",environmentId:bound.environment_id};
        } else if (nativeRun) {
          // BB's managed worktree always forks the project root; a Lane chat works in a section's own
          // repository, so Lane Pilot adds a git worktree of that repository and hosts the writer there.
          if (bound?.workspace_path) workspacePath=bound.workspace_path;
          else {
            const created=await host.call("gitCreateWorktree",{requestedHostId:input.config.hostId,basePath:run.writer_workspace_path,name:input.attemptId},
              {hostId:input.config.hostId,timeoutMs:60_000});
            if(created.status!=="ready"||!created.path) throw new WriterSelectionError(`attempt_worktree_failed:${created.reason??"unknown"}`);
            workspacePath=created.path;
            await host.call("gitPrepareWorktree",{requestedHostId:input.config.hostId,basePath:run.writer_workspace_path,worktreePath:workspacePath},
              {hostId:input.config.hostId,timeoutMs:600_000}).catch(()=>undefined);
            const prepared=await workspaceDirt(input.config,workspacePath);
            if(!prepared.ok) throw new WriterSelectionError(`attempt_worktree_baseline_failed:${prepared.reason}`);
            dirtBefore=prepared.snapshots;
            if(!setAttemptWorkspace(db,input.attemptId,{path:workspacePath,environmentId:null,decision:workspaceDecision})) {
              throw new WriterSelectionError("attempt_workspace_cas_conflict");
            }
          }
          environment={type:"host",hostId:input.config.hostId,workspace:{type:"unmanaged",path:workspacePath}};
        } else {
        try {
          requireManagedWorktreeProvider(await bb.sdk.environments.listProviders({
            projectId:input.projectId, hostId:input.config.hostId,
          }));
        } catch (cause) {
          throw new WriterSelectionError(cause instanceof Error ? cause.message : String(cause));
        }
        // Provision a managed worktree with a short-lived holder. Wait until the environment is
        // bound and ready, then stop the holder before the writer starts.
        let holderThreadId=getAttempt(db,input.attemptId)?.holder_thread_id ?? null;
        let spawnEnvironmentId:string|null=null;
        if(!holderThreadId) {
          const current=getAttempt(db,input.attemptId);
          if(!current) throw new WriterSelectionError("attempt_worktree_holder_missing_attempt");
          holderThreadId=await services.recoverLostHolderThread(input.projectId, current);
        }
        if(!holderThreadId) {
          const holder = await spawnWithSeam(() => fullAccessSpawn(bb, {
            projectId:input.projectId, ...execution,
            prompt:"Prepare the assigned managed workspace and make no file changes. Return only WORKSPACE_READY.",
            environment:{type:"host",hostId:input.config.hostId,workspace:{type:"managed-worktree",baseBranch:{kind:"default"}}},
            visibility:"hidden",pluginMetadata:{role:"workspace-provisioner",lanePilotRunId:input.runId,lanePilotTaskId:input.taskId,workspaceAttemptId:input.attemptId},
          }));
          holderThreadId=stringAt(holder,"id");
          spawnEnvironmentId=stringAt(holder,"environmentId");
          if(!holderThreadId) throw new WriterSelectionError("attempt_worktree_provision_missing_thread");
          if(!setAttemptHolderThread(db,input.attemptId,holderThreadId)) {
            const persisted=getAttempt(db,input.attemptId)?.holder_thread_id;
            if(!persisted) throw new WriterSelectionError("attempt_worktree_holder_cas_conflict");
            if(persisted!==holderThreadId) {
              await bb.sdk.threads.stop({threadId:holderThreadId}).catch(()=>undefined);
              holderThreadId=persisted;
              spawnEnvironmentId=null;
            }
          }
        }
        let environmentId:string;
        try {
          environmentId=(await waitManagedWorktreeReady({
            threadId:holderThreadId,
            expectedHostId:input.config.hostId,
            spawnEnvironmentId,
            getThread:(threadId)=>bb.sdk.threads.get({threadId}),
            getEnvironment:(id)=>bb.sdk.environments.get({environmentId:id}),
          })).environmentId;
        } catch (cause) {
          await bb.sdk.threads.stop({threadId:holderThreadId}).catch(()=>undefined);
          throw new WriterSelectionError(cause instanceof Error ? cause.message : String(cause));
        }
        await bb.sdk.threads.stop({threadId:holderThreadId});
        const holderState=await bb.sdk.threads.get({threadId:holderThreadId});
        const holderStatus=stringAt(holderState,"status");
        if(holderStatus!=="idle"&&holderStatus!=="error") throw new WriterSelectionError(`attempt_worktree_provisioner_not_stopped:${holderStatus??"unknown"}`);
        const managed=resolveManagedWorkspace(await bb.sdk.environments.get({environmentId}),input.config.hostId);
        workspacePath=managed.path;
        const basePath=getRun(db,input.runId)?.writer_workspace_path;
        // Linking dependencies helps the writer's checks; a host without it still gets a clean worktree.
        if(basePath) await host.call("gitPrepareWorktree",{requestedHostId:input.config.hostId,basePath,worktreePath:workspacePath},{hostId:input.config.hostId,timeoutMs:600_000}).catch(()=>undefined);
        const prepared=await workspaceDirt(input.config,workspacePath);
        if(!prepared.ok) throw new WriterSelectionError(`attempt_worktree_baseline_failed:${prepared.reason}`);
        if(prepared.snapshots.length) throw new WriterSelectionError(`attempt_worktree_not_clean:${prepared.snapshots.map(row=>row.path).join(",")}`);
        dirtBefore=prepared.snapshots;
        if(!setAttemptWorkspace(db,input.attemptId,{path:workspacePath,environmentId:managed.environmentId,decision:workspaceDecision})) {
          throw new WriterSelectionError("attempt_workspace_cas_conflict");
        }
        environment={type:"reuse",environmentId:managed.environmentId};
        }
      } else if (!setAttemptWorkspace(db,input.attemptId,{path:workspacePath,environmentId:run.writer_environment_id,decision:workspaceDecision})) {
        throw new WriterSelectionError("attempt_workspace_cas_conflict");
      }
      setAttemptDirtBefore(db,input.attemptId,dirtBefore);
      const attemptTask={...input.task,project_cwd:workspacePath,
        verification:input.task.verification.map(command=>({...command,cwd:workspacePath}))};
      let executionPacket:string;
      let executionPacketSha256:string;
      try {
        const packet = await buildExecutionPacket(attemptTask.read_first, async (path) => {
          const file = await bb.sdk.files.read({ hostId:input.config.hostId, rootPath:workspacePath, path:resolve(workspacePath, path) });
          if (typeof file.content !== "string") return null;
          return { content:file.content, contentEncoding:file.contentEncoding, sha256:file.sha256, sizeBytes:file.sizeBytes };
        });
        executionPacket = renderExecutionPacket(packet);
        executionPacketSha256 = packet.sha256;
      } catch (cause) {
        throw new WriterSelectionError(`execution_packet_failed:${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const helperSnapshot = requireHelperSpawn({ bb, db, projectId:input.projectId, runId:input.runId });
      const writerAgent = boundedAgentName(settings["writer.agent"],"Lane Pilot writer");
      const existingTrace = getReasoningTrace(db, input.attemptId);
      if (existingTrace) {
        saveReasoningTrace(db, {
          ...existingTrace,
          dispatchContext:{
            memoryText:relevantMemory.text,
            executionPacket,
            executionPacketSha256,
            pmReadContext:input.pmReadContext ?? "",
            agent:writerAgent,
            helperMode:helperSnapshot?.mode ?? "inherit",
            helperRequired:helperSnapshot?.policy?.required === true,
          },
        });
      }
      const placement = await helperChildPlacement({
        bb, db, projectId:input.projectId, runId:input.runId,
        role:input.emergency ? "emergency-writer" : "writer",
        taskTitle:input.task.title,
      });
      const spawned = await spawnWithSeam(() => fullAccessSpawn(bb, {
        ...placement,
        ...requiredPolicyField(bb, helperSnapshot, writerProviderId),
        ...execution,
        prompt: writerPrompt(attemptTask,relevantMemory.text,executionPacket,input.emergency
          ? `Fallback reason: ${input.emergency.reason}. Primary provider/model: ${typeof settings["writer.provider"] === "string" ? settings["writer.provider"] : input.config.writerProviderId}/${typeof settings["writer.model"] === "string" ? settings["writer.model"] : input.config.writerModel}.`
          : undefined,writerAgent,input.pmReadContext ?? ""),
        environment,
        pluginMetadata:{
          role:input.emergency ? "emergency-writer" : "writer",
          lanePilotRunId:input.runId,
          lanePilotTaskId:input.taskId,
          attemptId:input.attemptId,
          parentPmThreadId:input.pmThreadId,
        },
      }));
      const writerThreadId = stringAt(spawned, "id") ?? "";
      if (!writerThreadId) throw new Error("threads.spawn returned no writer thread id");
      transitionAttempt(db, input.attemptId, "running", { threadId:writerThreadId });
      setReasoningThread(db, input.attemptId, writerThreadId);
      const spawnedTrace = getReasoningTrace(db, input.attemptId);
      if (spawnedTrace) bb.log.info(`Lane Pilot writer execution ${JSON.stringify({ attemptId:input.attemptId, threadId:writerThreadId, providerId:spawnedTrace.providerId, model:spawnedTrace.model, reasoningLevel:spawnedTrace.effectiveReasoningLevel, serviceTier:spawnedTrace.serviceTier })}`);
      return { ok:true, threadId:writerThreadId, providerId:selectedProviderId, model:selectedModel,
        reasoningLevel:lastExecution?.reasoningLevel, serviceTier:lastExecution?.serviceTier, selectionSource:lastExecution?.selectionSource,
        dirtBefore, workspacePath, executionPacketSha256 };
    } catch (cause) {
      if (cause instanceof WriterSelectionError) {
        const reason = cause.message;
        transitionAttempt(db, input.attemptId, "spawn_rejected", { reason });
        return { ok:false, status:"spawn_rejected", reason, attemptId:input.attemptId };
      }
      transitionAttempt(db, input.attemptId, "spawn_unknown", { reason:cause instanceof Error ? cause.message : String(cause) });
      // Reconcile overwrites this reason; keep the spawn error itself in the log.
      bb.log.warn(`Lane Pilot writer spawn for ${input.attemptId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      const attempt = getAttempt(db, input.attemptId);
      if (!attempt) throw new Error(`persisted attempt disappeared after spawn_unknown: ${input.attemptId}`);
      return { ok:true, threadId: await services.reconcileAttemptThread(input.projectId, attempt), providerId:selectedProviderId, model:selectedModel, dirtBefore:attempt.dirt_before,
        workspacePath:attempt.workspace_path ?? input.task.project_cwd };
    }
  }

  async function workspaceDirt(config: PrototypeConfig, workspacePath = config.writerWorkspacePath): Promise<{ ok:true; paths:string[]; snapshots:DirtSnapshot[] } | { ok:false; reason:string }> {
    const ran = await host.call("runCommand", {
      requestedHostId: config.hostId,
      command: WORKSPACE_DIRT_COMMAND,
      cwd: workspacePath,
      timeoutSec: 30,
    }, { hostId:config.hostId, timeoutMs:30_000 }).catch((cause: unknown) => ({
      hostId: config.hostId,
      exitCode: 1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : String(cause),
    }));
    if (ran.exitCode !== 0) {
      return { ok:false, reason:`cannot read writer-workspace git diff: ${ran.stderr || `exit ${ran.exitCode}`}` };
    }
    try {
      const parsed = JSON.parse(ran.stdout) as unknown;
      if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== "object"
        || typeof (row as DirtSnapshot).path !== "string" || typeof (row as DirtSnapshot).sha256 !== "string")) {
        return { ok:false, reason:"cannot snapshot writer-workspace file contents" };
      }
      const snapshots = parseDirtSnapshots(ran.stdout);
      if (snapshots.length !== parsed.length) return { ok:false, reason:"incomplete writer-workspace content snapshot" };
      return { ok:true, paths:snapshots.map((row) => row.path), snapshots };
    } catch {
      return { ok:false, reason:"invalid writer-workspace content snapshot" };
    }
  }

  async function runVerification(config: PrototypeConfig, task: TaskV2, runId?:string): Promise<Array<VerifyResult & {
    sandboxBackend:string|null; policySha256:string|null; workspacePath:string;
  }>> {
    const policy=runId?runPolicyFor(runId):buildRunPolicy(loadProjectSettings(db,config.projectId));
    const verificationScopes=runId?getRunSettingsScopes(db,runId):[];
    return mapBounded(task.verification,policy.pools.verification,async(command)=>{
      const release=await runWriterPool.acquire(`verification:${runId??config.projectId}`,policy.pools.verification);
      try {
      const ran = await host.call("runSandboxedCommand", {
        requestedHostId: config.hostId,
        workspacePath:task.project_cwd,
        backend:(loadProjectSettings(db,config.projectId,verificationScopes)["sandbox.backend"] as "auto"|"macos-seatbelt"|"linux-bubblewrap"|undefined) ?? "auto",
        command:command.command,
        cwd: command.cwd,
        timeoutSec: command.timeout_sec,
      }, { hostId:config.hostId, timeoutMs:(command.timeout_sec ?? 30) * 1000 }).catch((cause: unknown) => ({
        hostId: config.hostId,
        exitCode: 1,
        stdout: "",
        stderr: cause instanceof Error ? cause.message : String(cause),
        backend:null as "macos-seatbelt"|"linux-bubblewrap"|null,
        policySha256:null as string|null,
        workspacePath:task.project_cwd,
      }));
      if (ran.hostId !== config.hostId) {
        return {command:command.command,exitCode:1,stdout:"",stderr:"sandbox result host did not match the configured host",
          sandboxBackend:null,policySha256:null,workspacePath:task.project_cwd};
      }
      return {command:command.command,exitCode:ran.exitCode,stdout:typeof ran.stdout==="string"?ran.stdout:"",stderr:typeof ran.stderr==="string"?ran.stderr:"",
        sandboxBackend:ran.backend,policySha256:ran.policySha256,workspacePath:ran.workspacePath};
      } finally { release(); }
    });
  }

  async function persistWriterAcceptance(input: {
    config:PrototypeConfig; task:TaskV2; runId:string; taskId:string; attempt:number;
    attemptId:string; pmThreadId:string; writerThreadId:string; output:string; verification:VerifyResult[];
    emergencyFallback?:{reason:string;primaryAttemptId:string;providerId:string;model:string};
    review?:"passed"|"not_required";
  }): Promise<Record<string,unknown>> {
    const reportText = bbWriterReportMarkdown(input.task, input.attempt);
    const reasoningTrace = getReasoningTrace(db, input.attemptId);
    const acceptance = buildAcceptanceV2({
      task:input.task, attempt:input.attempt,
      providerId:reasoningTrace?.providerId ?? input.config.writerProviderId,
      model:reasoningTrace?.model ?? input.config.writerModel, reportText,
      review:input.review,
    });
    const validation = validateAcceptanceV2(acceptance);
    if (!validation.ok) throw new Error(`upstream acceptance-v2 rejected generated receipt: ${validation.errors.join("; ")}`);
    const artifactDir = acceptanceArtifactDir(input.task.project_cwd, input.runId, input.taskId);
    const internalReceipt = {
      schemaVersion:1, status:"accepted", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
      attemptId:input.attemptId, pmThreadId:input.pmThreadId, writerThreadId:input.writerThreadId,
      ownsPaths:input.task.owns_paths, readFirst:parseReadFirstHints(input.task.read_first),
      output:input.output, verification:input.verification,
      runV2:buildRunExecutionProfile(input.task.risk,runPolicyFor(input.runId)),
      reasoning:reasoningTrace ? [reasoningTrace] : [],
      emergencyFallback:input.emergencyFallback ?? null,
    };
    for (const [name, content] of [
      ["report.md", reportText],
      ["acceptance.json", `${JSON.stringify(acceptance, null, 2)}\n`],
      ["lane-pilot-receipt.json", `${JSON.stringify(internalReceipt, null, 2)}\n`],
    ] as const) {
      await bb.sdk.files.write({
        hostId:input.config.hostId, rootPath:input.task.project_cwd,
        path:`${artifactDir}/${name}`, content, contentEncoding:"utf8", createParents:true, expectedSha256:null,
      });
    }
    const stored = {
      ...internalReceipt,
      acceptancePath: `${artifactDir}/acceptance.json`,
      acceptance,
    };
    saveProjectSetting(db, input.config.projectId, "writer.lastResult", stored);
    const patch = writerPatchFromOutput(input.output);
    if (patch) saveProjectSetting(db, input.config.projectId, "writer.lastPatch", patch);
    return stored;
  }

  async function validateWriterResult(input: {
    config:PrototypeConfig; projectId:string; runId:string; taskId:string; attempt:number; task:TaskV2; writerThreadId:string; attemptId:string; dirtBefore:import("../cli-outcome").DirtSnapshot[];
  }): Promise<{ status:"accepted"|"empty_output"|"validation_failed"; reason?:string; output:string; produced:string[]; verification:VerifyResult[];runV2?:ReturnType<typeof buildRunExecutionProfile> }> {
    const output = await bb.sdk.threads.output({ threadId:input.writerThreadId });
    const dirt = await workspaceDirt(input.config, input.task.project_cwd);
    if (!dirt.ok) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{reason:"workspace_snapshot_unavailable"}});
      return { status:"validation_failed", reason:dirt.reason, output:outputText(output), produced:[], verification:[] };
    }
    const unverifiable = input.dirtBefore
      .filter((before) => !before.sha256 && dirt.snapshots.some((after) => after.path === before.path))
      .map((file) => file.path);
    if (unverifiable.length > 0) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{unverifiableCount:unverifiable.length}});
      return {
        status:"validation_failed",
        reason:`cannot compare pre-existing dirty file content: ${unverifiable.join(", ")}`,
        output:outputText(output), produced:[], verification:[],
      };
    }
    const produced = attemptProduced(dirt.snapshots, input.dirtBefore);
    const runTasks = listTasksForRun(db,input.runId);
    const runOwnershipTasks = runTasks.flatMap((row) => {
      if (row.kind !== "bb") return [];
      const parsed = taskV2Schema.safeParse(row.contract);
      return parsed.success && parsed.data.id === row.id ? [{ ...parsed.data }] : [];
    });
    const persistedRun = getRun(db,input.runId);
    const persistedAttempt = getAttempt(db,input.attemptId);
    // Task-v2 contracts stay bound to the run's configured project workspace. A
    // risk-routed attempt may execute in its own managed worktree, so validate that
    // separate CAS binding instead of requiring the task contract cwd to equal it.
    const contractWorkspace = persistedRun?.writer_workspace_path ?? runOwnershipTasks[0]?.project_cwd;
    const attemptWorkspaceMatches = persistedAttempt?.run_id === input.runId
      && persistedAttempt.task_id === input.taskId
      && persistedAttempt.workspace_path === input.task.project_cwd;
    const ownershipScope = runTasks.length === runOwnershipTasks.length && contractWorkspace && attemptWorkspaceMatches
      ? resolveRunOwnershipScope(runOwnershipTasks,input.taskId,contractWorkspace)
      : { ok:false as const, reason:"run scope contains a non-BB or invalid task contract" };
    if (!ownershipScope.ok) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{reason:"run_scope_invalid"}});
      recordGateEvaluation(db,{...input,gate:"validate",status:"skipped",input:JSON.stringify(input.task),summary:{reason:"run_scope_invalid"}});
      return { status:"validation_failed", reason:`ownership run scope invalid: ${ownershipScope.reason}`,
        output:outputText(output), produced, verification:[] };
    }
    const gitBase=getTaskGitBase(db,input.taskId);
    let branchChanges:string[]=[];
    if(gitBase) {
      const gitResult=await host.call("gitOwnershipChanges",{
        requestedHostId:input.config.hostId,projectCwd:input.task.project_cwd,
        baseSha:gitBase.compare_committed?gitBase.base_sha:null,compareCommitted:gitBase.compare_committed,
      },{hostId:input.config.hostId,timeoutMs:30_000});
      if(gitResult.status!=="ready") {
        recordGateEvaluation(db,{...input,gate:"owns-paths",status:"failed",input:JSON.stringify(input.task),summary:{reason:"git_branch_diff_unavailable",detail:gitResult.reason}});
        recordGateEvaluation(db,{...input,gate:"validate",status:"skipped",input:JSON.stringify(input.task),summary:{reason:"git_branch_diff_unavailable"}});
        return {status:"validation_failed",reason:`ownership git base could not be evaluated: ${gitResult.reason??gitResult.status}`,output:outputText(output),produced,verification:[]};
      }
      branchChanges=gitResult.paths;
    }
    // The working tree of a shared checkout also holds what hooks and sibling agents wrote meanwhile
    // (.agents/memory episodes, PROGRESS.md, design probes); only paths this task owns stay attributed to it.
    const noiseFree=new Set(filterOwnershipNoise(produced));
    const attributed=produced.filter((path)=>noiseFree.has(path)||findUnownedChanges([path],input.task).length===0);
    const checkedPaths=[...new Set([...attributed,...branchChanges])].sort();
    const unowned = findUnownedRunChanges(checkedPaths, ownershipScope.tasks);
    if (unowned.length) {
      recordGateEvaluation(db,{...input,gate:"owns-paths",status:"rejected",input:JSON.stringify(input.task),summary:{unownedCount:unowned.length}});
      recordGateEvaluation(db,{...input,gate:"validate",status:"skipped",input:JSON.stringify(input.task),summary:{reason:"ownership_rejected"}});
      return { status:"validation_failed", reason:`writer changed paths outside owns_paths or inside never_touch: ${unowned.join(", ")}`,
        output:outputText(output), produced:checkedPaths, verification:[] };
    }
    recordGateEvaluation(db,{...input,gate:"owns-paths",status:"passed",input:JSON.stringify(input.task),summary:{changedPathCount:checkedPaths.length,branchChangedPathCount:branchChanges.length,scope:"run",taskCount:ownershipScope.taskIds.length,gitBase:gitBase?{ref:gitBase.base_ref,sha:gitBase.base_sha,branch:gitBase.branch,compareCommitted:!!gitBase.compare_committed,pathsSha256:sha256(branchChanges.join("\0"))}:null}});
    const contents: Record<string, string | null> = {};
    for (const rel of new Set([...input.task.expected_outputs.filter(isOutputPath), ...produced])) {
      const absolute = rel.startsWith("/") ? rel : `${input.task.project_cwd}/${rel}`;
      const read = await bb.sdk.files.read({
        hostId:input.config.hostId,
        rootPath:input.task.project_cwd,
        path:absolute,
      }).catch(() => null);
      contents[rel] = read ? stringAt(read, "content") : null;
    }
    const verifies = await runVerification(input.config, input.task, input.runId);
    recordGateEvaluation(db,{...input,gate:"verification",status:verifies.length===0?"skipped":verifies.every((row)=>row.exitCode===0)?"passed":"failed",
      input:JSON.stringify(input.task),summary:{commandCount:verifies.length,failedCount:verifies.filter((row)=>row.exitCode!==0).length}});
    const classified = classifyWriterOutput({ task:input.task, produced, contents, verifies });
    if (input.task.expected_outputs.includes("hello.txt") && input.task.expected_outputs.includes("tests/hello.test.txt")) {
      const helloOk = contents["hello.txt"] === "hello from native BB writer\n";
      const testOk = contents["tests/hello.test.txt"] === "hello from native BB writer\n";
      if (!helloOk || !testOk) {
        recordGateEvaluation(db,{...input,gate:"validate",status:"rejected",input:JSON.stringify(input.task),summary:{reason:"fixture_output_mismatch"}});
        return {
          status: contents["hello.txt"] == null && contents["tests/hello.test.txt"] == null ? "empty_output" : "validation_failed",
          reason:"fixture output content mismatch",
          output:outputText(output),
          produced:checkedPaths, verification:verifies,
        };
      }
    }
    if (!classified.ok) {
      recordGateEvaluation(db,{...input,gate:"validate",status:"rejected",input:JSON.stringify(input.task),summary:{reason:"writer_output_not_accepted"}});
      return { status:classified.state, reason:classified.reason, output:outputText(output), produced:checkedPaths, verification:verifies };
    }
    recordGateEvaluation(db,{...input,gate:"validate",status:"passed",input:JSON.stringify(input.task),summary:{producedCount:checkedPaths.length}});
    return { status:"accepted", output:outputText(output), produced:checkedPaths, verification:verifies,
      runV2:buildRunExecutionProfile(input.task.risk,runPolicyFor(input.runId)) };
  }

  async function finishWriterAttempt(input: {
    projectId:string; config:PrototypeConfig; task:TaskV2;
    runId:string; taskId:string; attemptId:string; pmThreadId:string; writerThreadId:string;
    dirtBefore:import("../cli-outcome").DirtSnapshot[];
    emergencyFallback?:{reason:string;primaryAttemptId:string;providerId:string;model:string};
  }): Promise<Record<string,unknown>> {
    try {
      // No stopwatch: a writer runs as long as it works, and BB's events say when it has failed.
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
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 2_000 - (Date.now() - pollStarted))));
      }
      const currentAttempt = getAttempt(db, input.attemptId);
      if (currentAttempt?.state === "cancel_requested" || currentAttempt?.state === "canceled") {
        if (currentAttempt.state === "cancel_requested") transitionAttempt(db, input.attemptId, "canceled", { threadId:input.writerThreadId, reason:"writer stop observed before validation" });
        return { status:"canceled", attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      const checked = await validateWriterResult({
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
        const dirt = await workspaceDirt(input.config, input.task.project_cwd);
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
          await waitThreadIdle(bb,ledger.repairThreadId,"code_critique_repair_timeout");
          candidate = await validateWriterResult({
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
          const repairPrompt = [
            writerPrompt(input.task, dispatch.memoryText, dispatch.executionPacket, undefined, dispatch.agent, dispatch.pmReadContext),
            codeRepairPrompt({ task:input.task, findings:frozenFindings, evidence, agent:dispatch.agent }),
          ].join("\n\n");
          const environment = bound.environment_id
            ? { type:"reuse" as const, environmentId:bound.environment_id }
            : { type:"host" as const, hostId:input.config.hostId, workspace:{ type:"unmanaged" as const, path:writerSnapshot.workspacePath } };
          const placement = await helperChildPlacement({
            bb, db, projectId:input.projectId, runId:input.runId, role:"writer", taskTitle:input.task.title,
          });
          let spawned: unknown;
          try {
            spawned = await fullAccessSpawn(bb, {
              ...placement,
              ...requiredPolicyField(bb, helperPolicy, writerSnapshot.providerId),
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
          repairThreadId = stringAt(spawned, "id") ?? undefined;
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
            result:{ ...ledgerBase, spawnAttempted:true, repairThreadId },
            reason:critique.reason ?? "critique_changes_requested",
          });
        }
        writerThreadId = repairThreadId;
        repairRound = nextRound;
        await waitThreadIdle(bb,repairThreadId,"code_critique_repair_timeout");
        candidate = await validateWriterResult({
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
          result:{ ...ledgerBase, spawnAttempted:true, repairObserved:true, repairThreadId, repairRound:nextRound },
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
      const receipt = await persistWriterAcceptance({
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
      if (bound?.workspace_path && basePath && resolve(bound.workspace_path) !== resolve(basePath)) {
        const merged = await host.call("gitIntegrate", {
          requestedHostId:input.config.hostId, basePath, worktreePath:bound.workspace_path,
          message:`${input.task.id}: ${input.task.title}`.slice(0, 500),
          // Only Lane Pilot's own worktree (no BB environment) is removed; a BB managed one belongs to BB.
          removeWorktree:bound.environment_id === null,
        }, { hostId:input.config.hostId, timeoutMs:180_000 });
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

  function startWriterTask(input:{
    projectId:string; runId:string; taskId:string; firstAttemptId:string; pmThreadId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; writerThreadId?:string; dirtBefore?:DirtSnapshot[]; pmReadContext?:string;
  }): void {
    const key = `${input.runId}:${input.taskId}`;
    if (activeWriterTasks.has(key)) return;
    activeWriterTasks.add(key);
    let attemptId = input.firstAttemptId;
    let writerThreadId = input.writerThreadId;
    let writerSelection:{providerId:string;model:string;reasoningLevel?:string;serviceTier?:"default"|"fast"|null;selectionSource?:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"}}|undefined;
    const existingTrace=getReasoningTrace(db,attemptId);
    if(existingTrace) writerSelection={
      providerId:existingTrace.providerId, model:existingTrace.model,
      reasoningLevel:existingTrace.effectiveReasoningLevel, serviceTier:existingTrace.serviceTier,
      selectionSource:existingTrace.selectionSource,
    };
    let activeTask = input.task;
    let dirtBefore = input.dirtBefore ?? [];
    let baselineDirtBefore:DirtSnapshot[]|null=input.dirtBefore?[...input.dirtBefore]:null;
    let baselineWorkspacePath:string|null=input.dirtBefore?input.task.project_cwd:null;
    let executionPacketSha256:string|null = null;
    let last: Record<string, unknown> = {};
    let primaryFailure:Record<string,unknown>|null=null;
    const pmReadContext=input.pmReadContext ?? stringAt(listStageReceipts(db,input.runId,input.taskId).find((row)=>row.stageId==="pm-read")?.result,"summary") ?? "";
    let releaseWriterSlot:(()=>void)|undefined;
    void (async () => {
      const policy=runPolicyFor(input.runId);
      // "In the project folder" shares one checkout: writers there go one at a time, whatever the pool says,
      // because a parallel writer's half-done edits would land in this writer's diff and checks.
      const inPlace=parseWorkspaceMode((await effectiveProjectSettings(input.projectId,getRunSettingsScopes(db,input.runId))).values["adoc.040"])==="in_place";
      releaseWriterSlot=await runWriterPool.acquire(input.runId,inPlace?1:policy.pools.provider);
      const latestAttempt=getAttempt(db,attemptId);
      if(!latestAttempt||["canceled","blocked","accepted"].includes(latestAttempt.state)){
        if(latestAttempt?.state==="canceled"){
          markCanceledWriterStages(latestAttempt,"writer attempt canceled while waiting for provider pool");
          refreshRun(input.runId);
        }
        return;
      }
      recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"running",
        input:input.plan, attempt:countAttempts(db, input.runId, input.taskId) });
      while (countAttempts(db, input.runId, input.taskId) <= MAIN_ATTEMPT_LIMIT) {
        if (!writerThreadId) {
          const spawned = await spawnWriterAttempt({
            projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId,
            config:input.config, task:input.task, plan:input.plan, pmThreadId:input.pmThreadId, pmReadContext,
            retryIndex:Math.max(0,countAttempts(db,input.runId,input.taskId)-1),
          });
          if (!spawned.ok) {
            last = { status:spawned.status, reason:spawned.reason, attemptId:spawned.attemptId };
          } else {
            writerThreadId = spawned.threadId;
            writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
            activeTask = {...input.task,project_cwd:spawned.workspacePath,
              verification:input.task.verification.map(command=>({...command,cwd:spawned.workspacePath}))};
            dirtBefore = spawned.dirtBefore;
            baselineDirtBefore ??=[...spawned.dirtBefore];
            baselineWorkspacePath ??=spawned.workspacePath;
            executionPacketSha256 = spawned.executionPacketSha256 ?? null;
          }
        }
        if (writerThreadId) {
          last = { ...await finishWriterAttempt({
            projectId:input.projectId, config:input.config, task:activeTask, runId:input.runId,
            taskId:input.taskId, attemptId, pmThreadId:input.pmThreadId, writerThreadId, dirtBefore,
          }), ...(executionPacketSha256 ? { executionPacketSha256 } : {}) };
          const workspaceBinding=getAttempt(db,attemptId);
          if(workspaceBinding?.workspace_path) last={...last,workspace:{path:workspaceBinding.workspace_path,
            environmentId:workspaceBinding.environment_id,decision:workspaceBinding.workspace_decision}};
        }
        if (last.status === "accepted") break;
        // A failed attempt's own worktree is never merged; the next attempt starts from a fresh one.
        const failedBinding=getAttempt(db,attemptId);
        const failedBase=getRun(db,input.runId)?.writer_workspace_path;
        if(failedBinding?.workspace_path&&failedBinding.environment_id===null&&failedBase&&resolve(failedBinding.workspace_path)!==resolve(failedBase)) {
          await host.call("gitRemoveWorktree",{requestedHostId:input.config.hostId,basePath:failedBase,worktreePath:failedBinding.workspace_path},
            {hostId:input.config.hostId,timeoutMs:60_000}).catch((cause)=>bb.log.warn(`Lane Pilot could not remove worktree of ${attemptId}: ${cause instanceof Error?cause.message:String(cause)}`));
        }
        if (last.status === "spawn_rejected" && typeof last.reason === "string"
          && (last.reason.startsWith("execution_packet_failed:") || last.reason.startsWith("attempt_worktree_")
            || last.reason.startsWith("attempt_workspace_"))) {
          const rejected = getAttempt(db, attemptId);
          if (rejected?.state === "spawn_rejected") transitionAttempt(db, attemptId, "blocked", { reason:last.reason });
          last = { ...last, status:"blocked" };
          break;
        }
        if (last.status !== "accepted" && last.status !== "blocked") primaryFailure={...last};
        const failed = String(last.status) as AttemptState;
        if (!RETRY_ELIGIBLE.includes(failed)) break;
        const attempt = getAttempt(db, attemptId);
        if (attempt?.state === "spawn_unknown" || attempt?.state === "spawn_requested") {
          writerThreadId = await services.reconcileAttemptThread(input.projectId, attempt).catch(() => "");
        } else if (attempt) {
          const scanned = await reconcile({
            list: async ({ limit, offset }) => (await bb.sdk.threads.list({
              projectId:input.projectId, originPluginId:"lane-pilot", includeHidden:true, limit, offset,
            })).map((thread) => ({ id:thread.id })),
            metadata: async (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
          }, { lanePilotRunId:attempt.run_id, lanePilotTaskId:attempt.task_id, attemptId:attempt.id });
          if (scanned.kind === "blocked" || scanned.kind === "error") {
            if (scanned.kind === "blocked") transitionAttempt(db, attempt.id, "blocked", { reason:`reconcile_${scanned.reason}` });
            last = { ...last, status:"blocked", reason:scanned.kind === "blocked" ? scanned.reason : scanned.message };
            break;
          }
        }
        if (countAttempts(db, input.runId, input.taskId) >= MAIN_ATTEMPT_LIMIT) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) {
            const exhausted = `retry limit 2 exhausted${typeof last.reason === "string" && last.reason ? `: ${last.reason}` : ""}`;
            transitionAttempt(db, latest.id, "blocked", { reason:exhausted });
            last = { ...last, status:"blocked", reason:exhausted };
          }
          break;
        }
        attemptId = id("lpattempt");
        createAttempt(db, { id:attemptId, runId:input.runId, taskId:input.taskId });
        writerThreadId = undefined;
        writerSelection=undefined;
        activeTask = input.task;
        dirtBefore = [];
        executionPacketSha256 = null;
      }
      if (last.status !== "accepted" && primaryFailure) {
        const decision=emergencyFallbackDecision({
          state:String(primaryFailure.status ?? "unknown"),
          reason:typeof primaryFailure.reason === "string" ? primaryFailure.reason : null,
          stopConfirmed:primaryFailure.stopConfirmed === true,
        });
        if (decision.run) {
          const settings=loadProjectSettings(db,input.projectId,getRunSettingsScopes(db,input.runId));
          const primaryProvider=typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : input.config.writerProviderId;
          const primaryModel=typeof settings["writer.model"] === "string" && settings["writer.model"] ? settings["writer.model"] as string : input.config.writerModel;
          const emergencySelection={providerId:input.config.pmProviderId,model:input.config.pmModel};
          if (sameWriterSelection({providerId:primaryProvider,model:primaryModel},emergencySelection)) {
            last={...last,emergencyFallback:{state:"skipped",reason:"configured_pm_selection_matches_primary",trigger:decision.reason}};
          } else {
            const primaryAttemptId=typeof primaryFailure.attemptId === "string" ? primaryFailure.attemptId : attemptId;
            const emergencyAttemptId=id("lpattempt");
            createAttempt(db,{id:emergencyAttemptId,runId:input.runId,taskId:input.taskId});
            writerSelection=undefined;
            const spawned=await spawnWriterAttempt({
              projectId:input.projectId,runId:input.runId,taskId:input.taskId,attemptId:emergencyAttemptId,
              config:input.config,task:input.task,plan:input.plan,pmThreadId:input.pmThreadId,pmReadContext,
              emergency:{...emergencySelection,reason:decision.reason},
            });
            if (!spawned.ok) {
              const fallbackFailureReason=`emergency_fallback_failed:${spawned.reason}`;
              transitionAttempt(db,emergencyAttemptId,"blocked",{reason:fallbackFailureReason});
              last={status:"blocked",reason:fallbackFailureReason,attemptId:emergencyAttemptId,
                emergencyFallback:{state:"failed",reason:spawned.reason,trigger:decision.reason,attemptId:emergencyAttemptId}};
              writerThreadId=undefined;
            } else {
              writerThreadId=spawned.threadId;
              writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
              activeTask={...input.task,project_cwd:spawned.workspacePath,
                verification:input.task.verification.map(command=>({...command,cwd:spawned.workspacePath}))};
              executionPacketSha256=spawned.executionPacketSha256 ?? null;
              const fallbackWorkspace=getAttempt(db,emergencyAttemptId)?.workspace_path;
              dirtBefore=baselineWorkspacePath&&fallbackWorkspace===baselineWorkspacePath
                ? baselineDirtBefore??spawned.dirtBefore : spawned.dirtBefore;
              const emergencyFallback={reason:decision.reason,primaryAttemptId,providerId:emergencySelection.providerId,model:emergencySelection.model};
              last={...await finishWriterAttempt({
                projectId:input.projectId,config:input.config,task:activeTask,runId:input.runId,taskId:input.taskId,
                attemptId:emergencyAttemptId,pmThreadId:input.pmThreadId,writerThreadId,dirtBefore,
                emergencyFallback,
              }),emergencyFallback:{state:"completed",...emergencyFallback,attemptId:emergencyAttemptId}};
              const workspaceBinding=getAttempt(db,emergencyAttemptId);
              if(workspaceBinding?.workspace_path) last={...last,workspace:{path:workspaceBinding.workspace_path,
                environmentId:workspaceBinding.environment_id,decision:workspaceBinding.workspace_decision}};
            }
          }
        }
      }
      const accepted = last.status === "accepted";
      const reason = accepted ? undefined : String(last.reason ?? last.status ?? "writer_failed");
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
        if (current?.state === "pending") {
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
        }
        const terminal = accepted ? "passed" : last.status === "canceled" ? "canceled" : "failed";
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:terminal,
          input:input.plan, attempt:Math.min(countAttempts(db, input.runId, input.taskId),MAIN_ATTEMPT_LIMIT),
          providerId:stageId==="writer-agent"?writerSelection?.providerId:undefined,
          model:stageId==="writer-agent"?writerSelection?.model:undefined,threadId:writerThreadId,
          result:stageId === "writer-agent" ? {
            ...last,
            execution: writerSelection ? {
              providerId:writerSelection.providerId,
              model:writerSelection.model,
              reasoningLevel:writerSelection.reasoningLevel ?? null,
              serviceTier:writerSelection.serviceTier ?? null,
              selectionSource:writerSelection.selectionSource ?? null,
            } : last,
          } : accepted ? stageId === "verification"
            ? { produced:last.produced, verification:last.verification, runV2:last.runV2 }
            : last : null, reason:accepted ? undefined : reason });
      }
      refreshRun(input.runId);
      if (accepted) services.maintainMemoryAfterAcceptance(input.projectId, input.runId, input.taskId, input.pmThreadId);
      if (accepted) services.maintainProjectLifeAfterAcceptance(input.projectId, input.runId, input.taskId, input.pmThreadId);
    })().catch((cause: unknown) => {
      // After a reload the database is closed: stop quietly, the next load reconciles the attempt.
      if (ctx.state.disposed) return;
      try {
        const message = cause instanceof Error ? cause.message : String(cause);
        const reason = `internal_error: ${message}`;
        bb.log.error(`Lane Pilot writer attempt ${attemptId} failed: ${message}`);
        const attempt = getAttempt(db, attemptId);
        if(attempt?.state==="canceled"){
          markCanceledWriterStages(attempt,"writer attempt canceled before provider dispatch");
          refreshRun(input.runId);
          return;
        }
        if (attempt && ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested", "provider_error", "timeout", "empty_output", "validation_failed"].includes(attempt.state)) {
          transitionAttempt(db, attemptId, "blocked", { threadId:writerThreadId, reason });
        }
        for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
          const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
          if (!current || current.state === "passed" || current.state === "failed" || current.state === "skipped") continue;
          if (current.state === "pending") recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId,
            state:"failed", input:input.plan,
            attempt:Math.min(countAttempts(db, input.runId, input.taskId),MAIN_ATTEMPT_LIMIT),
            providerId:stageId==="writer-agent"?writerSelection?.providerId:undefined,
            model:stageId==="writer-agent"?writerSelection?.model:undefined,threadId:writerThreadId, reason });
        }
        try {
          refreshRun(input.runId);
        } catch (refreshCause) {
          bb.log.error(`Lane Pilot failed to refresh run ${input.runId} after attempt ${attemptId} error: ${refreshCause instanceof Error ? refreshCause.message : String(refreshCause)}`);
        }
      } catch (inner) {
        // A failure while recording the failure must never escape a detached task and crash BB.
        try { bb.log.error(`Lane Pilot writer attempt ${attemptId} could not record its failure: ${inner instanceof Error ? inner.message : String(inner)}`); } catch { /* ctx.state.disposed */ }
      }
    }).finally(() => {
      releaseWriterSlot?.();
      activeWriterTasks.delete(key);
    });
  }

  async function readWriterWorkspaceFile(args:{
    threadId:string; projectId:string; path:string; offset:number; maxLines:number;
  }): Promise<Record<string, unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    const run = getRun(db, runId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId) {
      throw new Error("run does not belong to this PM thread and project");
    }
    const hostId = getRunWriterHost(db, runId);
    const workspacePath = run.writer_workspace_path;
    if (!hostId || !workspacePath) throw new Error("run has no frozen writer host or workspace binding");
    if (args.path.includes("\0") || isAbsolute(args.path)) throw new Error("lane_pilot_read_path_escaped_workspace");
    const absolute = resolve(workspacePath, args.path);
    const rel = relative(workspacePath, absolute);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("lane_pilot_read_path_escaped_workspace");
    const file = await host.call("readBoundedFile", {
      requestedHostId: hostId,
      projectCwd: workspacePath,
      relativePath: rel.split("\\").join("/"),
      offset: args.offset,
      maxLines: args.maxLines,
    }, { hostId, timeoutMs: 15_000 });
    if (file.hostId !== hostId) throw new Error("lane_pilot_read_host_mismatch");
    return file;
  }

  async function dispatchWriter(args:{threadId:string; projectId:string; task?:TaskV2; plan?:string; baseRef?:string}): Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    // Settings of the section this run works in, read by every stage below.
    await ensureRunScopes(runId);
    const run = getRun(db, runId);
    // A native run's host, workspace and writer come from its binding and current settings, never from a stale prototype config.
    const config = await configForRun(args.projectId, run);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${args.projectId}`);
    const workspacePath = run?.writer_workspace_path;
    if (!run || !workspacePath) {
      const reason = "run has no persisted writerWorkspacePath; reactivate Lane Pilot to create a run with a workspace snapshot";
      return { runId, state:"rejected", reason, unapplied:[{ key:"task.project_cwd", reason }] };
    }
    const runConfig = { ...config, writerWorkspacePath:workspacePath };
    if (listTaskKinds(db, runId).includes("cli")) {
      throw new Error("V1: BB writer cannot join a CLI run-controller run");
    }
    const taskId = args.task ? freeTaskId(db, args.task.id) : id("lptask");
    const prepared = args.task ? { ...args.task, id:taskId } : buildTask(runConfig, taskId);
    const canonicalPlan = args.plan ?? prepared.objective;
    if (canonicalPlan.trim().length === 0) throw new Error("canonical plan must be non-empty");
    const valid = validateTaskV2(prepared);
    if (!valid.ok) throw new Error(`task-v2 invalid: ${valid.errors.join("; ")}`);
    if (resolve(valid.task.project_cwd) !== resolve(workspacePath)) {
      const reason = `task.project_cwd must equal the configured writerWorkspacePath (${workspacePath})`;
      return { runId, state:"rejected", reason, unapplied:[{ key:"task.project_cwd", reason }] };
    }
    valid.task.project_cwd = workspacePath;
    createTask(db, { id:taskId, runId, kind:"bb", contract:valid.task });
    saveTaskPlan(db, taskId, canonicalPlan);
    const rejectPreflight = (reason:string):Record<string,unknown> => {
      recordStage(db, { runId, taskId, stageId:"plan-critique", state:"blocked", input:canonicalPlan, reason });
      recordStage(db, { runId, taskId, stageId:"pm-read", state:"skipped", input:canonicalPlan,
        reason:"task preflight failed before stage execution" });
      recordStage(db, { runId, taskId, stageId:"specialist-review", state:"skipped", input:canonicalPlan, reason:"task preflight failed before stage execution" });
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        recordStage(db, { runId, taskId, stageId, state:"skipped", input:canonicalPlan,
          reason:"task preflight failed before stage execution" });
      }
      setRunState(db, runId, "blocked");
      refreshRun(runId);
      return { runId, taskId, state:"blocked", reason, stages:listStageReceipts(db, runId, taskId) };
    };
    let readFirstHints: ReturnType<typeof parseReadFirstHints>;
    try {
      readFirstHints = parseReadFirstHints(valid.task.read_first);
    } catch (cause) {
      return rejectPreflight(cause instanceof Error ? cause.message : String(cause));
    }
    if (readFirstHints.length) {
      try {
        const snapshot = await host.call("snapshotDryRun", {
          requestedHostId:config.hostId,
          paths:readFirstHints.map((hint) => resolve(workspacePath, hint.path)),
        }, { hostId:config.hostId, timeoutMs:30_000 });
        for (const hint of readFirstHints) {
          const entry = snapshot.entries.find((row) => row.path === resolve(workspacePath, hint.path));
          if (entry?.kind === "directory") {
            const kindError = readFirstKindError(hint.path, "directory");
            if (kindError) return rejectPreflight(kindError);
          }
          if (entry?.kind === "symlink" || entry?.kind === "other") {
            return rejectPreflight(`read_first is not a regular file (${entry.kind}): ${hint.path}`);
          }
        }
      } catch {
        // Listing is best-effort; spawn still fail-closes if the source cannot be read.
      }
    }
    const ownershipError = validateOwnershipContract(valid.task);
    if (ownershipError) return rejectPreflight(ownershipError);
    if (run.run_gate === "pre-merge") {
      const reason = "explicit_review_gate_requires_operator";
      recordStage(db,{runId,taskId,stageId:"run-gate",state:"blocked",input:JSON.stringify({gate:run.run_gate,planSha256:sha256(canonicalPlan)}),
        result:{decision:"operator_review_required",gate:run.run_gate,writerDispatched:false},reason});
      for(const stageId of ["pm-read","plan-critique","specialist-review","writer-agent","verification","acceptance-receipt"] as const) {
        recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason:"run gate stopped execution before automated stage dispatch"});
      }
      setRunState(db,runId,"blocked");
      return {runId,taskId,state:"blocked",reason,gate:run.run_gate,writerDispatched:false,stages:listStageReceipts(db,runId,taskId)};
    }
    const pmRead=await runPmRead({bb,db,projectId:args.projectId,runId,taskId,pmThreadId:args.threadId,config:runConfig,task:valid.task});
    if(pmRead.state==="failed") {
      const reason=`pm_read_failed:${pmRead.reason ?? "unknown"}`;
      recordStage(db,{runId,taskId,stageId:"plan-critique",state:"skipped",input:canonicalPlan,reason:"PM read stage failed"});
      recordStage(db,{runId,taskId,stageId:"specialist-review",state:"skipped",input:canonicalPlan,reason:"PM read stage failed"});
      for(const stageId of ["writer-agent","verification","acceptance-receipt"] as const) recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason:"PM read stage failed"});
      setRunState(db,runId,"blocked");
      refreshRun(runId);
      return {runId,taskId,state:"blocked",reason,stages:listStageReceipts(db,runId,taskId)};
    }
    const critique = await runPlanCritique({ bb, db, projectId:args.projectId, runId, taskId,
      config:runConfig, task:valid.task, plan:canonicalPlan, pmReadContext:pmRead.summary || undefined });
    if (!critique.allowed) {
      recordStage(db, { runId, taskId, stageId:"specialist-review", state:"skipped", input:canonicalPlan,
        reason:"plan-critique did not allow dispatch" });
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        recordStage(db, { runId, taskId, stageId, state:"skipped", input:canonicalPlan,
          reason:"upstream plan-critique stage did not pass" });
      }
      setRunState(db, runId, "blocked");
      return { runId, taskId, state:"blocked", reason:critique.reason, stages:listStageReceipts(db, runId, taskId) };
    }
    const specialist = await runSpecialistReview({bb,db,projectId:args.projectId,runId,taskId,
      config:runConfig,task:valid.task,plan:canonicalPlan});
    if (!specialist.allowed) {
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason:"specialist review did not allow dispatch"});
      }
      setRunState(db,runId,"blocked");
      return {runId,taskId,state:"blocked",reason:specialist.reason,stages:listStageReceipts(db,runId,taskId)};
    }
    const gitBase=await host.call("gitOwnershipBase",{
      requestedHostId:config.hostId,projectCwd:workspacePath,...(args.baseRef===undefined?{}:{baseRef:args.baseRef}),
    },{hostId:config.hostId,timeoutMs:30_000});
    if(gitBase.status!=="ready"&&(args.baseRef!==undefined||gitBase.status!=="not-git")) {
      const reason=`git ownership base unavailable: ${gitBase.reason??gitBase.status}`;
      recordStage(db,{runId,taskId,stageId:"run-gate",state:"blocked",input:canonicalPlan,
        result:{decision:"ownership_base_unavailable",baseRef:args.baseRef??null},reason});
      for(const stageId of ["writer-agent","verification","acceptance-receipt"] as const) {
        recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason:"git ownership base preflight failed"});
      }
      setRunState(db,runId,"blocked");
      refreshRun(runId);
      return {runId,taskId,state:"blocked",reason,stages:listStageReceipts(db,runId,taskId)};
    }
    if(gitBase.status==="ready"&&!saveTaskGitBase(db,taskId,{
      baseRef:gitBase.baseRef,baseSha:gitBase.baseSha,initialHeadSha:gitBase.headSha!,branch:gitBase.branch!,compareCommitted:gitBase.compareCommitted,
    })) {
      const reason="could not persist immutable git ownership base snapshot";
      recordStage(db,{runId,taskId,stageId:"run-gate",state:"blocked",input:canonicalPlan,result:{decision:"ownership_base_persist_failed"},reason});
      for(const stageId of ["writer-agent","verification","acceptance-receipt"] as const) recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason});
      setRunState(db,runId,"blocked");refreshRun(runId);
      return {runId,taskId,state:"blocked",reason,stages:listStageReceipts(db,runId,taskId)};
    }
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
      recordStage(db, { runId, taskId, stageId, state:"pending", input:canonicalPlan });
    }
    const attemptId = id("lpattempt");
    createAttempt(db, { id:attemptId, runId, taskId });
    startWriterTask({
      projectId:args.projectId, runId, taskId, firstAttemptId:attemptId,
      pmThreadId:args.threadId, config:runConfig, task:valid.task, plan:canonicalPlan, pmReadContext:pmRead.summary || undefined,
    });
    return { runId, attemptId, writerThreadId:null, state:"queued", stages:listStageReceipts(db, runId, taskId) };
  }

  async function waitWriter(args:{threadId:string; projectId:string; runId:string; timeoutSec:number}): Promise<Record<string, unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm" || stringAt(metadata, "lanePilotRunId") !== args.runId) {
      throw new Error("runId does not belong to this Lane Pilot PM thread");
    }
    const run = getRun(db, args.runId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId) {
      throw new Error("run does not belong to this PM thread and project");
    }
    const deadline = Date.now() + Math.min(240, Math.max(1, args.timeoutSec)) * 1000;
    while (Date.now() < deadline) {
      // A plugin reload closes this instance's database; the writer keeps running, so ask for a fresh poll.
      if (ctx.state.disposed) return { runId:args.runId, state:"running", reason:"Lane Pilot was reloaded; call lane_pilot_wait_writer again" };
      const listedRun = listRunsWithAttempts(db, args.projectId).find((item) => item.id === args.runId);
      const latestByTask = new Map<string, {id:string;state:string;attempt_no:number;thread_id:string|null;reason:string|null;task_id:string}>();
      for (const attempt of listedRun?.attempts ?? []) {
        if (!latestByTask.has(attempt.task_id) || latestByTask.get(attempt.task_id)!.attempt_no < attempt.attempt_no) {
          latestByTask.set(attempt.task_id, attempt);
        }
      }
      if (latestByTask.size === 0) {
        const stages = listStageReceipts(db, args.runId);
        const writerStage = stages.find((row) => row.stageId === "writer-agent");
        if (writerStage?.state === "skipped" && writerStage.reason) {
          const reason = stages.find((row) => row.stageId === "plan-critique")?.reason ?? writerStage.reason;
          return { runId:args.runId, state:"blocked", receipt:null, stages, ...(reason ? { reason } : {}) };
        }
      }
      for (const attempt of latestByTask.values()) {
        if ((attempt.state !== "running" && attempt.state !== "cancel_requested") || !attempt.thread_id) continue;
        const thread = await getThreadBounded(attempt.thread_id);
        const threadStatus = stringAt(thread, "status");
        if (threadStatus === "error" || (attempt.state === "cancel_requested" && threadStatus === "idle")) {
          const failedState = attempt.state === "cancel_requested" ? "canceled" : "provider_error";
          const reason = attempt.state === "cancel_requested" ? "writer stop observed" : "writer thread status error";
          transitionAttempt(db, attempt.id, failedState, { reason });
          refreshRun(args.runId);
          latestByTask.set(attempt.task_id, { ...attempt, state:failedState, reason });
        }
      }
      for (const attempt of latestByTask.values()) {
        const key = `${args.runId}:${attempt.task_id}`;
        if (attempt.state !== "provider_error" || activeWriterTasks.has(key)) continue;
        const task = getTask(db, attempt.task_id);
        const currentRun = getRun(db, args.runId);
        const config = await configForRun(args.projectId, currentRun);
        const parsed = task?.kind === "bb" ? taskV2Schema.safeParse(task.contract) : null;
        if (currentRun?.writer_workspace_path && currentRun.pm_thread_id && config && parsed?.success) {
          const taskWorkspace=acceptedTaskWorkspace(args.runId,attempt.task_id,currentRun.writer_workspace_path,parsed.data,attempt.id);
          startWriterTask({
            projectId:args.projectId,
            runId:args.runId,
            taskId:attempt.task_id,
            firstAttemptId:attempt.id,
            pmThreadId:currentRun.pm_thread_id,
            writerThreadId:attempt.thread_id ?? undefined,
            config:{ ...config, writerWorkspacePath:taskWorkspace.path },
            task:taskWorkspace.task,
            plan:getTaskPlan(db, attempt.task_id) ?? parsed.data.objective,
          });
        }
      }
      const states = listTaskTerminalStates(db, args.runId);
      const state = states.length && states.every((item) => !["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(item))
        ? (states.includes("accepted") ? "accepted" : states.includes("blocked") ? "blocked" : states.at(-1)!)
        : "running";
      if (state !== "running") {
        // A finished task records its stage receipts just before it leaves activeWriterTasks; wait for that.
        if ([...activeWriterTasks].some((key) => key.startsWith(`${args.runId}:`))) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        // writer.lastResult is one project-wide slot that the last accepted task overwrites; read each task's own receipt.
        const settings = loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
        const lastResult = settings["writer.lastResult"];
        const taskReceipts = [...latestByTask.values()].flatMap((attempt) => {
          const stage = listStageReceipts(db, args.runId, attempt.task_id).find((row) => row.stageId === "acceptance-receipt");
          const base = stage?.state === "passed" && stage.result && typeof stage.result === "object" ? stage.result
            : valueAt(lastResult, "lanePilotRunId") === args.runId && valueAt(lastResult, "lanePilotTaskId") === attempt.task_id ? lastResult : null;
          if (!base || typeof base !== "object") return [];
          const trace = getReasoningTrace(db, attempt.id);
          return [{ ...base as Record<string, unknown>, reasoning:trace ? [trace] : [] }];
        });
        const receipt = taskReceipts.length > 1 ? { lanePilotRunId:args.runId, tasks:taskReceipts } : taskReceipts[0] ?? null;
        const reasons = [...latestByTask.values()].map((attempt) => attempt.reason).filter((reason): reason is string => Boolean(reason));
        return { runId:args.runId, state, receipt, stages:listStageReceipts(db, args.runId), ...(reasons.length ? { reason:reasons.join("; ") } : {}) };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const attempts = listOpenAttempts(db).filter((attempt) => attempt.run_id === args.runId);
    const writerThreadId = attempts.at(-1)?.thread_id ?? null;
    return {
      runId:args.runId,
      attemptId:attempts.at(-1)?.id ?? null,
      writerThreadId,
      state:"running",
      stages:listStageReceipts(db, args.runId),
      ...(writerThreadId
        ? { message:"Писатель ещё работает. Вызови lane_pilot_wait_writer ещё раз с тем же runId." }
        : { writerStarted:false, message:"Писатель ещё не создан. Старт не закончен или не прошёл. Вызови lane_pilot_wait_writer ещё раз с тем же runId." }),
    };
  }

  async function dispatchCli(args:{
    threadId:string; projectId:string; binary?:"run-controller"|"lane-ctl"; subcommand?:string;
    taskFile?:string; taskId?:string; runDir?:string;
  }): Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    const config = loadPrototypeConfig(db, args.projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${args.projectId}`);
    if (listTaskKinds(db, runId).includes("bb")) {
      throw new Error("V1: CLI writer cannot join a BB writer run");
    }
    const binary = args.binary ?? "run-controller";
    const subcommand = args.subcommand ?? "run";
    const settings = await cliSettingsFor(args.projectId, config);
    const runDir = args.runDir
      ?? (typeof settings["ops.run_dir"] === "string" ? settings["ops.run_dir"] : undefined)
      ?? `${config.writerWorkspacePath}/.agents/runs/lane-pilot-${runId}`;
    const invocation = buildCliInvocation({
      binary,
      subcommand,
      settings,
      required: requiredCliFlags({
        binary,
        subcommand,
        runDir,
        projectCwd: String(settings["ops.project_cwd"] ?? config.writerWorkspacePath),
        taskFile: args.taskFile ?? (typeof settings["ops.task_file"] === "string" ? settings["ops.task_file"] : undefined),
        taskId: args.taskId ?? (typeof settings["ops.task_id"] === "string" ? settings["ops.task_id"] : undefined),
      }),
    });
    const invalidSetting = invocation.unapplied.find((row) => row.reason.startsWith("invalid value;"));
    if (invalidSetting) {
      return {
        status:"blocked",
        reason:`invalid setting ${invalidSetting.key}: ${invalidSetting.reason}`,
        applied:invocation.applied,
        unapplied:invocation.unapplied,
        argv:invocation.argv,
        env:invocation.env,
      };
    }
    const executed = await host.call("runCli", {
      requestedHostId: config.hostId,
      binary,
      argv: invocation.argv,
      env: invocation.env,
      cwd: config.writerWorkspacePath,
    }, { hostId:config.hostId, timeoutMs:180_000 });
    const outcome = classifyCliOutcome({
      subcommand,
      exitCode:executed.exitCode,
      stdout:executed.stdout,
    });
    const receiptPath = `${runDir}/cli-receipt.json`;
    const receipt = {
      schemaVersion:1,
      kind:"cli",
      status: outcome.status,
      taskAccepted: outcome.taskAccepted,
      upstreamAccepted: outcome.upstreamAccepted,
      upstreamStatus: outcome.upstreamStatus,
      reason: outcome.reason,
      lanePilotRunId:runId,
      pmThreadId:args.threadId,
      binary,
      argv: executed.argv,
      env: executed.env,
      exitCode: executed.exitCode,
      stdout: executed.stdout,
      stderr: executed.stderr,
      applied: invocation.applied,
      unapplied: invocation.unapplied,
      receiptPath,
    };
    await bb.sdk.files.write({
      hostId: config.hostId,
      rootPath: config.writerWorkspacePath,
      path: receiptPath,
      content: `${JSON.stringify(receipt, null, 2)}\n`,
      contentEncoding: "utf8",
      createParents: true,
      expectedSha256: null,
    });
    const mutating = subcommand === "start" || subcommand === "run";
    let attemptId: string | null = null;
    if (mutating) {
      const existing = db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=? AND kind='cli'")
        .get(runId) as { id: string } | undefined;
      const taskId = existing?.id ?? id("lptask");
      if (!existing) {
        createTask(db, { id: taskId, runId, kind:"cli", contract:{ binary, subcommand, argv:executed.argv, receiptPath } });
      }
      attemptId = id("lpattempt");
      createAttempt(db, { id: attemptId, runId, taskId });
      transitionAttempt(db, attemptId, outcome.status, { reason: outcome.reason });
    }
    saveProjectSetting(db, args.projectId, cliReceiptRunKey(runId), JSON.stringify(receipt));
    if (attemptId) {
      saveProjectSetting(db, args.projectId, cliReceiptAttemptKey(attemptId), JSON.stringify(receipt));
    }
    setRunState(db, runId, outcome.status);
    return receipt;
  }

  return { activeWriterTasks, runWriterPool, spawnWriterAttempt, workspaceDirt, runVerification, persistWriterAcceptance, validateWriterResult, finishWriterAttempt, startWriterTask, readWriterWorkspaceFile, dispatchWriter, waitWriter, dispatchCli };
}
