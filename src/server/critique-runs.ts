import { isOutputPath } from "../validate-output";
import { fileAllowedByOwns } from "../owns-paths";
import { hostContract, taskV2Schema } from "../contracts";
import type { PrototypeConfig, TaskV2 } from "../contracts";
import { claimStageSpawn, countAttempts, getRun, getRunSettingsScopes, getTask, listLiveTasksForRun, listOpenAttempts, listStageReceipts, loadProjectSettings, openDatabase } from "../database";
import { bbServiceTier, writerExecutionSelection, writerServiceTier } from "../jev-reasoning";
import { qaSpawnClaimed } from "../qa-host";
import { reconcileCritic } from "../reconcile";
import { resolveStageWriterSelection } from "../stage-writer-selection";
import { codeCritiquePrompt, codeCritiqueSource, critiqueFromStageResult, critiquePolicyFromResult, freezeCritiquePolicy, parseCodeCritique, parseCodeCritiqueSettings, persistLedgerFields, settingsFromFrozenPolicy } from "../stages/code-critique";
import type { CandidateEvidence, FrozenCritiquePolicy } from "../stages/code-critique";
import { sha256 } from "../stages/contract";
import { critiquePrompt, parseCritique, shouldRunPlanCritique } from "../stages/critique";
import { binaryOutputs, findTaskPlaceholderPaths } from "../stages/critique-coverage";
import type { CoverageFinding } from "../stages/critique-coverage";
import { buildExecutionPacket, renderPacketExcerpts } from "../stages/execution-packet";
import { parsePmReadResult, parsePmReadSettings, pmReadPrompt } from "../stages/pm-read";
import { boundedAgentName } from "../stages/role";
import { parseSpecialistResult, shouldRunSpecialist, specialistPrompt } from "../stages/specialist";
import { MAIN_ATTEMPT_LIMIT } from "../state-machine";
import { configuredSetting } from "./context";
import { fullAccessSpawn } from "./pm-spawn";
import { CRITIC_OUTCOME_UNKNOWN, criticReconcilePort, helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "./run-routing";
import { recordStage } from "./stage-records";
import { stringAt } from "./values";
import { dependsOnTask } from "./writer/start";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { resolve } from "node:path";
export async function runPmRead(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;taskId:string;pmThreadId:string;config:PrototypeConfig;task:TaskV2})
  :Promise<{state:"skipped"|"passed"|"failed";summary:string;reason?:string}> {
  const settings=loadProjectSettings(input.db,input.projectId,getRunSettingsScopes(input.db,input.runId));
  const parsedSettings=parsePmReadSettings(Object.fromEntries([
    "pm_read.enabled","pm_read.min_lines","pm_read.provider","pm_read.model","pm_read.reasoning_effort","pm_read.service_tier",
  ].map((key)=>[key,configuredSetting(settings,key)])));
  const fallback=resolveStageWriterSelection({settings,config:input.config});
  const providerId=parsedSettings.provider??fallback.providerId;
  const modelId=parsedSettings.model??fallback.model;
  const source=JSON.stringify({taskId:input.taskId,readFirst:input.task.read_first,settings:parsedSettings,providerId,modelId});
  const base={runId:input.runId,taskId:input.taskId,stageId:"pm-read" as const,input:source,attempt:Math.min(countAttempts(input.db,input.runId,input.taskId),MAIN_ATTEMPT_LIMIT)};
  const existing=listStageReceipts(input.db,input.runId,input.taskId).find((row)=>row.stageId==="pm-read");
  if(existing) {
    const summary=stringAt(existing.result,"summary")??"";
    return {state:existing.state==="passed"?"passed":existing.state==="skipped"?"skipped":"failed",summary,...(existing.reason?{reason:existing.reason}:{})};
  }
  recordStage(input.db,{...base,state:"pending",providerId,model:modelId});
  if(!parsedSettings.enabled) {
    recordStage(input.db,{...base,state:"skipped",providerId,model:modelId,reason:"disabled_by_project_setting"});
    return {state:"skipped",summary:""};
  }
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
      pluginMetadata:{role:"pm-reader",lanePilotRunId:input.runId,lanePilotTaskId:input.taskId,stageId:"pm-read",parentPmThreadId:input.pmThreadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true}});
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

