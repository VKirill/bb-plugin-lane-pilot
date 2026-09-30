import { breakerKey } from "@lane-pilot/resilience";
import { parseDirtSnapshots } from "../../cli-outcome";
import type { DirtSnapshot } from "../../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, saveReasoningTrace, searchMemoryRecords, setAttemptDirtBefore, setAttemptHolderThread, setAttemptWorkspace, setReasoningThread, transitionAttempt } from "../../database";
import { automaticEffortRoutingEnabled, bbServiceTier, resolveJevReasoning, writerExecutionSelection, writerServiceTier } from "../../jev-reasoning";
import { spawnWithSeam } from "../../spawn-seam";
import { buildExecutionPacket, renderExecutionPacket } from "../../stages/execution-packet";
import { memoryContext, parseMemorySettings } from "../../stages/memory";
import { resolveRetryEffort } from "../../stages/retry-effort";
import { boundedAgentName } from "../../stages/role";
import { WORKSPACE_DIRT_COMMAND } from "../../workspace-dirt";
import { parseWorkspaceMode, requireManagedWorktreeProvider, resolveAttemptWorkspace, resolveManagedWorkspace, waitManagedWorktreeReady } from "../../workspace/routing";
import { fullAccessSpawn } from "../pm-spawn";
import { WriterSelectionError, helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../run-routing";
import { stringAt } from "../values";
import { planDigest, writerPrompt } from "../writer-task";
import { resolve } from "node:path";
import type { ServerCore } from "../core";
import type { Services } from "../services";

export function createWriterSpawn(ctx: ServerCore, services: Services) {
  const { bb, db, effectiveProjectSettings, host } = ctx;

  async function spawnWriterAttempt(input: {
    projectId:string; runId:string; taskId:string; attemptId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; pmThreadId:string; pmReadContext?:string;
    emergency?:{providerId:string;model:string;reason:string}; retryIndex?:number;
  }): Promise<
    | { ok:true; threadId:string; providerId:string|null; model:string|null; reasoningLevel?:string; serviceTier?:"default"|"fast"|null; selectionSource?:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"}; dirtBefore:import("../../cli-outcome").DirtSnapshot[]; workspacePath:string; executionPacketSha256?:string }
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
      if (!input.emergency) {
        const gate = services.providerBreaker.decide(breakerKey(writerProviderId, writerModel));
        if (!gate.allow) {
          const reason = `writer_provider_unavailable:breaker_open:${gate.reason}`;
          transitionAttempt(db, input.attemptId, "spawn_rejected", { reason });
          return { ok:false, status:"spawn_rejected", reason, attemptId:input.attemptId };
        }
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

  return { spawnWriterAttempt, workspaceDirt };
}
