import { unownedExpectedOutputs } from "../../tasks";
import { hostContract, taskV2Schema } from "../../contracts";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { claimStageSpawn, countAttempts, getRun, getTask, listLiveTasksForRun, listOpenAttempts, listStageReceipts, openDatabase } from "../../storage";
import { criticAcrossFamilies, criticOffSpent, criticPairCandidates, effortAfterMove, latestWriterPair, pairApartFromWriter, roleSelection, sdkCriticCatalog } from "../critic-pair";
import { bbServiceTier, writerExecutionSelection, writerServiceTier, findModelIn, modelFamily, type SpentProbe } from "@lane-pilot/models";
import { qaSpawnClaimed } from "../../qa";
import { reconcileCritic } from "../../stability";
import { resolveStageWriterSelection } from "../../writer";
import { MAX_FILE_EXCERPT_BYTES } from "../code-critique";
import { codeCritiquePrompt, codeCritiqueSource, codeCritiqueStops, criticPersonas, critiqueFromStageResult, critiquePolicyFromResult, freezeCritiquePolicy, parseCodeCritique, parseCodeCritiqueSettings, persistLedgerFields, settingsFromFrozenPolicy, unionCriticFails } from "../code-critique";
import { critiqueFromScreen, screenCodeCritique } from "../critic-screen";
import type { CandidateEvidence, FrozenCritiquePolicy } from "../code-critique";
import { sha256 } from "../../tasks";
import { critiquePrompt, parseCritique, shouldRunPlanCritique } from "../critique";
import { binaryOutputs, findTaskPlaceholderPaths } from "../critique-coverage";
import type { CoverageFinding } from "../critique-coverage";
import { buildExecutionPacket, renderPacketExcerpts } from "../../tasks/execution-packet";
import { parsePmReadResult, parsePmReadSettings, pmReadPrompt } from "../pm-read";
import { boundedAgentName } from "../role";
import { candidateCitations, inputCitations } from "../citations";
import { parseSpecialistResult, shouldRunSpecialist, specialistPrompt } from "../specialist";
import { reasonForStatus } from "@lane-pilot/workflow-engine";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, resolveCodeCriticDefault, resolveQualityMode } from "../quality-mode";
import type { CodeCriticDefault } from "../quality-mode";
import type { Verdict, VerdictStatus } from "@lane-pilot/workflow-engine";
import { MAIN_ATTEMPT_LIMIT } from "../../runs";
import { configuredSetting, spawnUsageOf, stageHelperSettings, warmSpawnUsage, zcodeBusyPeek } from "../../core/server";
import { fullAccessSpawn, graphStepMetadata } from "../../core/server";
import { reviewerMemoryFor } from "../../memory/server";
import { clearSpawnMarker } from "../../core/server";
import { CRITIC_OUTCOME_UNKNOWN, criticReconcilePort, helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { recordStage } from "../../runs/server";
import { stringAt } from "../../core/server";
import { dependsOnTask } from "../../writer/server/start";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { resolve } from "node:path";
/** Whether a provider's usage window is nearly spent, read from the cache the writers share (a bounded warm-up first); undefined without a usage source. */
async function limitProbe(bb: BbPluginApi, hostId: string, settings: Record<string, unknown>): Promise<SpentProbe | undefined> {
  const usage = spawnUsageOf({ bb });
  if (!usage) return undefined;
  await warmSpawnUsage(usage, hostId);
  return (providerId, model) => usage.peek({ providerId, model, hostId, settings });
}
const settingOff = (value: unknown) => value === false || value === 0
  || (typeof value === "string" && ["0", "off", "false", "no"].includes(value.trim().toLowerCase()));
const settingOn = (value: unknown) => value === true || value === 1
  || (typeof value === "string" && ["1", "true", "on", "yes"].includes(value.trim().toLowerCase()));

/** One log line per limit move of a stage's model. */
const logLimitMove = (bb: BbPluginApi, what: string, issues: readonly string[] | undefined) => {
  for (const issue of issues ?? []) bb.log.info(`${what}: ${issue}`);
};

export async function runPmRead(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;taskId:string;pmThreadId:string;config:PrototypeConfig;task:TaskV2;workflow?:{runId:string;stepKey:string;nodeId:string}})
  :Promise<{state:"skipped"|"passed"|"failed";summary:string;reason?:string}> {
  const settings=await stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  const parsedSettings=parsePmReadSettings(Object.fromEntries([
    "pm_read.enabled","pm_read.min_lines","pm_read.provider","pm_read.model","pm_read.reasoning_effort","pm_read.service_tier",
  ].map((key)=>[key,configuredSetting(settings,key)])));
  // The input is what was read and how, not which model read it: the model pick asks the provider catalog, and a summary of the
  // same read_first stays good. A receipt of other read_first (lane_pilot_update_task) is read again (2026-10-29 audit: it
  // returned the old summary without reading the new files).
  const source=JSON.stringify({taskId:input.taskId,readFirst:input.task.read_first,settings:parsedSettings});
  const base={runId:input.runId,taskId:input.taskId,stageId:"pm-read" as const,input:source,attempt:Math.min(countAttempts(input.db,input.runId,input.taskId),MAIN_ATTEMPT_LIMIT)};
  const existing=listStageReceipts(input.db,input.runId,input.taskId).find((row)=>row.stageId==="pm-read");
  if(existing&&existing.inputSha256===sha256(source)) {
    const summary=stringAt(existing.result,"summary")??"";
    return {state:existing.state==="passed"?"passed":existing.state==="skipped"?"skipped":"failed",summary,...(existing.reason?{reason:existing.reason}:{})};
  }
  // A disabled stage is decided before the catalog is asked for a model it would not use.
  if(!parsedSettings.enabled) {
    recordStage(input.db,{...base,state:"pending",replaceOnNewInput:true,restart:true});
    recordStage(input.db,{...base,state:"skipped",reason:"disabled_by_project_setting"});
    return {state:"skipped",summary:""};
  }
  // The summary feeds the plan critic and the code critic. When both are off (a project switch, or quality_mode quick),
  // the read would call a model nobody uses. The graph still reaches this node before the quality-mode fork.
  const qualityMode = resolveQualityMode(input.task, settings[QUALITY_MODE_SETTING]);
  const reviewed = applyCodeCriticDefault(applyQualityMode(settings, qualityMode), qualityMode, input.task.risk, resolveCodeCriticDefault(settings[CODE_CRITIC_DEFAULT_SETTING]));
  if (settingOff(reviewed["plan_critique.enabled"]) && !settingOn(reviewed["code_critique.enabled"])) {
    recordStage(input.db,{...base,state:"pending",replaceOnNewInput:true,restart:true});
    recordStage(input.db,{...base,state:"skipped",reason:qualityMode === "quick" ? "quality_mode_quick" : "critics_disabled"});
    return {state:"skipped",summary:""};
  }
  const fallback=resolveStageWriterSelection({settings,config:input.config});
  // One role table (packages/models/src/role-models.ts): the owner's row, else the pm_read selection, else the default; the old pick stands when the host lacks it.
  const picked=await roleSelection({zcodeBusy:zcodeBusyPeek(input.bb),catalog:sdkCriticCatalog(input.bb,input.config.hostId),settings,role:"pm-reader",fallback:{providerId:parsedSettings.provider??fallback.providerId,model:parsedSettings.model??fallback.model},spent:await limitProbe(input.bb,input.config.hostId,settings)});
  logLimitMove(input.bb,`pm read for ${input.taskId}`,picked.issues);
  const providerId=picked.providerId;
  const modelId=picked.model;
  parsedSettings.effort=picked.effort??parsedSettings.effort;
  recordStage(input.db,{...base,state:"pending",providerId,model:modelId,replaceOnNewInput:true,restart:true});
  let threadId:string|null=null;
  // Pending until the excerpts clear the size threshold: a small read_first is skipped, and skipped
  // is not reachable from running.
  recordStage(input.db,{...base,state:"pending",providerId,model:modelId});
  let started=false;
  try {
    const packet=await buildExecutionPacket(input.task.read_first,async(path)=>{
      const file=await input.bb.sdk.files.read({hostId:input.config.hostId,rootPath:input.task.project_cwd,path:resolve(input.task.project_cwd, path)});
      if(typeof file.content!=="string") return null;
      return {content:file.content,contentEncoding:file.contentEncoding,sha256:file.sha256,sizeBytes:file.sizeBytes};
    });
    const selectedLines=packet.entries.reduce((total,entry)=>total+entry.windows.reduce((sum,window)=>sum+window.excerpt.split(/\r?\n/).length,0),0);
    if(selectedLines<parsedSettings.minLines) {
      const result={selectedLines,minLines:parsedSettings.minLines,packetSha256:packet.sha256,summary:""};
      recordStage(input.db,{...base,state:"skipped",providerId,model:modelId,result,reason:"read_first_below_min_lines"});
      return {state:"skipped",summary:""};
    }
    recordStage(input.db,{...base,state:"running",providerId,model:modelId}); started=true;
    const [providers,catalog]=await Promise.all([
      input.bb.sdk.providers.list({hostId:input.config.hostId}),
      input.bb.sdk.providers.models({providerId,hostId:input.config.hostId}),
    ]);
    const provider=providers.find((row)=>row.id===providerId&&row.available);
    const model=catalog.models.find((row)=>row.id===modelId||row.model===modelId);
    if(!provider||!model) throw new Error("pm_read_provider_or_model_unavailable");
    if(!model.supportedReasoningEfforts.some((row)=>row.reasoningEffort===parsedSettings.effort)) throw new Error(`pm_read_reasoning_effort_unsupported:${parsedSettings.effort}`);
    const serviceTier=provider.capabilities.supportsServiceTier?bbServiceTier(parsedSettings.serviceTier):null;
    if(serviceTier&&!(provider.serviceTiers??[]).some((row)=>row.id===serviceTier)) throw new Error(`pm_read_service_tier_unsupported:${serviceTier}`);
    const helperPolicy=requireHelperSpawn(input);
    const placement=await helperChildPlacement({
      bb:input.bb, db:input.db, projectId:input.projectId, runId:input.runId, role:"pm-reader", taskTitle:input.task.title,
    });
    const spawned=await fullAccessSpawn(input.bb, {
      ...placement,
      ...requiredPolicyField(input.bb, helperPolicy, providerId, "pm-reader"),
      ...writerExecutionSelection(providerId,modelId,parsedSettings.effort,serviceTier),
      prompt:pmReadPrompt({agent:"pm-read",packet:renderPacketExcerpts(packet),task:input.task}),
      environment:{type:"host",hostId:input.config.hostId,workspace:{type:"unmanaged",path:input.task.project_cwd}},
      pluginMetadata:{role:"pm-reader",lanePilotRunId:input.runId,lanePilotTaskId:input.taskId,stageId:"pm-read",parentPmThreadId:input.pmThreadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true,...graphStepMetadata(input.workflow)}});
    threadId=stringAt(spawned,"id");
    if(!threadId) throw new Error("pm_read_thread_id_missing");
    recordStage(input.db,{...base,state:"running",providerId,model:modelId,threadId});
    await waitThreadIdle(input.bb,threadId,"pm_read_timeout");
    const output=(await input.bb.sdk.threads.output({threadId})).output;
    if(typeof output!=="string"||!output.trim()) throw new Error("pm_read_output_empty");
    const parsed=parsePmReadResult(output);
    const summary=JSON.stringify(parsed);
    const result={...parsed,selectedLines,minLines:parsedSettings.minLines,packetSha256:packet.sha256};
    recordStage(input.db,{...base,state:"passed",providerId,model:modelId,threadId,result});
    return {state:"passed",summary};
  } catch(cause) {
    const reason=cause instanceof Error?cause.message:String(cause);
    if(threadId) {
      const thread=await input.bb.sdk.threads.get({threadId}).catch(()=>null);
      if(["active","starting"].includes(stringAt(thread,"status")??"")) await input.bb.sdk.threads.stop({threadId}).catch(()=>undefined);
    }
    if(!started) recordStage(input.db,{...base,state:"running",providerId,model:modelId});
    recordStage(input.db,{...base,state:"failed",providerId,model:modelId,threadId,reason,result:{error:reason}});
    return {state:"failed",summary:"",reason};
  }
}