export async function runPlanCritique(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;taskId:string;config:PrototypeConfig;task:TaskV2;plan:string;pmReadContext?:string})
  : Promise<{allowed:boolean;reason?:string;critique?:unknown}> {
  const settings = loadProjectSettings(input.db,input.projectId,getRunSettingsScopes(input.db,input.runId));
  const selection=resolveStageWriterSelection({settings,config:input.config,stageProviderKey:"plan_critique.provider",stageModelKey:"plan_critique.model"});
  const providerId=selection.providerId;
  const modelId=selection.model;
  const mode = settings["plan_critique.mode"] === "advisory" ? "advisory" : "gate";
  const agent = boundedAgentName(settings["plan_critique.agent"],"plan-critic");
  const runTasks = listLiveTasksForRun(input.db,input.runId).map((row) => ({id:row.id,...row.contract as {lane?:string;owns_paths?:string[];verify?:TaskV2["verify"];verification?:TaskV2["verification"]}}));
  let coverageStatus:"complete"|"truncated"|"unavailable"="unavailable";
  let coveragePathCount=0;
  let structuralFindings:CoverageFinding[]=runTasks.flatMap((task)=>findTaskPlaceholderPaths(task).map((path)=>({code:"task_placeholder" as const,path:`tasks/${task.id}/${path}`,
    severity:"error" as const,finding:`Task ${task.id} contains unresolved REPLACE_ME at ${path}`}))).slice(0,10);
  // An expected file the task may not write fails every attempt (SelfyStudio 2026-10-03): caught here, before a writer runs.
  const unownedOutputs=input.task.expected_outputs.filter((entry)=>entry.includes("/")&&isOutputPath(entry)&&!fileAllowedByOwns(entry.replace(/^\.\//,""),input.task.owns_paths));
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
  recordStage(input.db, { ...base, state:"pending" });
  const enabled = settings["plan_critique.enabled"];
  const disabled = enabled === false || enabled === 0
    || (typeof enabled === "string" && ["0", "off", "false", "no"].includes(enabled.trim().toLowerCase()));
  if (disabled) {
    recordStage(input.db, { ...base, state:"skipped", reason:"disabled_by_project_setting" });
    return { allowed:true };
  }
  const structuralBlock=mode==="gate"&&structuralFindings.some((finding)=>finding.severity==="error");
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
    const model = catalog.models.find((row) => row.id === modelId || row.model === modelId);
    if (!provider || !model) throw new Error("critique_provider_or_model_unavailable");
    const levels = model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
    const configuredEffort = typeof settings["plan_critique.reasoning_effort"] === "string"
      ? settings["plan_critique.reasoning_effort"] as string
      : typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : "medium";
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
        helperMode:helperPolicy.mode, helperRequired:helperPolicy.policy?.required===true },
    });
    threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("critique_thread_id_missing");
    recordStage(input.db, { ...base, state:"running", providerId, model:modelId, threadId });
    await waitThreadIdle(input.bb,threadId,"critique_thread_timeout");
    const raw = (await input.bb.sdk.threads.output({ threadId })).output;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
    const critique = parseCritique(raw);
    const blocked = critique.decision === "changes_requested" && mode === "gate";
    const result = { ...critique, mode, structuralCoverage:{status:coverageStatus,pathCount:coveragePathCount}, structuralFindings, rawOutput:raw.slice(0, 12_000) };
    recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
      threadId, result, reason:blocked ? "critique_changes_requested" : undefined });
    return blocked ? { allowed:false, reason:"plan_critique_blocked", critique:result } : { allowed:true, critique:result };
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

