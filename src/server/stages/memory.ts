import { taskV2Schema } from "../../contracts";
import { claimStageSpawn, getRun, getRunSettingsScopes, getTask, listStageReceipts, loadProjectSettings, searchMemoryRecords, storeMemoryRecords } from "../../database";
import { bbServiceTier, writerExecutionSelection } from "../../jev-reasoning";
import { resolveStageWriterSelection } from "../../stage-writer-selection";
import { sha256 } from "../../stages/contract";
import { memoryContext, memoryMaintenancePrompt, memoryRecordId, parseMemoryCandidates, parseMemorySettings } from "../../stages/memory";
import { boundedAgentName } from "../../stages/role";
import { MemoryChildSnapshot, childResultObject, memoryChildSnapshot } from "../child-snapshots";
import { configuredSetting } from "../context";
import { fullAccessSpawn } from "../pm-spawn";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../run-routing";
import { recordStage } from "../stage-records";
import { stringAt, valueAt } from "../values";
import { observeStageChild } from "@lane-pilot/thread-observe";
import type { ServerCore } from "../core";
import type { Services } from "../services";

export function createMemoryStage(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, workspaceExecutionEnvironment } = ctx;

  /**
   * Memory is kept after every accepted task without waiting for the PM to remember the call: the
   * stage is idempotent, so a PM that also calls lane_pilot_memory_maintain just reads the receipt.
   */
  function maintainMemoryAfterAcceptance(projectId:string, runId:string, taskId:string, pmThreadId:string):void {
    void (async () => {
      for (let round = 0; round < 60 && !ctx.state.disposed; round++) {
        const result = await runMemoryMaintenance({ threadId:pmThreadId, projectId, runId, taskId, timeoutSec:60 });
        if (result.state !== "running") return;
      }
    })().catch((cause: unknown) => {
      if (!ctx.state.disposed) bb.log.warn(`Lane Pilot memory after ${taskId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  async function runMemoryMaintenance(args:{threadId:string;projectId:string;runId:string;taskId:string;timeoutSec?:number}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") throw new Error("task does not belong to this PM run and project");
    const taskContract=taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    const accepted=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="acceptance-receipt");
    if(accepted?.state!=="passed"||!accepted.outputSha256) throw new Error("memory maintenance requires an accepted writer receipt first");
    const settings=loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
    const memoryAgent=boundedAgentName(settings["memory.agent"],"memory-maintainer");
    const memorySettings=parseMemorySettings(Object.fromEntries([
      "memory.enabled","memory.maintain","memory.inject","memory.audience","memory.personal_bot","memory.search_engine",
      "memory.core_budget","memory.note_budget","memory.index_budget","memory.context_budget",
    ].map((key)=>[key,configuredSetting(settings,key)])));
    const memorySelection=resolveStageWriterSelection({settings,config,stageProviderKey:"memory.provider",stageModelKey:"memory.model"});
    const memoryProviderId=memorySelection.providerId;
    const memoryModel=memorySelection.model;
    const memoryEffort=typeof settings["memory.reasoning_effort"]==="string"?settings["memory.reasoning_effort"] as string:"medium";
    const memoryTier=settings["memory.service_tier"]==="fast"?"fast":"standard";
    const base={runId:args.runId,taskId:args.taskId,stageId:"memory-maintenance" as const,
      input:JSON.stringify({taskId:args.taskId,acceptanceSha256:accepted.outputSha256,settings:memorySettings,
        providerId:memoryProviderId,model:memoryModel,reasoningEffort:memoryEffort,serviceTier:memoryTier,agent:memoryAgent})};
    const existing=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
    if(existing && !["pending","running"].includes(existing.state)) {
      return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"memory maintenance already has a receipt; create a new task for another run",stage:existing};
    }
    if(!existing) recordStage(db,{...base,state:"pending"});
    const liveChild=Boolean(existing?.threadId || memoryChildSnapshot(existing?.result));
    if((!memorySettings.enabled||!memorySettings.maintain) && !liveChild) {
      const reason=!memorySettings.enabled?"disabled_by_project_setting":"memory_maintain_disabled";
      recordStage(db,{...base,state:"skipped",reason,result:{stored:0,audience:memorySettings.audience}});
      return {runId:args.runId,taskId:args.taskId,state:"skipped",reason};
    }
    const claimed=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
    if(claimed?.state==="pending") recordStage(db,{...base,state:"running",providerId:memoryProviderId,model:memoryModel,threadId:claimed.threadId,result:claimed.result,reason:"memory_spawn_requested"});
    let receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
    let threadId:string|null=receipt?.threadId??null;
    const observeMs=Math.min(240, Math.max(1, args.timeoutSec ?? 60)) * 1000;
    const persistRunning=(nextThreadId:string|null, result:unknown, reason?:string)=>{
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
      if(current && !["pending","running"].includes(current.state)) return current;
      recordStage(db,{...base,state:"running",providerId:memoryProviderId,model:memoryModel,
        threadId:nextThreadId ?? current?.threadId ?? null,
        result:{...childResultObject(current?.result),...childResultObject(result)},reason});
      return undefined;
    };
    const finishObservation=async(childId:string, snapshot:MemoryChildSnapshot|null):Promise<Record<string,unknown>>=>{
      const already=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
      if(already && !["pending","running"].includes(already.state)) {
        return {runId:args.runId,taskId:args.taskId,state:already.state,reason:"memory maintenance already has a receipt; create a new task for another run",stage:already};
      }
      const observed=await observeStageChild(bb,childId,observeMs);
      const latest=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
      if(latest && !["pending","running"].includes(latest.state)) {
        return {runId:args.runId,taskId:args.taskId,state:latest.state,reason:"memory maintenance already has a receipt; create a new task for another run",stage:latest};
      }
      const prior=childResultObject(latest?.result ?? receipt?.result);
      if(observed.kind==="observing") {
        persistRunning(childId,{...prior,...(snapshot?{snapshot}:{}),observing:observed.detail});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:observed.detail};
      }
      if(observed.kind==="product_failure") {
        recordStage(db,{...base,state:"failed",providerId:memoryProviderId,model:memoryModel,threadId:childId,reason:`${observed.via}:${observed.detail}`,result:{error:`${observed.via}:${observed.detail}`}});
        return {runId:args.runId,taskId:args.taskId,state:"failed",threadId:childId,reason:`${observed.via}:${observed.detail}`};
      }
      if(!snapshot) {
        persistRunning(childId,{...prior,observing:"memory_snapshot_missing"});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:"memory_snapshot_missing"};
      }
      const output=(await bb.sdk.threads.output({threadId:childId})).output;
      if(typeof output!=="string"||!output.trim()) throw new Error("memory_maintainer_output_empty");
      const entries=parseMemoryCandidates(output,snapshot.settings);
      const records=storeMemoryRecords(db,{projectId:args.projectId,personalBot:snapshot.settings.personalBot,audience:snapshot.settings.audience,sourceSha256:snapshot.acceptanceSha256,
        entries,coreBudget:snapshot.settings.coreBudget,noteBudget:snapshot.settings.noteBudget,indexBudget:snapshot.settings.indexBudget});
      const byId=new Map(records.records.map((row)=>[row.id,row]));
      const recordIds:string[]=[];
      for(const entry of entries){
        const id=memoryRecordId(args.projectId,entry.kind,entry.content,snapshot.settings.personalBot);
        const row=byId.get(id);
        if(!row) throw new Error("memory_record_ids_missing_after_store");
        if(row.sourceSha256===snapshot.acceptanceSha256) recordIds.push(id);
      }
      const result={stored:recordIds.length,recordIds,sourceSha256:snapshot.acceptanceSha256,audience:snapshot.settings.audience,personalBot:snapshot.settings.personalBot,
        reasoningEffort:memoryEffort,serviceTier:memoryTier,
        budgets:{core:snapshot.settings.coreBudget,note:snapshot.settings.noteBudget,index:snapshot.settings.indexBudget},
        retrievedForWriter:snapshot.settings.inject&&snapshot.settings.audience==="subagent",threadId:childId,snapshot};
      recordStage(db,{...base,state:"passed",providerId:memoryProviderId,model:memoryModel,threadId:childId,result:{...result,recordsAvailable:records.records.length}});
      return {runId:args.runId,taskId:args.taskId,state:"passed",result};
    };
    try {
      receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
      threadId=receipt?.threadId??null;
      let snapshot=memoryChildSnapshot(receipt?.result);
      if(!threadId){
        const recovered=await services.reconcileStageChild(args.projectId,args.runId,args.taskId,"memory-maintenance","memory-maintainer");
        if(recovered.kind==="found"){
          threadId=recovered.threadId;
          persistRunning(threadId,{...childResultObject(receipt?.result),...(snapshot?{snapshot}:{})});
          receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
        } else if(recovered.kind!=="not_found") {
          persistRunning(null,{...childResultObject(receipt?.result),...(snapshot?{snapshot}:{}),observing:recovered.kind});
          return {runId:args.runId,taskId:args.taskId,state:"running",reason:"observing",detail:recovered.kind};
        }
      }
      if(threadId) return await finishObservation(threadId,snapshot);
      if(!snapshot){
        snapshot={acceptanceSha256:accepted.outputSha256,settings:memorySettings,agent:memoryAgent,dispatchInput:JSON.parse(base.input)};
        persistRunning(null,{snapshot},"memory_spawn_requested");
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
      }
      if(!claimStageSpawn(db,args.runId,args.taskId,"memory-maintenance")){
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
        if(receipt?.threadId) return await finishObservation(receipt.threadId,snapshot);
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:receipt?.threadId??null,reason:"observing",detail:"memory_spawn_claimed"};
      }
      const [providers,catalog]=await Promise.all([
        bb.sdk.providers.list({hostId:config.hostId}),
        bb.sdk.providers.models({providerId:memoryProviderId,hostId:config.hostId}),
      ]);
      const provider=providers.find((item)=>item.id===memoryProviderId&&item.available);
      const model=catalog.models.find((item)=>item.id===memoryModel||item.model===memoryModel);
      if(!provider||!model) throw new Error("memory_writer_provider_or_model_unavailable");
      if(!model.supportedReasoningEfforts.some((item)=>item.reasoningEffort===memoryEffort)) throw new Error(`memory_writer_reasoning_effort_unsupported:${memoryEffort}`);
      const tier=provider.capabilities.supportsServiceTier?bbServiceTier(memoryTier):null;
      if(tier&&!(provider.serviceTiers??[]).some((item)=>item.id===tier)) throw new Error(`memory_writer_service_tier_unsupported:${tier}`);
      const helperPolicy=requireHelperSpawn({bb,db,projectId:args.projectId,runId:args.runId});
      const placement=await helperChildPlacement({
        bb, db, projectId:args.projectId, runId:args.runId, role:"memory-maintainer",
      });
      const spawned=await fullAccessSpawn(bb, {...placement,...requiredPolicyField(bb, helperPolicy, memoryProviderId, "memory-maintainer"),
        ...writerExecutionSelection(memoryProviderId,memoryModel,memoryEffort,tier),
        prompt:memoryMaintenancePrompt({task,acceptedResult:accepted.result,settings:snapshot.settings,agent:snapshot.agent}),
        environment:workspaceExecutionEnvironment(config.hostId,workspace),
        pluginMetadata:{role:"memory-maintainer",lanePilotRunId:args.runId,lanePilotTaskId:args.taskId,
          stageId:"memory-maintenance",parentPmThreadId:args.threadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true}});
      threadId=stringAt(spawned,"id"); if(!threadId) throw new Error("memory_maintainer_thread_id_missing");
      persistRunning(threadId,{...childResultObject(receipt?.result),snapshot,spawnAttempted:true});
      return await finishObservation(threadId,snapshot);
    } catch(cause) {
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
      if(current && !["pending","running"].includes(current.state)) {
        return {runId:args.runId,taskId:args.taskId,state:current.state,reason:"memory maintenance already has a receipt; create a new task for another run",stage:current};
      }
      const reason=cause instanceof Error?cause.message:String(cause);
      if(!threadId){
        const recovered=await services.reconcileStageChild(args.projectId,args.runId,args.taskId,"memory-maintenance","memory-maintainer").catch(()=>({kind:"error" as const,message:reason}));
        if(recovered.kind==="found"){
          persistRunning(recovered.threadId,{...childResultObject(receipt?.result),observing:reason});
          return {runId:args.runId,taskId:args.taskId,state:"running",threadId:recovered.threadId,reason:"observing",detail:reason};
        }
        persistRunning(null,{...childResultObject(receipt?.result),observing:reason},"memory_spawn_unknown");
        return {runId:args.runId,taskId:args.taskId,state:"running",reason:"observing",detail:reason};
      }
      if(reason.includes("events_list_error")||reason.includes("host")||reason.includes("disconnect")||reason.includes("ECONN")||reason.includes("502")){
        persistRunning(threadId,{...childResultObject(receipt?.result),observing:reason});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId,reason:"observing",detail:reason};
      }
      recordStage(db,{...base,state:"failed",providerId:memoryProviderId,model:memoryModel,threadId,reason,result:{error:reason}});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
    }
  }

  async function runMemoryContext(args:{threadId:string;projectId:string;runId:string;query:string}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||run.closed_at) throw new Error("run does not belong to this active PM thread and project");
    const settings=loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
    const memorySettings=parseMemorySettings(Object.fromEntries([
      "memory.enabled","memory.maintain","memory.inject","memory.audience","memory.personal_bot","memory.search_engine",
      "memory.core_budget","memory.note_budget","memory.index_budget","memory.context_budget",
    ].map((key)=>[key,configuredSetting(settings,key)])));
    if(!memorySettings.enabled) return {runId:args.runId,state:"skipped",reason:"memory_disabled"};
    const records=searchMemoryRecords(db,args.projectId,args.query,100,memorySettings.searchEngine,memorySettings.audience,memorySettings.personalBot);
    const selected=memoryContext(records,args.query,memorySettings.contextBudget);
    return {runId:args.runId,state:"passed",audience:memorySettings.audience,personalBot:memorySettings.personalBot,querySha256:sha256(args.query),
      recordIds:selected.records.map((item)=>item.id),estimatedTokens:selected.estimatedTokens,context:selected.text};
  }

  return { maintainMemoryAfterAcceptance, runMemoryMaintenance, runMemoryContext };
}