/** depends_on that can never be satisfied: the task names itself, or an open task of the project that waits for it back. */
export function dependencyFindings(task:{id:string;depends_on?:readonly string[]},open:readonly {id:string;depends_on?:readonly string[]}[]):CoverageFinding[] {
  const path=`tasks/${task.id}/depends_on`,found:CoverageFinding[]=[];
  if(dependsOnTask(task.depends_on,task.id))
    found.push({code:"depends_self",path,severity:"error",finding:`Task ${task.id} lists itself in depends_on, so it would wait for itself forever; remove that entry`});
  const seen=new Set([task.id]);
  const walk=(node:{depends_on?:readonly string[]},trail:string[]):string[]|null=>{
    for(const next of open.filter((row)=>!seen.has(row.id)&&(node.depends_on??[]).some((dep)=>dependsOnTask([dep],row.id)))) {
      if(dependsOnTask(next.depends_on,task.id))return [...trail,next.id];
      seen.add(next.id);
      const cycle=walk(next,[...trail,next.id]);if(cycle)return cycle;
    }
    return null;
  };
  const cycle=walk(task,[]);
  if(cycle)found.push({code:"depends_cycle",path,severity:"error",
    finding:`Task ${task.id} depends_on ${cycle[0]}, and ${[...cycle,task.id].join(" -> ")} closes a loop of open tasks, so none of them can start; drop one depends_on edge`});
  return found;
}