export async function runCodeCritique(input:{
  bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;taskId:string;
  config:PrototypeConfig;task:TaskV2;evidence:CandidateEvidence;disputes?:unknown;frozenPolicy?:FrozenCritiquePolicy;
}): Promise<{allowed:boolean;reason?:string;review:"passed"|"not_required";critique?:unknown;parsed?:ReturnType<typeof parseCodeCritique>;settings?:ReturnType<typeof parseCodeCritiqueSettings>;policy?:FrozenCritiquePolicy}> {
  const settings = loadProjectSettings(input.db,input.projectId,getRunSettingsScopes(input.db,input.runId));
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
        const critique = parseCodeCritique(raw);
        const blocked = critique.decision === "changes_requested" && parsed.mode === "gate";
        const result = { ...ledgerCarry, ...critique, ...hashFields, mode:parsed.mode, rawOutput:raw.slice(0, 12_000), policy:frozen ?? critiquePolicyFromResult(existing.result) };
        recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId:existing.providerId, model:existing.model,
          threadId:existing.threadId, result, reason:blocked ? "critique_changes_requested" : undefined });
        return blocked
          ? { allowed:false, reason:"code_critique_blocked", critique:result, parsed:critique, settings:parsed, review:"not_required", policy:result.policy }
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
        recordStage(input.db, { ...base, state:"running", providerId:existing.providerId, model:existing.model,
          threadId:recovered.threadId, result:{ ...ledgerCarry, ...hashFields, spawnAttempted:true, policy:frozen ?? critiquePolicyFromResult(existing.result) } });
        try {
          await waitThreadIdle(input.bb,recovered.threadId,"critique_thread_timeout");
          const raw = (await input.bb.sdk.threads.output({ threadId:recovered.threadId })).output;
          if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
          const critique = parseCodeCritique(raw);
          const blocked = critique.decision === "changes_requested" && parsed.mode === "gate";
          const result = { ...ledgerCarry, ...critique, ...hashFields, mode:parsed.mode, rawOutput:raw.slice(0, 12_000), policy:frozen ?? critiquePolicyFromResult(existing.result) };
          recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId:existing.providerId, model:existing.model,
            threadId:recovered.threadId, result, reason:blocked ? "critique_changes_requested" : undefined });
          return blocked
            ? { allowed:false, reason:"code_critique_blocked", critique:result, parsed:critique, settings:parsed, review:"not_required", policy:result.policy }
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
    recordStage(input.db, { ...base, state:"pending", replaceOnNewInput:true, result:{ ...ledgerCarry, ...hashFields, truncated:input.evidence.truncated } });
  }
  const liveSelection = resolveStageWriterSelection({
    settings, config:input.config, stageProviderKey:"code_critique.provider", stageModelKey:"code_critique.model",
  });
  const providerId = frozen?.providerId ?? liveSelection.providerId;
  const modelId = frozen?.model ?? liveSelection.model;
  const configuredEffort = frozen?.reasoningEffort ?? (typeof settings["code_critique.reasoning_effort"] === "string"
    ? settings["code_critique.reasoning_effort"] as string
    : typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : "medium");
  const savedTier = frozen?.serviceTier ?? settings["code_critique.service_tier"];
  const policy = frozen ?? freezeCritiquePolicy({
    settings:parsed, providerId, model:modelId, reasoningEffort:configuredEffort,
    serviceTier:typeof savedTier === "string" && savedTier ? String(savedTier) : "standard",
  });
  if (!parsed.enabled) {
    recordStage(input.db, { ...base, state:"skipped", reason:"disabled_by_project_setting", result:{ ...ledgerCarry, ...hashFields, policy } });
    return { allowed:true, review:"not_required", settings:parsed, policy };
  }
  if (input.evidence.truncated) {
    const reason = `code_critique_evidence_unknown:${input.evidence.truncateReason ?? "truncated"}`;
    recordStage(input.db, { ...base, state:"blocked", reason, result:{ ...ledgerCarry, ...hashFields, truncated:true, policy } });
    return { allowed:false, reason, review:"not_required", settings:parsed, policy };
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
        const critique = parseCodeCritique(raw);
        const blocked = critique.decision === "changes_requested" && parsed.mode === "gate";
        const result = { ...snapshot, ...critique, policy, reviewer:{ providerId, model:modelId, reasoningEffort:configuredEffort, serviceTier: writerServiceTier(settings) === "fast" ? "fast" : "standard", mode:parsed.mode, maxRounds:parsed.maxRounds, autoFix:parsed.autoFix }, rawOutput:raw.slice(0, 12_000) };
        recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
          threadId, result, reason:blocked ? "critique_changes_requested" : undefined });
        return blocked
          ? { allowed:false, reason:"code_critique_blocked", critique:result, parsed:critique, settings:parsed, review:"not_required", policy }
          : { allowed:true, critique:result, parsed:critique, settings:parsed, review:"passed", policy };
      }
      const recovered = await reconcileCritic(criticReconcilePort(input.bb, input.projectId), {
        lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "code-critique", role: "code-critic",
      });
      if (recovered.kind === "found") {
        recordStage(input.db, { ...base, state:"running", providerId, model:modelId, threadId:recovered.threadId, result:{ ...snapshot, spawnAttempted:true, threadId:recovered.threadId, policy } });
        threadId = recovered.threadId;
        await waitThreadIdle(input.bb,threadId,"critique_thread_timeout");
        const raw = (await input.bb.sdk.threads.output({ threadId })).output;
        if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
        const critique = parseCodeCritique(raw);
        const blocked = critique.decision === "changes_requested" && parsed.mode === "gate";
        const result = { ...snapshot, ...critique, policy, rawOutput:raw.slice(0, 12_000) };
        recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
          threadId, result, reason:blocked ? "critique_changes_requested" : undefined });
        return blocked
          ? { allowed:false, reason:"code_critique_blocked", critique:result, parsed:critique, settings:parsed, review:"not_required", policy }
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
    const model = catalog.models.find((row) => row.id === modelId || row.model === modelId);
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
    const spawned = await fullAccessSpawn(input.bb, {
      ...placement,
      ...requiredPolicyField(input.bb, helperPolicy, providerId, "code-critic"),
      ...writerExecutionSelection(providerId, modelId, configuredEffort, serviceTier),
      prompt:codeCritiquePrompt({ evidence:input.evidence, task:input.task, agent:parsed.agent, disputes:input.disputes }),
      environment:{ type:"host", hostId:input.config.hostId,
        workspace:{ type:"unmanaged", path:input.task.project_cwd } },
      pluginMetadata:{ role:"code-critic", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
        stageId:"code-critique", parentPmThreadId:getRun(input.db, input.runId)?.pm_thread_id ?? null,
        revisionSha256:input.evidence.revisionSha256, helperMode:helperPolicy.mode,
        helperRequired:helperPolicy.policy?.required===true, reviewer:reviewerSnapshot },
    });
    threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("critique_thread_id_missing");
    recordStage(input.db, { ...base, state:"running", providerId, model:modelId, threadId, result:{ ...snapshot, threadId, policy } });
    await waitThreadIdle(input.bb,threadId,"critique_thread_timeout");
    const raw = (await input.bb.sdk.threads.output({ threadId })).output;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
    const critique = parseCodeCritique(raw);
    const blocked = critique.decision === "changes_requested" && parsed.mode === "gate";
    const result = { ...snapshot, ...critique, policy, reviewer:{ providerId, model:modelId, reasoningEffort:configuredEffort, serviceTier:tier, mode:parsed.mode, maxRounds:parsed.maxRounds, autoFix:parsed.autoFix }, rawOutput:raw.slice(0, 12_000) };
    recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
      threadId, result, reason:blocked ? "critique_changes_requested" : undefined });
    return blocked
      ? { allowed:false, reason:"code_critique_blocked", critique:result, parsed:critique, settings:parsed, review:"not_required", policy }
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

