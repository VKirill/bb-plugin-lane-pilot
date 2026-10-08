import { breakerKey, RunBudgetExceeded } from "@lane-pilot/resilience";
import { recordMemoryMixed } from "@lane-pilot/memory-core";
import { mixWriterMemory } from "../../memory/server/memory-mix";
import { parseDirtSnapshots } from "../cli-outcome";
import type { DirtSnapshot } from "../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { acceptedRules, pickRelevantRules, ruleRelevanceQuestions, ruleRelevanceState } from "@lane-pilot/run-insights";
import { HARNESS_VERSION, endSpawnFailure, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, saveReasoningTrace, setAttemptDirtBefore, setAttemptEnvironment, setAttemptHolderThread, setAttemptWorkspace, setReasoningThread, transitionAttempt } from "../../storage/database";
import { automaticEffortRoutingEnabled, bbServiceTier, resolveJevReasoning, writerExecutionSelection, writerServiceTier, findModelIn } from "@lane-pilot/models";
import { spawnWithSeam } from "../spawn-seam";
import { buildExecutionPacket, renderExecutionPacket } from "../../tasks/execution-packet";
import { parseMemorySettings } from "../../memory/memory";
import { resolveRetryEffort } from "../../critique/retry-effort";
import { boundedAgentName } from "../../critique/role";
import { WORKSPACE_DIRT_COMMAND } from "../../verification/workspace-dirt";
import { LIVE_FOLDER_REASON, liveOwnedFiles } from "../live-folder";
import { createLiveFolder } from "./live-folder";
import { parseWorkspaceMode, requireManagedWorktreeProvider, resolveAttemptWorkspace, resolveManagedWorkspace, waitManagedWorktreeReady } from "../../verification/routing";
import { createProviderGate, providerListed, providerSwitchOn, waitProviderEnvironment } from "../../verification/provider-gate";
import { LANE_WORKTREE_PROVIDER_ID } from "../../native-agent/server/environment-provider";
import { fullAccessSpawn } from "../../core/server/pm-spawn";
import { WriterSelectionError, helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server/run-routing";
import { holderSpawnKey, stringAt } from "../../core/server/values";
import { planDigest, writerBriefInput, writerBriefSegments, type TaskFolderBrief } from "./writer-task";
import { areaHistoryText, loadArea } from "./sticky";
import { taskFolderRel } from "../../verification/git-integrate";
import { resolve } from "node:path";
import type { ServerCore } from "../../core/server/core";
import type { Services } from "../../core/server/services";
import { runOnHost } from "@lane-pilot/host-calls";

/** True when the run works in the project's own checkout on that machine, which BB's managed worktree can fork. */
export async function isProjectRootCheckout(bb: { sdk: { projects: { get(args: { projectId: string }): Promise<unknown> } } }, projectId: string, hostId: string, path: string): Promise<boolean> {
  const project = await bb.sdk.projects.get({ projectId }).catch(() => null) as { sources?: Array<{ hostId?: string; path?: string }> } | null;
  return (project?.sources ?? []).some((source) => source.hostId === hostId && typeof source.path === "string" && resolve(source.path) === resolve(path));
}

export function worktreeCreateError(reason: string | null): string {
  return `attempt_worktree_failed:${reason ?? "unknown"}`;
}

/** The project has a root source on this host and the run folder is not it: BB's managed worktree would fork that root. */
async function hasOtherRootSource(bb:ServerCore["bb"], projectId:string, hostId:string, path:string):Promise<boolean> {
  // A lookup that cannot run (it may throw before returning a promise) keeps the old path: BB's managed worktree.
  const project = await Promise.resolve().then(() => bb.sdk.projects.get({ projectId })).catch(() => null) as { sources?: Array<{ hostId?: string; path?: string }> } | null;
  const roots = (project?.sources ?? []).filter((source) => source.hostId === hostId && typeof source.path === "string");
  return roots.length > 0 && !roots.some((source) => resolve(source.path!) === resolve(path));
}

/** True when the attempt already works in the run folder, so there is no worktree to merge or remove. */
export function shouldMergeAttemptWorktree(workspacePath:string|null|undefined, basePath:string|null|undefined):boolean {
  return Boolean(workspacePath && basePath && resolve(workspacePath) !== resolve(basePath));
}

/** A writer's environment from Lane Pilot's own provider (H9), over a worktree Lane Pilot already made. */
type ProviderEnvironment = { type:"provider"; environmentProviderId:string; inputs:{basePath:string;name:string;path:string}; machine:{type:"existing";hostId:string} };

type WriterEnvironment = ProviderEnvironment | {type:"reuse";environmentId:string} | {type:"host";hostId:string;workspace:{type:"unmanaged";path:string}};

/** BB refused or lost the provider itself (not a budget, a network or a bad request): the attempt may go on the old path. */
const providerRefusal = (cause:unknown) => /environment[ _-]?provider/i.test(cause instanceof Error ? cause.message : String(cause));

function inPlaceEnvironment(hostId:string, workspacePath:string, environmentId:string|null):
  {type:"reuse";environmentId:string}|{type:"host";hostId:string;workspace:{type:"unmanaged";path:string}} {
  return environmentId
    ? { type:"reuse", environmentId }
    : { type:"host", hostId, workspace:{ type:"unmanaged", path:workspacePath } };
}

async function listTaskFolder(bb:{sdk:{files:{read(args:{hostId:string;rootPath:string;path:string}):Promise<unknown>;listPaths(args:{hostId:string;path:string;includeFiles:boolean;includeDirectories:boolean;includeHidden:boolean;limit:number}):Promise<{paths?:Array<{kind?:string;name?:string;path?:string}>}>}}},
  hostId:string, workspacePath:string, taskId:string):Promise<TaskFolderBrief|null> {
  const rel = taskFolderRel(taskId);
  if (!rel) return null;
  const file = await bb.sdk.files.read({ hostId, rootPath:workspacePath, path:resolve(workspacePath, rel, "PLAN.md") }).catch(() => null);
  const content = file && typeof file === "object" ? (file as { content?:unknown }).content : null;
  if (typeof content !== "string") return null;
  const files = new Set<string>(["PLAN.md"]);
  const listed = await bb.sdk.files.listPaths({
    hostId, path:resolve(workspacePath, rel), includeFiles:true, includeDirectories:false, includeHidden:true, limit:100,
  }).catch(() => null);
  for (const entry of listed?.paths ?? []) {
    if (entry.kind !== "file") continue;
    const name = typeof entry.name === "string" && entry.name ? entry.name
      : typeof entry.path === "string" ? entry.path.replace(/^.*\//, "") : "";
    if (name && !name.includes("..") && !name.includes("/")) files.add(name);
  }
  return { path:`${rel}/`, files:[...files].sort() };
}

export function createWriterSpawn(ctx: ServerCore, services: Services) {
  const { bb, db, effectiveProjectSettings, host } = ctx;
  const liveFolder = createLiveFolder(ctx);
  const providerGate = createProviderGate({ kv:bb.storage.kv, serialized:(work) => ctx.serializedKv(work), version:HARNESS_VERSION, warn:(message) => bb.log.warn(message) });

  /** Why this attempt does not use the provider (null: it does). Anything but the owner's own switch is one log line. */
  async function providerSkipReason(projectId:string, hostId:string, attemptId:string, settings:Record<string,unknown>):Promise<string|null> {
    if (!providerSwitchOn(settings["workspace.provider"])) return "switched off by workspace.provider";
    const reason = !await providerGate.usable(hostId) ? "switched off on this machine after three provider errors"
      : !await providerListed((args) => bb.sdk.environments.listProviders(args), LANE_WORKTREE_PROVIDER_ID, projectId, hostId) ? "this BB does not offer it"
      : null;
    if (reason) bb.log.info(`Lane Pilot writer ${attemptId}: worktree provider not used (${reason}); the old worktree path`);
    return reason;
  }

  /**
   * System One picks the accepted rules this task needs, so a writer's prompt does not carry every rule of the
   * project. Rules for the PM never reach a writer; rules marked for every task skip the question. Without an
   * answer every rule of that chunk goes in: a missing rule costs more than an extra one.
   */
  async function relevantRules<T extends { rule:string; audience:string; always:boolean }>(rules:T[],task:Record<string,unknown>,hostId:string):Promise<T[]> {
    const forWriter=rules.filter((rule)=>rule.audience!=="pm");
    const asked=forWriter.filter((rule)=>!rule.always);
    const chunks:T[][]=[];
    for(let start=0;start<asked.length;start+=8) chunks.push(asked.slice(start,start+8));
    const state=JSON.stringify(ruleRelevanceState(task)).slice(0,60_000);
    // Chunks are independent questions; asking them together keeps the wait at one answer (~0.5–1 s).
    const answered=await Promise.all(chunks.map(async(chunk)=>{
      const judged=await host.call("councilJudge",{requestedHostId:hostId,state,questions:ruleRelevanceQuestions(chunk)},{hostId,timeoutMs:6_000}).catch(()=>null);
      return judged?.status==="ok"?pickRelevantRules(chunk,judged.answers,judged.confidence??{},undefined,judged.probabilities??{}):chunk;
    }));
    const picked=new Set([...forWriter.filter((rule)=>rule.always),...answered.flat()]);
    return forWriter.filter((rule)=>picked.has(rule));
  }

  async function spawnWriterAttempt(input: {
    projectId:string; runId:string; taskId:string; attemptId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; pmThreadId:string; pmReadContext?:string;
    /** A fallback writer: its model, and its effort when it is one of the writer's fallbacks (the PM's model has none). */
    emergency?:{providerId:string;model:string;reason:string;reasoningLevel?:string}; retryIndex?:number;
    /** The previous attempt's failure, for a retry (`previousAttemptBrief`). */
    previousAttempt?:string;
  }): Promise<
    | { ok:true; threadId:string; providerId:string|null; model:string|null; reasoningLevel?:string; serviceTier?:"default"|"fast"|null; selectionSource?:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"}; dirtBefore:import("../cli-outcome").DirtSnapshot[]; workspacePath:string; executionPacketSha256?:string }
    | { ok:false; status:"spawn_rejected" | "canceled" | "blocked"; reason:string; attemptId:string }
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
      // Every writer attempt, of a native Lane chat or a dispatched task of any risk, gets its own worktree (in_place is
      // gone, decision 2026-10-06): parallel writers never share a checkout, and acceptance merges each one into main.
      const nativeRun = getRun(db, input.runId)?.kind === "cli";
      const routed = resolveAttemptWorkspace({mode:workspaceMode,risk:input.task.risk,
        expectedOutputCount:input.task.expected_outputs.length,minScore,multiWriteEnabled});
      // A folder without git has no worktree to give: the writer edits the live files in the run's folder.
      const live = await liveFolder.isLiveFolder(input.runId,input.config.hostId,getRun(db,input.runId)?.writer_workspace_path ?? input.task.project_cwd);
      const workspaceDecision = live ? {...routed,strategy:"inherit_run" as const,reason:LIVE_FOLDER_REASON as typeof routed.reason} : routed;
      const sourcePreflight=await workspaceDirt(input.config,input.task.project_cwd,input.runId);
      if(!sourcePreflight.ok) throw new WriterSelectionError(`attempt_workspace_snapshot_failed:${sourcePreflight.reason}`);
      let dirtBefore=sourcePreflight.snapshots;
      const memorySettings=parseMemorySettings(settings);
      const taskMemoryQuery=`${input.task.title}\n${input.task.objective}\n${input.task.acceptance.join(" ")}`;
      const memoryOn=memorySettings.enabled&&memorySettings.inject;
      // Confirmed rules reach every writer; retrieval skips their records so they are not repeated as memory.
      // Rules of the run's own sections only: a client's rule never reaches another client's writer.
      const allRules=memoryOn?acceptedRules(db,input.projectId,await services.ruleScan.chainForRun(input.runId)):[];
      const ruleMemoryIds=new Set(allRules.map((rule)=>rule.memoryId));
      const rules=await relevantRules(allRules,input.task as unknown as Record<string,unknown>,input.config.hostId);
      const rulesText=rules.map((rule)=>`- ${rule.rule}`).join("\n");
      // A fresh writer of an area hears what its earlier tasks decided, in place of the thread that remembered it.
      const areaHistory=input.task.area?areaHistoryText(await loadArea(bb.storage.kv,input.projectId,input.task.area)):"";
      // The writer gets at most three notes that name a path of this task; other helpers keep the budgeted context.
      const mixed=memoryOn?mixWriterMemory(db,{projectId:input.projectId,query:taskMemoryQuery,task:input.task,searchEngine:memorySettings.searchEngine,personalBot:memorySettings.personalBot,ruleMemoryIds}):{text:"",ids:[] as string[]};
      const relevantMemory={text:[areaHistory,mixed.text].filter(Boolean).join("\n\n")};
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
          return { ok:false, status:endSpawnFailure(db, input.attemptId, reason), reason, attemptId:input.attemptId };
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
      const model = findModelIn(catalog.models, writerModel);
      if (!model) throw new WriterSelectionError(`writer_model_unavailable:${writerProviderId}/${writerModel}`);
      const tierIds = new Set(provider.serviceTiers?.map((tier) => tier.id) ?? []);
      if (requestedServiceTier === "fast" && !tierIds.has("fast")) {
        throw new WriterSelectionError(`writer_service_tier_unavailable:${writerProviderId}/fast`);
      }
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
      // Set when the attempt's worktree is a BB environment of Lane Pilot's own provider; `environment` is then the old
      // path's answer for the same worktree, which the attempt falls back to.
      let providerEnvironment:ProviderEnvironment|null=null;
      if (workspaceDecision.strategy === "provision_attempt_worktree") {
        const bound=getAttempt(db,input.attemptId);
        const onProvider=bound?.workspace_path&&bound.environment_id ? null
          : await prepareProviderWorktree(input,settings,bound,run.writer_workspace_path,workspaceDecision);
        if (bound?.workspace_path && bound.environment_id) {
          workspacePath=bound.workspace_path;
          environment={type:"reuse",environmentId:bound.environment_id};
        } else if (onProvider) {
          workspacePath=onProvider.path;
          if(onProvider.dirtBefore) dirtBefore=onProvider.dirtBefore;
          providerEnvironment={type:"provider",environmentProviderId:LANE_WORKTREE_PROVIDER_ID,machine:{type:"existing",hostId:input.config.hostId},
            inputs:{basePath:run.writer_workspace_path,name:input.attemptId,path:workspacePath}};
          environment=inPlaceEnvironment(input.config.hostId,workspacePath,null);
        // BB's managed worktree forks the project's root source; a run folder that is not it (a section with its own
        // repo inside a non-git project, live sandbox 2026-10-07: «no usable git branch») needs Lane Pilot's own.
        } else if ((nativeRun ? !await isProjectRootCheckout(bb, input.projectId, input.config.hostId, run.writer_workspace_path)
            : await hasOtherRootSource(bb, input.projectId, input.config.hostId, run.writer_workspace_path))
          // BB's managed worktree starts the writer at the repo root; a folder nested in a larger repo needs the same
          // subfolder inside the worktree, which only Lane Pilot's own worktree gives (OVH live check 2026-10-07).
          || await nestedInRepo(input.config.hostId, run.writer_workspace_path)) {
          // BB's managed worktree always forks the project root; a Lane chat in a section with its own
          // repository gets a git worktree of that repository from Lane Pilot instead (~/.lane-pilot/worktrees).
          // A chat in a subfolder of a larger repo gets a worktree of that repo and works in the same subfolder there.
          if (bound?.workspace_path) {
            workspacePath=bound.workspace_path;
            environment=inPlaceEnvironment(input.config.hostId,workspacePath,bound.environment_id);
          } else {
            const created=await host.call("gitCreateWorktree",{requestedHostId:input.config.hostId,basePath:run.writer_workspace_path,name:input.attemptId},
              {hostId:input.config.hostId,timeoutMs:60_000});
            if(created.status==="ready"&&created.path) {
              workspacePath=created.path;
              await host.call("gitPrepareWorktree",{requestedHostId:input.config.hostId,basePath:run.writer_workspace_path,worktreePath:workspacePath},
                {hostId:input.config.hostId,timeoutMs:600_000}).catch(()=>undefined);
              const prepared=await workspaceDirt(input.config,workspacePath,input.runId);
              if(!prepared.ok) throw new WriterSelectionError(`attempt_worktree_baseline_failed:${prepared.reason}`);
              dirtBefore=prepared.snapshots;
              if(!setAttemptWorkspace(db,input.attemptId,{path:workspacePath,environmentId:null,decision:workspaceDecision})) {
                throw new WriterSelectionError("attempt_workspace_cas_conflict");
              }
              environment={type:"host",hostId:input.config.hostId,workspace:{type:"unmanaged",path:workspacePath}};
            } else {
              throw new WriterSelectionError(worktreeCreateError(created.reason));
            }
          }
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
          await bb.storage.kv.set(holderSpawnKey(input.attemptId),Date.now());
          const holder = await spawnWithSeam(() => fullAccessSpawn(bb, {
            projectId:input.projectId, ...execution,
            prompt:"Make no file changes and reply with the single word OK.",
            environment:{type:"host",hostId:input.config.hostId,workspace:{type:"managed-worktree",baseBranch:{kind:"default"}}},
            visibility:"hidden",pluginMetadata:{role:"workspace-provisioner",lanePilotRunId:input.runId,lanePilotTaskId:input.taskId,workspaceAttemptId:input.attemptId},
          }));
          holderThreadId=stringAt(holder,"id");
          spawnEnvironmentId=stringAt(holder,"environmentId");
          if(!holderThreadId) throw new WriterSelectionError("attempt_worktree_provision_missing_thread");
          const recorded=setAttemptHolderThread(db,input.attemptId,holderThreadId);
          if(recorded) await bb.storage.kv.delete(holderSpawnKey(input.attemptId)).catch(()=>undefined);
          if(!recorded) {
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
        const prepared=await workspaceDirt(input.config,workspacePath,input.runId);
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
      if(live) {
        // The owned files are copied aside before the writer touches them; a rejected attempt is rolled back from them.
        const saved=await liveFolder.backupLiveFolder({hostId:input.config.hostId,folder:workspacePath,backupId:input.attemptId,
          files:liveOwnedFiles(dirtBefore.map(row=>row.path),input.task)});
        if(!saved.ok) throw new WriterSelectionError(`attempt_workspace_backup_failed:${saved.reason}`);
      }
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
      const taskFolder = await listTaskFolder(bb, input.config.hostId, workspacePath, input.taskId);
      const briefSegments = writerBriefSegments(attemptTask,relevantMemory.text,executionPacket,input.emergency
        ? "fallback"  // the reason stays in the trace; the writer is only told it is the fallback
        : undefined,writerAgent,input.pmReadContext ?? "",rulesText,input.previousAttempt ?? "",taskFolder,live);
      const writerBrief = briefSegments.map(segment=>segment.text).join("\n\n");
      const existingTrace = getReasoningTrace(db, input.attemptId);
      if (existingTrace) {
        // The brief is final: each note in it counts one use; the attempt's acceptance later credits the same ids.
        recordMemoryMixed(db, input.projectId, mixed.ids);
        saveReasoningTrace(db, {
          ...existingTrace,
          dispatchContext:{
            memoryText:relevantMemory.text,
            memoryPicked:mixed.ids,
            rulesText,
            rulesPicked:{total:allRules.length,picked:rules.map((rule)=>rule.id)},
            executionPacket,
            executionPacketSha256,
            pmReadContext:input.pmReadContext ?? "",
            agent:writerAgent,
            promptChars:writerBrief.length,
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
      const launchArgs = {
        ...placement,
        ...requiredPolicyField(bb, helperSnapshot, writerProviderId, "writer"),
        ...execution,
        input: writerBriefInput(attemptTask, briefSegments, writerProviderId),
        pluginMetadata:{
          role:input.emergency ? "emergency-writer" : "writer",
          lanePilotRunId:input.runId,
          lanePilotTaskId:input.taskId,
          attemptId:input.attemptId,
          parentPmThreadId:input.pmThreadId,
        },
      };
      const launch = (target:WriterEnvironment) => spawnWithSeam(() => fullAccessSpawn(bb, { ...launchArgs, environment:target }));
      const spawned = providerEnvironment ? await launchOnProvider({ input, providerEnvironment, fallback:environment, launch }) : await launch(environment);
      const writerThreadId = stringAt(spawned, "id") ?? "";
      if (!writerThreadId) throw new Error("threads.spawn returned no writer thread id");
      // Canceled while its thread was being made: stop the thread it got and end here.
      if (getAttempt(db, input.attemptId)?.state === "cancel_requested") {
        await bb.sdk.threads.stop({ threadId:writerThreadId }).catch(() => undefined);
        transitionAttempt(db, input.attemptId, "canceled", { threadId:writerThreadId, reason:"canceled while its writer was starting" });
        return { ok:false, status:"canceled", reason:"canceled while its writer was starting", attemptId:input.attemptId };
      }
      transitionAttempt(db, input.attemptId, "running", { threadId:writerThreadId });
      setReasoningThread(db, input.attemptId, writerThreadId);
      const spawnedTrace = getReasoningTrace(db, input.attemptId);
      if (spawnedTrace) bb.log.info(`Lane Pilot writer execution ${JSON.stringify({ attemptId:input.attemptId, threadId:writerThreadId, providerId:spawnedTrace.providerId, model:spawnedTrace.model, reasoningLevel:spawnedTrace.effectiveReasoningLevel, serviceTier:spawnedTrace.serviceTier })}`);
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
      return { ok:true, threadId: await services.reconcileAttemptThread(input.projectId, attempt), providerId:selectedProviderId, model:selectedModel, dirtBefore:attempt.dirt_before,
        workspacePath:attempt.workspace_path ?? input.task.project_cwd };
    }
  }

  /**
   * The attempt's worktree as a BB environment of Lane Pilot's own provider. Lane Pilot makes the worktree first (the
   * packet, the task folder and the dirt baseline are read from it before the thread exists) and the provider adopts it,
   * so no holder thread and no model turn is spent on it. Null, with one log line, whenever the old path should serve
   * the attempt: the owner's switch, a core without the API, a machine whose provider was switched off, a worktree that
   * could not be made (the old path makes it again, or the managed one).
   */
  async function prepareProviderWorktree(input:{projectId:string;runId:string;attemptId:string;config:PrototypeConfig}, settings:Record<string,unknown>,
    bound:{workspace_path:string|null}|null|undefined, basePath:string, decision:unknown):Promise<{path:string;dirtBefore:DirtSnapshot[]|null}|null> {
    const hostId=input.config.hostId;
    if (await providerSkipReason(input.projectId,hostId,input.attemptId,settings)) return null;
    if (bound?.workspace_path) return {path:bound.workspace_path,dirtBefore:null};
    const created=await host.call("gitCreateWorktree",{requestedHostId:hostId,basePath,name:input.attemptId},{hostId,timeoutMs:60_000}).catch(()=>null);
    if(!created||created.status!=="ready"||!created.path) {
      bb.log.info(`Lane Pilot writer ${input.attemptId}: no worktree for the provider (${created?.reason ?? "no answer"}); the old worktree path`);
      return null;
    }
    await host.call("gitPrepareWorktree",{requestedHostId:hostId,basePath,worktreePath:created.path},{hostId,timeoutMs:600_000}).catch(()=>undefined);
    // Until the attempt row holds the path no sweep knows the worktree (about 2 GB each): a refusal below removes it here.
    const dropWorktree=async (reason:string) => {
      if (getAttempt(db,input.attemptId)?.workspace_path===created.path) return;
      await host.call("gitRemoveWorktree",{requestedHostId:hostId,basePath,worktreePath:created.path!},{hostId,timeoutMs:60_000})
        .catch((cause)=>bb.log.warn(`Lane Pilot could not remove the worktree of ${input.attemptId} after ${reason}: ${cause instanceof Error?cause.message:String(cause)}`));
    };
    const prepared=await workspaceDirt(input.config,created.path,input.runId).catch(async (cause)=>{ await dropWorktree("a baseline error"); throw cause; });
    if(!prepared.ok) { await dropWorktree("a failed baseline"); throw new WriterSelectionError(`attempt_worktree_baseline_failed:${prepared.reason}`); }
    if(!setAttemptWorkspace(db,input.attemptId,{path:created.path,environmentId:null,decision})) { await dropWorktree("a binding conflict"); throw new WriterSelectionError("attempt_workspace_cas_conflict"); }
    return {path:created.path,dirtBefore:prepared.snapshots};
  }

  /**
   * Starts the writer on the provider's environment and waits for it to be ready. When BB refuses the provider, its
   * create errors or it does not come up in time, the attempt starts again on the old path over the same worktree: it
   * is not failed and not charged. The machine's error count moves on each; the third in a row switches the provider off there.
   */
  async function launchOnProvider(args:{input:{attemptId:string;config:PrototypeConfig};providerEnvironment:ProviderEnvironment;fallback:WriterEnvironment;
    launch:(target:WriterEnvironment)=>Promise<unknown>}):Promise<unknown> {
    const { input, providerEnvironment, launch } = args;
    const hostId=input.config.hostId;
    const fallBack=async (reason:string) => {
      bb.log.info(`Lane Pilot writer ${input.attemptId}: worktree provider error (${reason.replace(/\bfailed\b/gi,"error").slice(0,200)}); the old worktree path`);
      await providerGate.failed(hostId,reason);
      return await launch(args.fallback);
    };
    let spawned:unknown;
    try { spawned=await launch(providerEnvironment); }
    catch (cause) {
      if (!providerRefusal(cause)) throw cause;
      return await fallBack(cause instanceof Error ? cause.message : String(cause));
    }
    const threadId=stringAt(spawned,"id");
    if (!threadId) return spawned;
    const ready=await waitProviderEnvironment({threadId,spawnEnvironmentId:stringAt(spawned,"environmentId"),expectedPath:providerEnvironment.inputs.path,
      getThread:async (id)=>bb.sdk.threads.get({threadId:id}),getEnvironment:async (id)=>bb.sdk.environments.get({environmentId:id})});
    if (!ready.ok) {
      // The thread never started a turn (its first message waits for the environment): it goes, the worktree stays.
      await bb.sdk.threads.stop({threadId}).catch(()=>undefined);
      await bb.sdk.threads.archive({threadId}).catch(()=>undefined);
      return await fallBack(ready.reason);
    }
    setAttemptEnvironment(db,input.attemptId,ready.environmentId);
    await providerGate.succeeded(hostId);
    return spawned;
  }

  /** Whether the folder is a subfolder of a larger git repo, asked on its own host (the hub may not see the folder). */
  async function nestedInRepo(hostId:string, folder:string):Promise<boolean> {
    const ran = await runOnHost(host, { hostId, cwd: folder, command: "git rev-parse --show-prefix", timeoutSec: 15 }).catch(() => null);
    return Boolean(ran && ran.exitCode === 0 && /^[^\n]+\/\s*$/.test(ran.stdout));
  }

  async function workspaceDirt(config: PrototypeConfig, workspacePath = config.writerWorkspacePath, runId?: string): Promise<{ ok:true; paths:string[]; snapshots:DirtSnapshot[] } | { ok:false; reason:string }> {
    // A folder without git has no dirt to list: its whole content is the snapshot, and an attempt's work is the difference.
    if (await liveFolder.isLiveFolder(runId, config.hostId, workspacePath)) return liveFolder.liveSnapshot(config.hostId, workspacePath);
    // The command runs in the workspace on its own host and answers workspace-relative paths, also for a subfolder
    // of a larger repo; the server may not see that folder at all.
    const ran = await runOnHost(host, { hostId: config.hostId, cwd: workspacePath, command: WORKSPACE_DIRT_COMMAND, timeoutSec: 30, timeoutMs: 30_000 }).catch((cause: unknown) => ({
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

  return { spawnWriterAttempt, workspaceDirt, isLiveFolder:liveFolder.isLiveFolder, backupLiveFolder:liveFolder.backupLiveFolder, restoreLiveFolder:liveFolder.restoreLiveFolder };
}