/**
 * What a critic that did not pass tells the PM. A rework is the existing path (the PM fixes the plan, the writer fixes the
 * code) and keeps its reason; a block stops the task and carries the verdict's own message, in the receipt and in the reason.
 */
function verdictReasons(result:{status?:VerdictStatus;summary?:string;verdict?:Verdict}, stage:"plan-critique"|"code-critique"|"specialist-review"):{receipt:string;returned:string} {
  const rework = { receipt:stage === "specialist-review" ? "specialist_review_blocked" : "critique_changes_requested", returned:`${stage.replace("-","_")}_blocked` };
  if (result.status !== "block") return rework;
  const text = reasonForStatus("block", stage, result, rework.returned);
  return { receipt:text, returned:text };
}

export async function runPlanCritique(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;taskId:string;config:PrototypeConfig;task:TaskV2;plan:string;pmReadContext?:string;workflow?:{runId:string;stepKey:string;nodeId:string}})
  : Promise<{allowed:boolean;reason?:string;critique?:unknown}> {
  const projectSettings = await stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  // quality_mode (task, else project, else standard) decides whether this task goes through the plan critique at all.
  const qualityMode = resolveQualityMode(input.task,projectSettings[QUALITY_MODE_SETTING]);
  const settings = applyQualityMode(projectSettings,qualityMode);
  const agent = boundedAgentName(settings["plan_critique.agent"],"plan-critic");
  // quick and a disabled critique are decided first: the model pick asks the provider catalog and the coverage scan takes up
  // to 30 s, both for a critic that will not run (2026-10-29 audit).
  const enabled = settings["plan_critique.enabled"];
  const disabled = enabled === false || enabled === 0
    || (typeof enabled === "string" && ["0", "off", "false", "no"].includes(enabled.trim().toLowerCase()));
  if (qualityMode === "quick" || disabled) {
    const skip = { runId:input.runId, taskId:input.taskId, stageId:"plan-critique" as const, input:`${input.plan}\n\n${JSON.stringify(input.task)}\n\nagent=${agent}\n\npm_read=${input.pmReadContext ?? ""}` };
    recordStage(input.db, { ...skip, state:"pending", replaceOnNewInput:true, restart:true });
    recordStage(input.db, qualityMode === "quick" ? { ...skip, state:"skipped", reason:"quality_mode_quick", result:{ qualityMode } } : { ...skip, state:"skipped", reason:"disabled_by_project_setting" });
    return { allowed:true };
  }
  const legacy=resolveStageWriterSelection({settings,config:input.config,stageProviderKey:"plan_critique.provider",stageModelKey:"plan_critique.model"});
  const selection=await roleSelection({zcodeBusy:zcodeBusyPeek(input.bb),catalog:sdkCriticCatalog(input.bb,input.config.hostId),settings,role:"plan-critic",fallback:{providerId:legacy.providerId,model:legacy.model},spent:await limitProbe(input.bb,input.config.hostId,settings)});
  logLimitMove(input.bb,`plan critic for ${input.taskId}`,selection.issues);
  const providerId=selection.providerId;
  const modelId=selection.model;
  const mode = settings["plan_critique.mode"] === "advisory" ? "advisory" : "gate";
  const runTasks = listLiveTasksForRun(input.db,input.runId).map((row) => ({id:row.id,...row.contract as {lane?:string;owns_paths?:string[];verify?:TaskV2["verify"];verification?:TaskV2["verification"]}}));
  let coverageStatus:"complete"|"truncated"|"unavailable"="unavailable";
  let coveragePathCount=0;
  let structuralFindings:CoverageFinding[]=runTasks.flatMap((task)=>findTaskPlaceholderPaths(task).map((path)=>({code:"task_placeholder" as const,path:`tasks/${task.id}/${path}`,
    severity:"error" as const,finding:`Task ${task.id} contains unresolved REPLACE_ME at ${path}`}))).slice(0,10);
  // An expected file the task may not write fails every attempt (SelfyStudio 2026-10-03): caught here, before a writer runs.
  const unownedOutputs=unownedExpectedOutputs(input.task);
  const openTasks:Array<{id:string;depends_on:string[]}>=[];
  for(const row of listOpenAttempts(input.db)) {
    if(row.project_id!==input.projectId||row.task_id===input.task.id||openTasks.some((open)=>open.id===row.task_id))continue;
    const parsed=taskV2Schema.safeParse(getTask(input.db,row.task_id)?.contract);
    if(parsed.success)openTasks.push({id:row.task_id,depends_on:parsed.data.depends_on});
  }
  const planFindings:CoverageFinding[]=[...dependencyFindings(input.task,openTasks),
    ...binaryOutputs(input.task.expected_outputs).slice(0,3).map((entry)=>({code:"output_binary" as const,path:`tasks/${input.task.id}/expected_outputs`,severity:"warning" as const,
      finding:`Task ${input.task.id} expects ${entry}, a binary file a model cannot author; say in the plan where it is copied from (a package, a URL, an existing file) or drop it from expected_outputs`}))];
  structuralFindings=[...planFindings.filter((finding)=>finding.severity==="error"),...unownedOutputs.slice(0,5).map((entry)=>({code:"output_unowned" as const,path:`tasks/${input.task.id}/expected_outputs`,severity:"error" as const,
    finding:`Task ${input.task.id} expects ${entry}, which is outside its owns_paths: the writer may not create it, so no attempt can pass`})),...structuralFindings,...planFindings.filter((finding)=>finding.severity!=="error")].slice(0,10);
  try {
    const coverageHost=input.bb.hosts.experimental_client({contract:hostContract});
    const scan=await coverageHost.call("inspectCritiqueCoverage",{requestedHostId:input.config.hostId,workspacePath:input.task.project_cwd,
      plan:input.plan,tasks:runTasks.map((task)=>({id:task.id,lane:task.lane??"write",ownsPaths:task.owns_paths??[],hasVerification:task.verify==="none"||!!task.verification?.length,
        verification:(task.verification??[]).map((command)=>({command:command.command,timeoutSec:command.timeout_sec??undefined}))}))},{hostId:input.config.hostId,timeoutMs:30_000});
    coverageStatus=scan.status;coveragePathCount=scan.pathCount;// A bad command of a task already running must not block an unrelated dispatch of the run.
    structuralFindings=[...structuralFindings,...scan.findings.map((finding)=>finding.code==="verify_filter_ignored"&&finding.path!==`tasks/${input.task.id}`?{...finding,severity:"warning" as const}:finding)].slice(0,10);
  } catch {
    coverageStatus="unavailable";
  }
  if(coverageStatus==="truncated"&&!structuralFindings.some((finding)=>finding.code==="coverage_scan_truncated")) structuralFindings.push({code:"coverage_scan_truncated",path:".",severity:"info",finding:"Workspace path listing reached its file bound; ownership coverage is partial"});
  if(coverageStatus==="unavailable") structuralFindings.push({code:"coverage_scan_truncated",path:".",severity:"warning",finding:"Workspace path listing is unavailable; only plan/TaskV2 data was reviewed"});
  const source = `${input.plan}\n\n${JSON.stringify(input.task)}\n\nagent=${agent}\n\npm_read=${input.pmReadContext ?? ""}\n\nstructural_coverage=${coverageStatus}\n\nstructural_findings=${JSON.stringify(structuralFindings)}`;
  const base = { runId:input.runId, taskId:input.taskId, stageId:"plan-critique" as const, input:source };
  // A resumed dispatch keeps a critique that passed on this very input (resetHelperStages): it is not bought twice.
  const kept = listStageReceipts(input.db,input.runId,input.taskId).find((row) => row.stageId === "plan-critique");
  const structuralBlock=mode==="gate"&&structuralFindings.some((finding)=>finding.severity==="error");
  if (kept?.state === "passed" && kept.inputSha256 === sha256(source)) {
    // A structural error blocks under a gate whatever was kept: the same input without the receipt blocks too (SMA audit R-06).
    if (structuralBlock) return { allowed:false, reason:"structural_plan_critique_blocked", critique:{ structuralFindings } };
    // An advisory «changes requested» is kept as passed; read under a gate it blocks as a fresh one would (SMA audit N-06). The
    // receipt stays: passed cannot turn back, and the same input blocks the same way until the task changes.
    const keptResult = kept.result as { decision?: string } | null;
    if (mode === "gate" && keptResult?.decision === "changes_requested") {
      const why = verdictReasons(keptResult as never, "plan-critique");
      return { allowed:false, reason:why.returned, critique:kept.result };
    }
    return { allowed:true, critique:kept.result };
  }
  // An updated task runs its critique again over the receipt of the earlier contract (lane_pilot_update_task).
  recordStage(input.db, { ...base, state:"pending", replaceOnNewInput:true, restart:true });
  if(structuralBlock) {
    recordStage(input.db,{...base,state:"blocked",reason:"structural_plan_critique_blocked",result:{decision:"changes_requested",mode,
      structuralCoverage:{status:coverageStatus,pathCount:coveragePathCount},structuralFindings}});
    return {allowed:false,reason:"structural_plan_critique_blocked",critique:{structuralFindings}};
  }
  let policy:ReturnType<typeof shouldRunPlanCritique>;
  try {
    policy = shouldRunPlanCritique({
      taskRisk:input.task.risk,
      tasks:runTasks,
      minScore:settings["plan_critique.min_score"],
      minWriteTasks:settings["plan_critique.min_write_tasks"],
      onHighRisk:settings["plan_critique.on_high_risk"],
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    recordStage(input.db,{...base,state:"failed",reason,result:{error:reason,policy:"task-risk-v1"}});
    return {allowed:false,reason:`plan_critique_policy_invalid:${reason}`};
  }
  if (!policy.run) {
    recordStage(input.db,{...base,state:"skipped",reason:"below_critique_threshold",result:{
      policy:"task-risk-v1",score:policy.score,writeTaskCount:policy.writeTaskCount,decision:policy.reason,
      taskRisk:input.task.risk,structuralCoverage:{status:coverageStatus,pathCount:coveragePathCount},structuralFindings,
    }});
    return {allowed:true,reason:"plan_critique_threshold_not_met"};
  }
  recordStage(input.db, { ...base, state:"running", providerId, model:modelId });
  let threadId:string|null = null;
  try {
    const [providers, catalog] = await Promise.all([
      input.bb.sdk.providers.list({ hostId:input.config.hostId }),
      input.bb.sdk.providers.models({ providerId, hostId:input.config.hostId }),
    ]);
    const provider = providers.find((row) => row.id === providerId && row.available);
    const model = findModelIn(catalog.models, modelId);
    if (!provider || !model) throw new Error("critique_provider_or_model_unavailable");
    const levels = model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
    const configuredEffort = selection.effort ?? (typeof settings["plan_critique.reasoning_effort"] === "string"
      ? settings["plan_critique.reasoning_effort"] as string
      : typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : "medium");
    if (!new Set<string>(levels).has(configuredEffort)) throw new Error(`critique_reasoning_effort_unsupported:${configuredEffort}`);
    const savedTier = settings["plan_critique.service_tier"];
    const tier = savedTier === "fast" || savedTier === "standard" ? savedTier : writerServiceTier(settings);
    const serviceTier = provider.capabilities.supportsServiceTier ? bbServiceTier(tier) : null;
    if (serviceTier && !(provider.serviceTiers ?? []).some((item) => item.id === serviceTier)) {
      throw new Error(`critique_service_tier_unsupported:${serviceTier}`);
    }
    const helperPolicy=requireHelperSpawn(input);
    const placement = await helperChildPlacement({
      bb:input.bb, db:input.db, projectId:input.projectId, runId:input.runId, role:"plan-critic", taskTitle:input.task.title,
    });
    const spawned = await fullAccessSpawn(input.bb, {
      ...placement,
      ...requiredPolicyField(input.bb, helperPolicy, providerId, "plan-critic"),
      ...writerExecutionSelection(providerId, modelId, configuredEffort, serviceTier),
      prompt:critiquePrompt({ plan:input.plan, task:input.task, agent, pmReadContext:input.pmReadContext, structuralFindings }),
      environment:{ type:"host", hostId:input.config.hostId,
        workspace:{ type:"unmanaged", path:input.task.project_cwd } },
      pluginMetadata:{ role:"plan-critic", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
        stageId:"plan-critique", parentPmThreadId:getRun(input.db, input.runId)?.pm_thread_id ?? null,
        helperMode:helperPolicy.mode, helperRequired:helperPolicy.policy?.required===true, ...graphStepMetadata(input.workflow) },
    });
    threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("critique_thread_id_missing");
    recordStage(input.db, { ...base, state:"running", providerId, model:modelId, threadId });
    await waitThreadIdle(input.bb,threadId,"critique_thread_timeout");
    const raw = (await input.bb.sdk.threads.output({ threadId })).output;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
    const critique = parseCritique(raw, inputCitations(JSON.stringify(input.task), input.plan, input.pmReadContext ?? "", JSON.stringify(structuralFindings)));
    const blocked = critique.decision === "changes_requested" && mode === "gate";
    const result = { ...critique, mode, ...(qualityMode !== "standard" ? { qualityMode } : {}), structuralCoverage:{status:coverageStatus,pathCount:coveragePathCount}, structuralFindings, rawOutput:raw.slice(0, 12_000) };
    const why = verdictReasons(critique, "plan-critique");
    recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
      threadId, result, reason:blocked ? why.receipt : undefined });
    return blocked ? { allowed:false, reason:why.returned, critique:result } : { allowed:true, critique:result };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (threadId) {
      const thread = await input.bb.sdk.threads.get({ threadId }).catch(() => null);
      if (stringAt(thread, "status") === "active" || stringAt(thread, "status") === "starting") {
        await input.bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      }
    }
    recordStage(input.db, { ...base, state:"failed", providerId, model:modelId, threadId, reason,
      result:{ error:reason } });
    return { allowed:false, reason:`plan_critique_failed:${reason}` };
  }
}

