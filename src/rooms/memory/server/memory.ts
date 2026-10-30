import { resolve } from "node:path";
import { taskV2Schema } from "../../contracts";
import { jev } from "@lane-pilot/jev";
import { memoryRerankJudgment } from "@lane-pilot/jev/judgments/memory-rerank";
import { enrichMemoryContext, episodeCandidates } from "../../memory-tiers/server";
import { appendAcceptedFact, claimStageSpawn, getRun, getRunSettingsScopes, getTask, listAcceptedFacts, listOpenAttempts, listPendingAcceptedFacts, listStageReceipts, markAcceptedFactsSummarized, searchMemoryRecords } from "../../storage";
import { shouldTriggerProjectLife } from "../../project-life";
import { coreShelf, dropMemoryIndexes, memoryEntrySupported, pathsNamed, retireStaleCuratorClaims, storeMemoryRecordsKeepingOverflow } from "@lane-pilot/memory-core";
import { applyScopeMigration } from "../../../../scripts/memory-scope-dry-run";
import { bbServiceTier, writerExecutionSelection } from "@lane-pilot/models";
import { sha256 } from "../../tasks";
import { memoryMaintenancePrompt, memoryRecordId, parseMemoryCandidates, parseMemorySettings } from "../memory";
import { pmMemoryContext, snapshotFileRead } from "./memory-mix";
import { boundedAgentName } from "../../critique";
import { MemoryChildSnapshot, childResultObject, memoryChildSnapshot, spawnRefused } from "../../runs/server";
import { compactAcceptedResult } from "../../tasks/server";
import { configuredSetting, modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, stageHelperSettings } from "../../core/server";
import { fullAccessSpawn, graphStepMetadata } from "../../core/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { recordStage } from "../../runs/server";
import { stringAt, valueAt } from "../../core/server";
import { observeStageChild } from "@lane-pilot/thread-observe";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";