export async function runSpecialistReview(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;taskId:string;config:PrototypeConfig;task:TaskV2;plan:string})
  : Promise<{allowed:boolean;reason?:string;review?:unknown}> {
  const settings = loadProjectSettings(input.db,input.projectId,getRunSettingsScopes(input.db,input.runId));
  const policy = shouldRunSpecialist({enabled:settings["specialist.enabled"],when:settings["specialist.when"],risk:input.task.risk});
  const agent=boundedAgentName(settings["specialist.agent"],"specialist-reviewer");
  const source = `${input.plan}\n\n${JSON.stringify(input.task)}\n\nagent=${agent}`;
  const base = {runId:input.runId,taskId:input.taskId,stageId:"specialist-review" as const,input:source};
  recordStage(input.db,{...base,state:"pending"});
  if (!policy.run) {
    const failedPolicy = policy.reason?.startsWith("invalid_") || policy.reason?.startsWith("unsupported_");
    recordStage(input.db,{...base,state:failedPolicy ? "blocked" : "skipped",reason:policy.reason ?? undefined});
    return failedPolicy ? {allowed:false,reason:policy.reason ?? "specialist_policy_invalid"} : {allowed:true};
  }

  const selection=resolveStageWriterSelection({settings,config:input.config,stageProviderKey:"specialist.provider",stageModelKey:"specialist.model"});
  const providerId=selection.providerId;
  const modelId=selection.model;
  const effort = typeof settings["specialist.reasoning_effort"] === "string" && settings["specialist.reasoning_effort"]
    ? settings["specialist.reasoning_effort"] as string : "high";
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
    const model = catalog.models.find((row) => row.id === modelId || row.model === modelId);
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
        helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true},
    });
    threadId = stringAt(spawned,"id");
    if (!threadId) throw new Error("specialist_thread_id_missing");
    recordStage(input.db,{...base,state:"running",providerId,model:modelId,threadId});
    await waitThreadIdle(input.bb,threadId,"specialist_thread_timeout");
    const raw = (await input.bb.sdk.threads.output({threadId})).output;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("specialist_output_empty");
    const review = parseSpecialistResult(raw);
    const blocked = review.decision === "block";
    recordStage(input.db,{...base,state:blocked ? "blocked" : "passed",providerId,model:modelId,threadId,
      result:{...review,rawOutput:raw.slice(0,12_000)},reason:blocked ? "specialist_review_blocked" : undefined});
    return blocked ? {allowed:false,reason:"specialist_review_blocked",review} : {allowed:true,review};
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