/**
 * The BB environment the task's attempt works in. BB refuses a thread at a path inside an environment's directory
 * (HTTP 409 «reuse that environment instead»), so a critic of a worktree attempt runs in that environment.
 */
/**
 * The change of each produced file as BB's own unified diff (environments.diffPatch, uncommitted) in the attempt's environment, else
 * in the BB environment at the task folder. A path BB cut or could not diff is left out: the packet then shows its file.
 */
export async function candidatePatches(bb:{ sdk:{ environments:{ list:(args:{ hostId:string; path:string }) => Promise<Array<{ id:string }>>; diffPatch:(args:{ environmentId:string; paths:string[]; target:{ type:"uncommitted" } }) => Promise<unknown> } } },
  db:ReturnType<typeof openDatabase>, input:{ runId:string; taskId:string; hostId:string; cwd:string; paths:string[] }):Promise<Record<string,string>> {
  if (!input.paths.length) return {};
  try {
    const environmentId = attemptEnvironment(db, input.runId, input.taskId, input.cwd)?.environmentId
      ?? (await bb.sdk.environments.list({ hostId:input.hostId, path:input.cwd }))[0]?.id;
    if (!environmentId) return {};
    const result = await bb.sdk.environments.diffPatch({ environmentId, paths:input.paths, target:{ type:"uncommitted" } }) as { outcome?:string; patches?:Array<{ path:string; patch:string; truncated:boolean }> };
    if (result.outcome !== "available") return {};
    const wanted = new Set(input.paths);
    return Object.fromEntries((result.patches ?? []).filter((row) => wanted.has(row.path) && !row.truncated && row.patch).map((row) => [row.path, row.patch]));
  } catch {
    return {};
  }
}

