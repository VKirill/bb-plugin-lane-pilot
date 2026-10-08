import { taskV2Schema } from "../../../contracts";
import { claimStageSpawn, getRun, getRunSettingsScopes, getTask, listStageReceipts, loadProjectSettings } from "../../storage/database";
import { bbServiceTier, writerExecutionSelection } from "@lane-pilot/models";
import { resolveStageWriterSelection } from "../../../stage-writer-selection";
import { sha256 } from "../../tasks/contract";
import { acceptedOnboardingEvidence, onboardingPreviewSchema, onboardingPreviewSha256, onboardingPrompt, parseOnboardingPreview } from "../onboarding";
import type { OnboardingInputPage } from "../onboarding";
import { boundedAgentName } from "../../critique/role";
import { OnboardingChildSnapshot, childResultObject, onboardingChildSnapshot } from "../../../server/child-snapshots";
import { fullAccessSpawn } from "../../../server/pm-spawn";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../../server/run-routing";
import { recordStage } from "../../../server/stage-records";
import { stringAt, valueAt } from "../../../server/values";
import { observeStageChild } from "@lane-pilot/thread-observe";
import type { ServerCore } from "../../../server/core";
import type { Services } from "../../../server/services";

export function createOnboardingStage(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, host, workspaceExecutionEnvironment } = ctx;

  async function runOnboardingPreview(args:{threadId:string;projectId:string;runId:string;taskId:string;timeoutSec?:number}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") throw new Error("task does not belong to this PM run and project");
    const taskContract=taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    const accepted=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="acceptance-receipt");
    if(accepted?.state!=="passed") throw new Error("onboarding preview requires an accepted writer receipt first");
    const settings=loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
    const agent=boundedAgentName(settings["onboarding.agent"],"project-onboarder");
    const depth=settings["onboarding.depth"]==="deep"?"deep":"fast";
    const selection=resolveStageWriterSelection({settings,config,stageProviderKey:"onboarding.provider",stageModelKey:"onboarding.model"});
    const providerId=selection.providerId;
    const modelId=selection.model;
    const base={runId:args.runId,taskId:args.taskId,stageId:"onboarding-preview" as const,
      input:JSON.stringify({taskId:args.taskId,acceptanceSha256:accepted.outputSha256,agent,depth,providerId,modelId})};
    const existing=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
    if(existing && !["pending","running"].includes(existing.state)) {
      return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"onboarding preview already has a receipt; create a new task for another preview",stage:existing};
    }
    if(!existing) recordStage(db,{...base,state:"pending",providerId,model:modelId});
    const claimed=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
    if(claimed?.state==="pending") recordStage(db,{...base,state:"running",providerId,model:modelId,threadId:claimed.threadId,result:claimed.result,reason:"onboarding_spawn_requested"});
    let receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
    let threadId:string|null=receipt?.threadId??null;
    const observeMs=Math.min(240, Math.max(1, args.timeoutSec ?? 60)) * 1000;
    const persistRunning=(nextThreadId:string|null, result:unknown, reason?:string)=>{
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
      if(current && !["pending","running"].includes(current.state)) return current;
      recordStage(db,{...base,state:"running",providerId,model:modelId,
        threadId:nextThreadId ?? current?.threadId ?? null,
        result:{...childResultObject(current?.result),...childResultObject(result)},reason});
      return undefined;
    };
    const finishObservation=async(childId:string, snapshot:OnboardingChildSnapshot|null):Promise<Record<string,unknown>>=>{
      const already=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
      if(already && !["pending","running"].includes(already.state)) {
        return {runId:args.runId,taskId:args.taskId,state:already.state,reason:"onboarding preview already has a receipt; create a new task for another preview",stage:already};
      }
      const observed=await observeStageChild(bb,childId,observeMs);
      const latest=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
      if(latest && !["pending","running"].includes(latest.state)) {
        return {runId:args.runId,taskId:args.taskId,state:latest.state,reason:"onboarding preview already has a receipt; create a new task for another preview",stage:latest};
      }
      const prior=childResultObject(latest?.result ?? receipt?.result);
      if(observed.kind==="observing") {
        persistRunning(childId,{...prior,...(snapshot?{snapshot}:{}),observing:observed.detail});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:observed.detail};
      }
      if(observed.kind==="product_failure") {
        recordStage(db,{...base,state:"failed",providerId,model:modelId,threadId:childId,reason:`${observed.via}:${observed.detail}`,result:{error:`${observed.via}:${observed.detail}`}});
        return {runId:args.runId,taskId:args.taskId,state:"failed",threadId:childId,reason:`${observed.via}:${observed.detail}`};
      }
      if(!snapshot) {
        persistRunning(childId,{...prior,observing:"onboarding_snapshot_missing"});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:"onboarding_snapshot_missing"};
      }
      const raw=(await bb.sdk.threads.output({threadId:childId})).output; if(typeof raw!=="string"||!raw.trim()) throw new Error("onboarding_preview_output_empty");
      const preview=parseOnboardingPreview(raw,snapshot.pages),previewSha256=onboardingPreviewSha256(preview);
      const result={preview,previewSha256,inputPages:snapshot.pages.map(({path,sha256})=>({path,sha256})),
        inputBytes:snapshot.inputBytes,inputPageCount:snapshot.inputPageCount,availablePageCount:snapshot.availablePageCount,
        threadId:childId,agent:snapshot.agent,depth:snapshot.depth,snapshot};
      recordStage(db,{...base,state:"passed",providerId,model:modelId,threadId:childId,result});
      return {runId:args.runId,taskId:args.taskId,state:"passed",result};
    };
    try{
      receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
      threadId=receipt?.threadId??null;
      let snapshot=onboardingChildSnapshot(receipt?.result);
      if(!threadId){
        const recovered=await services.reconcileStageChild(args.projectId,args.runId,args.taskId,"onboarding-preview","onboarder");
        if(recovered.kind==="found"){
          threadId=recovered.threadId;
          persistRunning(threadId,{...childResultObject(receipt?.result),...(snapshot?{snapshot}:{})});
          receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
        } else if(recovered.kind!=="not_found") {
          persistRunning(null,{...childResultObject(receipt?.result),...(snapshot?{snapshot}:{}),observing:recovered.kind});
          return {runId:args.runId,taskId:args.taskId,state:"running",reason:"observing",detail:recovered.kind};
        }
      }
      if(threadId) return await finishObservation(threadId,snapshot);
      if(!snapshot){
        const inventory=await host.call("listDocsPages",{requestedHostId:config.hostId,projectCwd:task.project_cwd},{hostId:config.hostId,timeoutMs:60_000});
        if(inventory.hostId!==config.hostId) throw new Error("onboarding inventory came from a different host");
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
        snapshot=onboardingChildSnapshot(receipt?.result);
        threadId=receipt?.threadId??null;
        if(threadId) return await finishObservation(threadId,snapshot);
        if(!snapshot){
          const sorted=[...inventory.pages].sort((a,b)=>b.modifiedAt-a.modifiedAt||a.path.localeCompare(b.path));
          const pages:OnboardingInputPage[]=[]; let total=0;
          for(const page of sorted){
            const bytes=Buffer.byteLength(page.content,"utf8");
            if(pages.length>=40||total+bytes>80_000) continue;
            pages.push({path:page.path,sha256:page.sha256,content:page.content}); total+=bytes;
          }
          snapshot={pages,inputBytes:total,inputPageCount:pages.length,availablePageCount:inventory.pages.length,
            acceptanceSha256:accepted.outputSha256??"",agent,depth,dispatchInput:JSON.parse(base.input),
            acceptedEvidence:acceptedOnboardingEvidence({outputSha256:accepted.outputSha256,result:accepted.result})};
          persistRunning(null,{snapshot},"onboarding_spawn_requested");
          receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
        }
      }
      if(!claimStageSpawn(db,args.runId,args.taskId,"onboarding-preview")){
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
        if(receipt?.threadId) return await finishObservation(receipt.threadId,snapshot);
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:receipt?.threadId??null,reason:"observing",detail:"onboarding_spawn_claimed"};
      }
      const [providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:config.hostId}),bb.sdk.providers.models({providerId,hostId:config.hostId})]);
      const provider=providers.find((item)=>item.id===providerId&&item.available),model=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!provider||!model) throw new Error("onboarding_provider_or_model_unavailable");
      const effortSetting=typeof settings["onboarding.reasoning_effort"]==="string"?settings["onboarding.reasoning_effort"] as string:null;
      const effort=effortSetting??(model.supportedReasoningEfforts.some((item)=>item.reasoningEffort==="medium")?"medium":model.supportedReasoningEfforts[0]?.reasoningEffort);
      if(!effort||!model.supportedReasoningEfforts.some((item)=>item.reasoningEffort===effort)) throw new Error(`onboarding_reasoning_effort_unsupported:${effort??"none"}`);
      const requestedTier=settings["onboarding.service_tier"]==="fast"?"fast":"standard";
      const tier=provider.capabilities.supportsServiceTier?bbServiceTier(requestedTier):null;
      if(tier&&!(provider.serviceTiers??[]).some((item)=>item.id===tier)) throw new Error(`onboarding_service_tier_unsupported:${tier}`);
      const acceptedEvidence=snapshot.acceptedEvidence
        ?? acceptedOnboardingEvidence({outputSha256:accepted.outputSha256,result:accepted.result});
      const prompt=onboardingPrompt({task:{objective:task.objective,owns_paths:task.owns_paths,never_touch:task.never_touch,expected_outputs:task.expected_outputs,verification:task.verification},pages:snapshot.pages,accepted:acceptedEvidence,agent:snapshot.agent,depth:snapshot.depth});
      const helperPolicy=requireHelperSpawn({bb,db,projectId:args.projectId,runId:args.runId});
      const placement=await helperChildPlacement({
        bb, db, projectId:args.projectId, runId:args.runId, role:"onboarder",
      });
      const spawned=await fullAccessSpawn(bb, {...placement,...requiredPolicyField(bb, helperPolicy, providerId, "onboarder"),...writerExecutionSelection(providerId,modelId,effort,tier),prompt,
        environment:workspaceExecutionEnvironment(config.hostId,workspace),
        pluginMetadata:{role:"onboarder",lanePilotRunId:args.runId,lanePilotTaskId:args.taskId,stageId:"onboarding-preview",parentPmThreadId:args.threadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true}});
      threadId=stringAt(spawned,"id");if(!threadId) throw new Error("onboarding_thread_id_missing");
      persistRunning(threadId,{...childResultObject(receipt?.result),snapshot,spawnAttempted:true});
      return await finishObservation(threadId,snapshot);
    }catch(cause){
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="onboarding-preview");
      if(current && !["pending","running"].includes(current.state)) {
        return {runId:args.runId,taskId:args.taskId,state:current.state,reason:"onboarding preview already has a receipt; create a new task for another preview",stage:current};
      }
      const reason=cause instanceof Error?cause.message:String(cause);
      if(!threadId){
        const recovered=await services.reconcileStageChild(args.projectId,args.runId,args.taskId,"onboarding-preview","onboarder").catch(()=>({kind:"error" as const,message:reason}));
        if(recovered.kind==="found"){
          persistRunning(recovered.threadId,{...childResultObject(receipt?.result),observing:reason});
          return {runId:args.runId,taskId:args.taskId,state:"running",threadId:recovered.threadId,reason:"observing",detail:reason};
        }
        persistRunning(null,{...childResultObject(receipt?.result),observing:reason},"onboarding_spawn_unknown");
        return {runId:args.runId,taskId:args.taskId,state:"running",reason:"observing",detail:reason};
      }
      if(reason.includes("events_list_error")||reason.includes("host")||reason.includes("disconnect")||reason.includes("ECONN")||reason.includes("502")){
        persistRunning(threadId,{...childResultObject(receipt?.result),observing:reason});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId,reason:"observing",detail:reason};
      }
      recordStage(db,{...base,state:"failed",providerId,model:modelId,threadId,reason,result:{error:reason}});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
    }
  }

  async function applyOnboardingPreview(args:{threadId:string;projectId:string;runId:string;taskId:string;previewSha256:string;confirm:boolean}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") throw new Error("task does not belong to this PM run and project");
    const taskContract=taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    const receipts=listStageReceipts(db,args.runId,args.taskId),previewRow=receipts.find((row)=>row.stageId==="onboarding-preview");
    if(previewRow?.state!=="passed"||!previewRow.result) throw new Error("a passed onboarding preview is required before apply");
    const resultValue=valueAt(previewRow.result,"preview"),preview=onboardingPreviewSchema.parse(resultValue),expected=onboardingPreviewSha256(preview);
    if(expected!==args.previewSha256||stringAt(previewRow.result,"previewSha256")!==expected) throw new Error("preview hash is stale or does not match the saved preview");
    const input=JSON.stringify({taskId:args.taskId,previewSha256:expected,confirmed:args.confirm});
    const base={runId:args.runId,taskId:args.taskId,stageId:"onboarding-apply" as const,input};
    const existing=receipts.find((row)=>row.stageId==="onboarding-apply");
    if(existing) return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"onboarding apply already has a receipt; edits are single-use per task",stage:existing};
    recordStage(db,{...base,state:"pending"});
    if(!args.confirm){
      recordStage(db,{...base,state:"blocked",reason:"explicit_confirmation_required",result:{previewSha256:expected,writes:[]}});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason:"explicit_confirmation_required",previewSha256:expected,writes:[]};
    }
    recordStage(db,{...base,state:"running"});
    try{
      const applied=await host.call("applyOnboardingPages",{requestedHostId:config.hostId,projectCwd:task.project_cwd,confirmed:true,previewSha256:expected,edits:preview.edits},{hostId:config.hostId,timeoutMs:60_000});
      if(applied.hostId!==config.hostId||applied.previewSha256!==expected) throw new Error("onboarding host receipt identity mismatch");
      let state:"passed"|"blocked"=applied.status==="applied"?"passed":"blocked";
      if(state==="passed"){
        const inventory=await host.call("listDocsPages",{requestedHostId:config.hostId,projectCwd:task.project_cwd},{hostId:config.hostId,timeoutMs:60_000});
        if(inventory.hostId!==config.hostId) throw new Error("onboarding readback came from a different host");
        for(const write of applied.writes){
          const page=inventory.pages.find((item)=>item.path===write.path);
          if(write.status!=="applied"||!page||page.sha256!==write.afterSha256) throw new Error(`onboarding host readback mismatch:${write.path}`);
        }
      }
      const receipt={...applied,readbackVerified:state==="passed",readbackSha256:state==="passed"?sha256(JSON.stringify(applied.writes.map((write)=>({path:write.path,sha256:write.afterSha256})))):null};
      recordStage(db,{...base,state,reason:applied.reason??undefined,result:receipt});
      return {runId:args.runId,taskId:args.taskId,state,result:receipt,reason:applied.reason};
    }catch(cause){
      const reason=cause instanceof Error?cause.message:String(cause);
      recordStage(db,{...base,state:"failed",reason,result:{previewSha256:expected,error:reason,writes:[]}});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
    }
  }

  return { runOnboardingPreview, applyOnboardingPreview };
}