export function createMemoryStage(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, workspaceExecutionEnvironment } = ctx;

  async function runMemoryMaintenance(args:{threadId:string;projectId:string;runId:string;taskId:string;timeoutSec?:number;workflow?:{runId:string;stepKey?:string;nodeId?:string}}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") throw new Error("task does not belong to this PM run and project");
    const taskContract=taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    const accepted=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="acceptance-receipt");
    if(accepted?.state!=="passed"||!accepted.outputSha256) throw new Error("memory maintenance requires an accepted writer receipt first");
    // J-002: the append-only fact of this accepted task — free, durable, written before any model is chosen. It is the
    // batch input the wave-idle maintainer summarizes, and readers can list it even when no helper ever ran.
    appendAcceptedFact(db,{projectId:args.projectId,runId:args.runId,taskId:args.taskId,
      fact:{taskId:args.taskId,title:task.title,objective:task.objective,acceptedResult:compactAcceptedResult(accepted.result)}});
    retireStaleCuratorClaims(db, args.projectId, (projectId, id) => dropMemoryIndexes(db, projectId, id));
    const settings=await stageHelperSettings(bb,db,args.projectId,args.runId);
    const memoryAgent=boundedAgentName(settings["memory.agent"],"memory-maintainer");
    const memorySettings=parseMemorySettings(Object.fromEntries([
      "memory.enabled","memory.maintain","memory.inject","memory.audience","memory.personal_bot","memory.search_engine",
      "memory.core_budget","memory.note_budget","memory.index_budget","memory.context_budget",
    ].map((key)=>[key,configuredSetting(settings,key)])));
    // The memory row of the role table (the project's own memory.* settings still win), through the one resolver: never the project writer.
    const spawnUsage=spawnUsageOf(ctx);
    await warmSpawnUsage(spawnUsage,config.hostId);
    const memoryRole=resolveSpawnModel({role:"memory",settings,catalog:modelCatalogOf(ctx).peek(), usage: spawnUsage,hostId:config.hostId});
    const memoryProviderId=memoryRole.providerId;
    const memoryModel=memoryRole.model;
    const memoryEffort=memoryRole.reasoningEffort;
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
    // J-002 wave mode (memory.maintain_mode; "task" restores one helper per task): the fact is already stored, so while
    // the wave is still busy the stage is done. Once the wave goes idle the last task's stage runs one maintainer for
    // every pending fact of the run — several events, one summary.
    const maintainMode=configuredSetting(settings,"memory.maintain_mode")==="task"?"task":"wave";
    let waveFacts:Array<{taskId:string;title:string;acceptedResult:unknown}>=[];
    let waveFactTaskIds:string[]=[];
    if(maintainMode==="wave" && !liveChild) {
      const skip=(reason:string)=>{
        recordStage(db,{...base,state:"skipped",reason,result:{stored:0,audience:memorySettings.audience}});
        return {runId:args.runId,taskId:args.taskId,state:"skipped",reason};
      };
      const fact=listAcceptedFacts(db,args.runId).find((row)=>row.taskId===args.taskId);
      if(fact && fact.summarizedAt!==null) return skip("fact_already_summarized");
      if(!shouldTriggerProjectLife(listOpenAttempts(db).map((attempt)=>attempt.run_id),args.runId)) return skip("wave_not_idle");
      const pending=listPendingAcceptedFacts(db,args.runId);
      if(!pending.length) return skip("no_pending_facts");
      const inFlight=listStageReceipts(db,args.runId).find((row)=>row.stageId==="memory-maintenance"&&["pending","running"].includes(row.state)&&row.taskId!==args.taskId);
      if(inFlight) return skip("memory_in_flight_elsewhere");
      waveFacts=pending.map((row)=>{
        const body=row.fact as {title?:unknown;objective?:unknown;acceptedResult?:unknown};
        return {taskId:row.taskId,title:typeof body.title==="string"?body.title:row.taskId,acceptedResult:body.acceptedResult};
      });
      waveFactTaskIds=pending.map((row)=>row.taskId);
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
      const all=parseMemoryCandidates(output,snapshot.settings);
      const acceptedText=JSON.stringify(compactAcceptedResult(accepted.result));
      // One cheap verifier pass per batch (arXiv #7): a note claiming a path, version or number the accepted
      // result never mentions is dropped before it reaches the write door.
      const parsed=all.filter((entry)=>memoryEntrySupported(entry.content,acceptedText));
      const unsupportedDropped=all.length-parsed.length;
      // What a task taught belongs to its section of a shared project (Мои проекты: several games and FeedGen in one project).
      const scope=getRunSettingsScopes(db,args.runId);
      const readFile=await snapshotFileRead(parsed.flatMap((entry)=>pathsNamed(entry.content)),async(relativePath)=>{
        const file=await bb.sdk.files.read({hostId:config.hostId,rootPath:workspace.path,path:resolve(workspace.path,relativePath)}).catch(()=>null);
        const content=file&&typeof file==="object"?(file as {content?:unknown}).content:null;
        return typeof content==="string"?new TextEncoder().encode(content):null;
      });
      // A full core keeps the batch: a core entry it cannot take is stored as a note, not a refusal of every entry.
      // A rule the model emits is not stored here: the rules pipeline owns that concept, and the raw door rejects it.
      const entries=parsed.filter((entry)=>!entry.concepts.includes("rule"));
      const records=storeMemoryRecordsKeepingOverflow(db,{projectId:args.projectId,personalBot:snapshot.settings.personalBot,audience:snapshot.settings.audience,sourceSha256:snapshot.acceptanceSha256,
        entries,coreBudget:snapshot.settings.coreBudget,noteBudget:snapshot.settings.noteBudget,indexBudget:snapshot.settings.indexBudget,scope,readFile,originTaskId:args.taskId});
      // Notes that now disagree with an active one are held, both, until a person settles it (memory-conflicts.ts); a failure here never loses the write.
      try { services.memoryConflicts.sweepMoot(args.projectId); services.memoryConflicts.detect(args.projectId,new Set(records.insertedIds)); } catch(cause) { bb.log.warn(`Lane Pilot memory conflicts after ${args.taskId} failed: ${cause instanceof Error?cause.message:String(cause)}`); }
      const byId=new Map(records.records.map((row)=>[row.id,row]));
      const recordIds:string[]=[];
      for(const entry of records.entries){
        const id=memoryRecordId(args.projectId,entry.kind,entry.content,snapshot.settings.personalBot,snapshot.settings.audience,scope);
        const row=byId.get(id);
        if(!row) throw new Error("memory_record_ids_missing_after_store");
        if(row.sourceSha256===snapshot.acceptanceSha256) recordIds.push(id);
      }
      // The batch these facts fed is now durable memory: stamp them so the next accepted task's stage does not re-summarize them.
      if(snapshot.factTaskIds?.length) markAcceptedFactsSummarized(db,args.runId,snapshot.factTaskIds);
      const result={stored:recordIds.length,recordIds,unsupportedDropped,...(records.demoted?{coreDemotedToNotes:records.demoted}:{}),evictedIds:records.evictedIds,supersededIds:records.supersededIds,sourceSha256:snapshot.acceptanceSha256,audience:snapshot.settings.audience,personalBot:snapshot.settings.personalBot,factsSummarized:snapshot.factTaskIds?.length??0,
        reasoningEffort:memoryEffort,serviceTier:memoryTier,
        budgets:{core:snapshot.settings.coreBudget,note:snapshot.settings.noteBudget,index:snapshot.settings.indexBudget},
        retrievedForWriter:snapshot.settings.inject&&snapshot.settings.audience==="subagent",threadId:childId,snapshot};
      recordStage(db,{...base,state:"passed",providerId:memoryProviderId,model:memoryModel,threadId:childId,result:{...result,recordsAvailable:records.records.length}});
      return {runId:args.runId,taskId:args.taskId,state:"passed",result};
    };
    // Set when this call won the spawn claim and when it asked BB for the child: until then no child can exist.
    let claimedHere=false, spawnCalled=false;
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
        snapshot={acceptanceSha256:accepted.outputSha256,settings:memorySettings,agent:memoryAgent,dispatchInput:JSON.parse(base.input),
          ...(waveFacts.length?{facts:waveFacts,factTaskIds:waveFactTaskIds}:{})};
        persistRunning(null,{snapshot},"memory_spawn_requested");
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
      }
      if(!claimStageSpawn(db,args.runId,args.taskId,"memory-maintenance")){
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="memory-maintenance");
        if(receipt?.threadId) return await finishObservation(receipt.threadId,snapshot);
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:receipt?.threadId??null,reason:"observing",detail:"memory_spawn_claimed"};
      }
      claimedHere=true;
      // A scope map stored for the project moves file-named root core onto its section. No map: nothing moves. Not a hand edit of the hub.
      try {
        const stored=await bb.storage.kv.get(`memory.scope_map:${args.projectId}`);
        if(stored&&typeof stored==="object"&&!Array.isArray(stored)) applyScopeMigration(db,stored as Record<string,readonly string[]>);
      } catch { /* the next accepted task tries again */ }
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
      spawnCalled=true;
      const existing=searchMemoryRecords(db,args.projectId,`${task.title}\n${task.objective}`,8,snapshot.settings.searchEngine,snapshot.settings.audience,snapshot.settings.personalBot,{chain:getRunSettingsScopes(db,args.runId)})
        .filter((record)=>record.kind==="note"&&!record.concepts.includes("rule")).map((record)=>({id:record.id,content:record.content}));
      // A few files the notes name, read through the same file reader the writer uses. The model still gets no tools.
      const named=pathsNamed(existing.map((item)=>item.content).join("\n")).slice(0,4);
      const excerptRead=await snapshotFileRead(named,async(relativePath)=>{
        const file=await bb.sdk.files.read({hostId:config.hostId,rootPath:workspace.path,path:resolve(workspace.path,relativePath)}).catch(()=>null);
        const content=file&&typeof file==="object"?(file as {content?:unknown}).content:null;
        return typeof content==="string"?new TextEncoder().encode(content):null;
      });
      const excerpts=named.flatMap((path)=>{const bytes=excerptRead(path);return bytes?[`FILE ${path}:\n${new TextDecoder().decode(bytes).slice(0,2000)}`]:[];}).join("\n\n");
      const spawned=await fullAccessSpawn(bb, {...placement,...requiredPolicyField(bb, helperPolicy, memoryProviderId, "memory-maintainer"),
        ...writerExecutionSelection(memoryProviderId,memoryModel,memoryEffort,tier),
        prompt:memoryMaintenancePrompt({task,acceptedResult:compactAcceptedResult(accepted.result),settings:snapshot.settings,agent:snapshot.agent,
          existing,excerpts,facts:snapshot.facts,
          core:(({tokens,replaceable})=>({tokens,records:replaceable}))(coreShelf(db,args.projectId,snapshot.settings.personalBot,snapshot.settings.audience,getRunSettingsScopes(db,args.runId)))}),
        environment:workspaceExecutionEnvironment(config.hostId,workspace),
        pluginMetadata:{role:"memory-maintainer",lanePilotRunId:args.runId,lanePilotTaskId:args.taskId,
          stageId:"memory-maintenance",parentPmThreadId:args.threadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true,...graphStepMetadata(args.workflow)}});
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
        // A failure before the spawn request, or a spawn BB refused, leaves no child to wait for: kept running, the stage
        // stayed open for good once its claim was taken (SelfyStudio, 2026-10-05: «HTTP 409: Environment unavailable»).
        // A host hiccup before the claim is retried by the next round; after this call's own claim nothing would retry it.
        const transient=["events_list_error","host","disconnect","ECONN","502"].some((word)=>reason.includes(word));
        const neverSpawned=spawnCalled?spawnRefused(reason):claimedHere||(!transient&&childResultObject(current?.result).spawnAttempted!==true);
        if(neverSpawned&&!ctx.state.disposed){
          recordStage(db,{...base,state:"failed",providerId:memoryProviderId,model:memoryModel,reason,result:{error:reason}});
          return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
        }
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
    const settings=await stageHelperSettings(bb,db,args.projectId,args.runId);
    const memorySettings=parseMemorySettings(Object.fromEntries([
      "memory.enabled","memory.maintain","memory.inject","memory.audience","memory.personal_bot","memory.search_engine",
      "memory.core_budget","memory.note_budget","memory.index_budget","memory.context_budget",
    ].map((key)=>[key,configuredSetting(settings,key)])));
    if(!memorySettings.enabled) return {runId:args.runId,state:"skipped",reason:"memory_disabled"};
    const chain=getRunSettingsScopes(db,args.runId);
    const selected=pmMemoryContext(db,args.projectId,memorySettings,args.query,chain);
    // The cold tier, past tasks like this one and the misses (src/rooms/memory-tiers): never fails the query. Candidates stay expired.
    let tiers:{text:string;promoted:string[];episodes:number;miss:boolean;addedTokens:number}={text:"",promoted:[],episodes:0,miss:false,addedTokens:0};
    // B6: Jev re-ranks the lexical episode shortlist (shadow first; active delivers only the ones it keeps).
    let episodesList: import("../../memory-tiers").Episode[] | undefined;
    const judge=jev();
    if(judge){
      const candidates=episodeCandidates(db,args.projectId,args.query,8,{chain});
      if(candidates.length){
        const verdict=await judge.judge(memoryRerankJudgment,{query:args.query,passages:candidates.map((e)=>`${e.title}: ${e.state}${e.reason?` — ${e.reason}`:""}`)},{projectId:args.projectId,runId:args.runId,settings:settings as Record<string,unknown>}).catch(()=>null);
        if(verdict?.by==="jev") episodesList=verdict.decision.keep.slice(0,3).map((i)=>candidates[i]!);
      }
    }
    try { tiers=enrichMemoryContext(db,{projectId:args.projectId,query:args.query,activeCount:selected.records.length,chain,audience:memorySettings.audience,personalBot:memorySettings.personalBot,role:"pm",budget:memorySettings.contextBudget,activeTokens:selected.estimatedTokens,episodesList}); } catch (cause) { ctx.log(`memory tiers skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
    return {runId:args.runId,state:"passed",audience:memorySettings.audience,personalBot:memorySettings.personalBot,querySha256:sha256(args.query),
      recordIds:[...selected.records.map((item)=>item.id),...tiers.promoted],estimatedTokens:selected.estimatedTokens+tiers.addedTokens,context:[selected.text,tiers.text].filter(Boolean).join("\n\n"),
      ...(tiers.promoted.length?{promotedFromCold:tiers.promoted.length}:{}),...(tiers.episodes?{episodes:tiers.episodes}:{})};
  }

  return { runMemoryMaintenance, runMemoryContext };
}