/**
 * Reads the code critic's answer; one that cannot be read is sent back once to the same critic with the parse error, instead of
 * blocking a finished task (selfystudio 2026-10-30: an unescaped quote broke the JSON of a «pass»). A second unreadable answer fails.
 */
export async function readCodeCritique(bb:BbPluginApi, threadId:string|null|undefined, raw:string, cites:Parameters<typeof parseCodeCritique>[1]) {
  try {
    return parseCodeCritique(raw, cites);
  } catch (first) {
    if (!threadId) throw first;
    const why = (first instanceof Error ? first.message : String(first)).replace(/\s+/g, " ").slice(0, 600);
    const askedAt = Date.now();
    try {
      await bb.sdk.threads.send({ threadId, mode:"queue-if-active", input:[{ type:"text", mentions:[], text:`Lane Pilot: your answer could not be read (${why}). Send the same verdict again as one valid JSON object with the keys status, summary, findings and evidence, and nothing else; escape every quote inside a string.` }] } as never);
      await waitThreadIdle(bb, threadId, "critique_thread_timeout", undefined, askedAt);
    } catch {
      throw first;
    }
    const again = (await bb.sdk.threads.output({ threadId })).output;
    if (typeof again !== "string" || !again.trim()) throw first;
    return parseCodeCritique(again, cites);
  }
}

export function attemptEnvironment(db:ReturnType<typeof openDatabase>, runId:string, taskId:string, path:string):{ type:"reuse"; environmentId:string } | null {
  const row = db.prepare(`SELECT environment_id AS environmentId FROM lane_pilot_attempt
    WHERE run_id=? AND task_id=? AND workspace_path=? AND environment_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(runId, taskId, path) as { environmentId:string } | undefined;
  return row ? { type:"reuse", environmentId:row.environmentId } : null;
}

export async function runCodeCritique(input:{
  bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;taskId:string;
  config:PrototypeConfig;task:TaskV2;evidence:CandidateEvidence;disputes?:unknown;frozenPolicy?:FrozenCritiquePolicy;
  /** This task's `critic.code.default_for_risk` when the dispatch carried one; else the project's setting decides. */
  criticDefault?:CodeCriticDefault;
  /** The graph step the review runs inside (the `writer` node of the task's pipeline run): the critic's thread carries its ids. */
  workflow?:{runId:string;stepKey?:string;nodeId?:string};
}): Promise<{allowed:boolean;reason?:string;review:"passed"|"not_required";critique?:unknown;parsed?:ReturnType<typeof parseCodeCritique>;settings?:ReturnType<typeof parseCodeCritiqueSettings>;policy?:FrozenCritiquePolicy}> {
  // The code check on the critic's opinion: a finding's line must exist in the file the critic was shown.
  const cites = candidateCitations(input.evidence.files, MAX_FILE_EXCERPT_BYTES);
  const projectSettings = await stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  const qualityMode = resolveQualityMode(input.task,projectSettings[QUALITY_MODE_SETTING]);
  const settings = applyCodeCriticDefault(applyQualityMode(projectSettings,qualityMode),qualityMode,input.task.risk,resolveCodeCriticDefault(projectSettings[CODE_CRITIC_DEFAULT_SETTING],input.criticDefault));
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
    if (existing.state === "blocked" || existing.state === "failed") {
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
      if (recovered.kind !== "not_found" || qaSpawnClaimed(existing.result) || existing.state === "running") {
        const claimed = qaSpawnClaimed(existing.result);
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
    if (superseded && existing.threadId) await input.bb.sdk.threads.stop({ threadId:existing.threadId }).catch(() => undefined);
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
  const providerId = frozen?.providerId ?? offSpent?.pair.providerId ?? apart?.pair.providerId ?? liveSelection.providerId;
  const modelId = frozen?.model ?? offSpent?.pair.model ?? apart?.pair.model ?? liveSelection.model;
  // A Gemini critic that a family rule or a limit moved to GPT or Claude runs on the effort that judge had before the Gemini (high), not on the Gemini's medium.
  if (!frozen) configuredEffort = effortAfterMove("code-critic", { model:liveSelection.model, effort:configuredEffort }, { providerId, model:modelId });
  // The independence the rule promises is checked on the pair that will really run, after every fallback: not met is said, never silent (F4/R4).
  if (!frozen && writerPair && modelFamily(modelId) && modelFamily(modelId) === modelFamily(writerPair.model)) input.bb.log.warn(`code critic for ${input.taskId}: ${providerId}/${modelId} is of the writer's own family (${writerPair.providerId}/${writerPair.model}); the other family has no usable model here, so the review is not independent`);
  const policy = frozen ?? freezeCritiquePolicy({
    settings:parsed, providerId, model:modelId, reasoningEffort:configuredEffort,
    serviceTier:typeof savedTier === "string" && savedTier ? String(savedTier) : "standard",
  });
  if (!parsed.enabled) {
    recordStage(input.db, { ...base, state:"skipped", reason:qualityMode === "quick" ? "quality_mode_quick" : "disabled_by_project_setting", result:{ ...ledgerCarry, ...hashFields, policy } });
    return { allowed:true, review:"not_required", settings:parsed, policy };
  }
  if (input.evidence.truncated) {
    const reason = `code_critique_evidence_unknown:${input.evidence.truncateReason ?? "truncated"}`;
    recordStage(input.db, { ...base, state:"skipped", reason, result:{ ...ledgerCarry, ...hashFields, truncated:true, policy } });
    return { allowed:true, reason, review:"not_required", settings:parsed, policy };
  }
  const screened = await screenCodeCritique(settings, { projectId: input.projectId, runId: input.runId, taskId: input.taskId, task: input.task, evidence: input.evidence });
  if (screened) {
    const critique = critiqueFromScreen(screened);
    const blocked = codeCritiqueStops(parsed.mode, critique);
    const result = { ...ledgerCarry, ...hashFields, ...critique, mode: parsed.mode, by: "jev", policy };
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
    const serviceTier = provider.capabilities.supportsServiceTier ? bbServiceTier(tier) : null;
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
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (threadId) {
      const thread = await input.bb.sdk.threads.get({ threadId }).catch(() => null);
      if (stringAt(thread, "status") === "active" || stringAt(thread, "status") === "starting") {
        await input.bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      }
    }
    recordStage(input.db, { ...base, state:"failed", providerId, model:modelId, threadId, reason, result:{ ...ledgerCarry, error:reason, policy } });
    return { allowed:false, reason:`code_critique_failed:${reason}`, review:"not_required", settings:parsed, policy };
  }
}

export async function runSpecialistReview(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;taskId:string;config:PrototypeConfig;task:TaskV2;plan:string;workflow?:{runId:string;stepKey:string;nodeId:string}})
  : Promise<{allowed:boolean;reason?:string;review?:unknown}> {
  const settings = await stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  const policy = shouldRunSpecialist({enabled:settings["specialist.enabled"],when:settings["specialist.when"],risk:input.task.risk});
  const agent=boundedAgentName(settings["specialist.agent"],"specialist-reviewer");
  const source = `${input.plan}\n\n${JSON.stringify(input.task)}\n\nagent=${agent}`;
  const base = {runId:input.runId,taskId:input.taskId,stageId:"specialist-review" as const,input:source};
  const kept = listStageReceipts(input.db,input.runId,input.taskId).find((row) => row.stageId === "specialist-review");
  if (kept?.state === "passed" && kept.inputSha256 === sha256(source)) return {allowed:true,review:kept.result};
  // An updated task goes through its review again over the receipt of the earlier contract (lane_pilot_update_task).
  recordStage(input.db,{...base,state:"pending",replaceOnNewInput:true,restart:true});
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
    const tier = provider.capabilities.supportsServiceTier ? bbServiceTier(serviceTier) : null;
    if (tier && !(provider.serviceTiers ?? []).some((item) => item.id === tier)) throw new Error(`specialist_service_tier_unsupported:${tier}`);
    const helperPolicy=requireHelperSpawn(input);
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
    const review = parseSpecialistResult(raw, inputCitations(JSON.stringify(input.task), input.plan));
    const blocked = review.decision === "block";
    const why = verdictReasons(review, "specialist-review");
    recordStage(input.db,{...base,state:blocked ? "blocked" : "passed",providerId,model:modelId,threadId,
      result:{...review,rawOutput:raw.slice(0,12_000)},reason:blocked ? why.receipt : undefined});
    return blocked ? {allowed:false,reason:why.returned,review} : {allowed:true,review};
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (threadId) {
      const thread = await input.bb.sdk.threads.get({threadId}).catch(() => null);
      if (stringAt(thread,"status") === "active" || stringAt(thread,"status") === "starting") {
        await input.bb.sdk.threads.stop({threadId}).catch(() => undefined);
      }
    }
    recordStage(input.db,{...base,state:"failed",providerId,model:modelId,threadId,reason,result:{error:reason}});
    return {allowed:false,reason:`specialist_review_failed:${reason}`};
  }
}
