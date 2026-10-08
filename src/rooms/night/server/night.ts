import { attemptProduced } from "../../../cli-outcome";
import { taskV2Schema } from "../../../contracts";
import { claimStageSpawn, getRun, getRunSettingsScopes, getTask, listAttemptsForTask, listStageReceipts, loadProjectSettings } from "../../storage/database";
import { bbServiceTier, writerExecutionSelection } from "@lane-pilot/models";
import { resolveStageWriterSelection } from "../../../stage-writer-selection";
import { readGateReport } from "../../tasks/gate-report";
import { gateTriagePrompt, parseGateTriageResult } from "../../verification/gate-triage";
import { nightReviewPrompt, parseNightReviewResult, shouldRunNightReview } from "../night";
import { buildNightFixPlan, decideNightMerge, nightFixBlockedReason, nightFixPrompt } from "../night-fix";
import { findUnownedChanges } from "../../verification/ownership";
import { resolveManagedWorkspace } from "../../verification/routing";
import { compactAcceptedResult } from "../../tasks/server/accepted-compact";
import { NightChildSnapshot, childResultObject, nightChildSnapshot } from "../../../server/child-snapshots";
import { fullAccessSpawn } from "../../../server/pm-spawn";
import { reviewerMemoryFor } from "../../memory/server/memory-mix";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../../server/run-routing";
import { recordStage } from "../../../server/stage-records";
import { stringAt, valueAt } from "../../../server/values";
import { observeStageChild, waitThreadIdle } from "@lane-pilot/thread-observe";
import type { ServerCore } from "../../../server/core";
import type { Services } from "../../../server/services";

export function createNightStages(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, workspaceExecutionEnvironment } = ctx;

  async function runNightReview(args:{threadId:string;projectId:string;runId:string;taskId:string;timeoutSec?:number}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") throw new Error("task does not belong to this PM run and project");
    const taskContract=taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    const accepted=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="acceptance-receipt");
    if(accepted?.state!=="passed"||!accepted.outputSha256) throw new Error("night review requires an accepted writer receipt first");
    const settings=loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
    const policy=shouldRunNightReview(settings["night_review.enabled"]);
    const selection=resolveStageWriterSelection({settings,config,stageProviderKey:"night_review.provider",stageModelKey:"night_review.model"});
    const providerId=selection.providerId;
    const modelId=selection.model;
    const effort=typeof settings["night_review.reasoning_effort"]==="string"&&settings["night_review.reasoning_effort"]?settings["night_review.reasoning_effort"] as string:"high";
    const serviceTier=settings["night_review.service_tier"]==="fast"?"fast":"standard";
    const agent=typeof settings["night_review.agent"]==="string"&&settings["night_review.agent"].trim()?settings["night_review.agent"].trim().slice(0,100):"lane-reviewer";
    const source=JSON.stringify({taskId:args.taskId,acceptanceSha256:accepted.outputSha256,providerId,modelId,effort,serviceTier,agent});
    const base={runId:args.runId,taskId:args.taskId,stageId:"night-review" as const,input:source};
    const existing=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
    if(existing && !["pending","running"].includes(existing.state)) {
      return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"night review already has a receipt; create a new task for another review",stage:existing};
    }
    if(!existing) recordStage(db,{...base,state:"pending",providerId,model:modelId});
    const liveChild=Boolean(existing?.threadId || nightChildSnapshot(existing?.result));
    if(!policy.run && !liveChild) {
      const invalid=policy.reason?.startsWith("invalid_");
      recordStage(db,{...base,state:invalid?"blocked":"skipped",providerId,model:modelId,reason:policy.reason??undefined});
      return {runId:args.runId,taskId:args.taskId,state:invalid?"blocked":"skipped",reason:policy.reason};
    }
    const claimed=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
    if(claimed?.state==="pending") recordStage(db,{...base,state:"running",providerId,model:modelId,threadId:claimed.threadId,result:claimed.result,reason:"night_spawn_requested"});
    let receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
    let threadId:string|null=receipt?.threadId??null;
    const observeMs=Math.min(240, Math.max(1, args.timeoutSec ?? 60)) * 1000;
    const persistRunning=(nextThreadId:string|null, result:unknown, reason?:string)=>{
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
      if(current && !["pending","running"].includes(current.state)) return current;
      recordStage(db,{...base,state:"running",providerId,model:modelId,
        threadId:nextThreadId ?? current?.threadId ?? null,
        result:{...childResultObject(current?.result),...childResultObject(result)},reason});
      return undefined;
    };
    const finishObservation=async(childId:string, snapshot:NightChildSnapshot|null):Promise<Record<string,unknown>>=>{
      const already=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
      if(already && !["pending","running"].includes(already.state)) {
        return {runId:args.runId,taskId:args.taskId,state:already.state,reason:"night review already has a receipt; create a new task for another review",stage:already};
      }
      const observed=await observeStageChild(bb,childId,observeMs);
      const latest=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
      if(latest && !["pending","running"].includes(latest.state)) {
        return {runId:args.runId,taskId:args.taskId,state:latest.state,reason:"night review already has a receipt; create a new task for another review",stage:latest};
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
        persistRunning(childId,{...prior,observing:"night_snapshot_missing"});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:"night_snapshot_missing"};
      }
      const output=(await bb.sdk.threads.output({threadId:childId})).output;
      if(typeof output!=="string"||!output.trim()) throw new Error("night_review_output_empty");
      const parsed=parseNightReviewResult(output);
      const state=parsed.findings.some((item)=>item.severity==="blocking")?"blocked":"passed";
      const reason=state==="blocked"?"night_review_blocking_findings":undefined;
      const acceptedResult={...parsed,sourceSha256:snapshot.acceptanceSha256,agent:snapshot.agent,serviceTier,findingsCount:parsed.findings.length,snapshot};
      recordStage(db,{...base,state,providerId,model:modelId,threadId:childId,result:acceptedResult,reason});
      return {runId:args.runId,taskId:args.taskId,state,result:acceptedResult,reason};
    };
    try {
      receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
      threadId=receipt?.threadId??null;
      let snapshot=nightChildSnapshot(receipt?.result);
      if(!threadId){
        const recovered=await services.reconcileStageChild(args.projectId,args.runId,args.taskId,"night-review","night-reviewer");
        if(recovered.kind==="found"){
          threadId=recovered.threadId;
          persistRunning(threadId,{...childResultObject(receipt?.result),...(snapshot?{snapshot}:{})});
          receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
        } else if(recovered.kind!=="not_found") {
          persistRunning(null,{...childResultObject(receipt?.result),...(snapshot?{snapshot}:{}),observing:recovered.kind});
          return {runId:args.runId,taskId:args.taskId,state:"running",reason:"observing",detail:recovered.kind};
        }
      }
      if(threadId) return await finishObservation(threadId,snapshot);
      if(!snapshot){
        snapshot={acceptanceSha256:accepted.outputSha256,agent,dispatchInput:JSON.parse(base.input)};
        persistRunning(null,{snapshot},"night_spawn_requested");
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
      }
      if(!claimStageSpawn(db,args.runId,args.taskId,"night-review")){
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
        if(receipt?.threadId) return await finishObservation(receipt.threadId,snapshot);
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:receipt?.threadId??null,reason:"observing",detail:"night_spawn_claimed"};
      }
      const [providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:config.hostId}),bb.sdk.providers.models({providerId,hostId:config.hostId})]);
      const provider=providers.find((item)=>item.id===providerId&&item.available);
      const model=catalog.models.find((item)=>item.id===modelId||item.model===modelId);
      if(!provider||!model) throw new Error("night_review_provider_or_model_unavailable");
      if(!model.supportedReasoningEfforts.some((item)=>item.reasoningEffort===effort)) throw new Error(`night_review_reasoning_effort_unsupported:${effort}`);
      const tier=provider.capabilities.supportsServiceTier?bbServiceTier(serviceTier):null;
      if(tier&&!(provider.serviceTiers??[]).some((item)=>item.id===tier)) throw new Error(`night_review_service_tier_unsupported:${tier}`);
      const helperPolicy=requireHelperSpawn({bb,db,projectId:args.projectId,runId:args.runId});
      const placement=await helperChildPlacement({
        bb, db, projectId:args.projectId, runId:args.runId, role:"night-reviewer",
      });
      const spawned=await fullAccessSpawn(bb, {...placement,...requiredPolicyField(bb, helperPolicy, providerId, "night-reviewer"),...writerExecutionSelection(providerId,modelId,effort,tier),
        prompt:nightReviewPrompt({agent:snapshot.agent,task,acceptedResult:compactAcceptedResult(accepted.result),workspace:task.project_cwd,maxFindings:20,memoryText:reviewerMemoryFor(db,args.projectId,args.runId,task)}),
        environment:workspaceExecutionEnvironment(config.hostId,workspace),
        pluginMetadata:{role:"night-reviewer",lanePilotRunId:args.runId,lanePilotTaskId:args.taskId,stageId:"night-review",parentPmThreadId:args.threadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true}});
      threadId=stringAt(spawned,"id");if(!threadId) throw new Error("night_review_thread_id_missing");
      persistRunning(threadId,{...childResultObject(receipt?.result),snapshot,spawnAttempted:true});
      return await finishObservation(threadId,snapshot);
    } catch(cause) {
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="night-review");
      if(current && !["pending","running"].includes(current.state)) {
        return {runId:args.runId,taskId:args.taskId,state:current.state,reason:"night review already has a receipt; create a new task for another review",stage:current};
      }
      const reason=cause instanceof Error?cause.message:String(cause);
      if(!threadId){
        const recovered=await services.reconcileStageChild(args.projectId,args.runId,args.taskId,"night-review","night-reviewer").catch(()=>({kind:"error" as const,message:reason}));
        if(recovered.kind==="found"){
          persistRunning(recovered.threadId,{...childResultObject(receipt?.result),observing:reason});
          return {runId:args.runId,taskId:args.taskId,state:"running",threadId:recovered.threadId,reason:"observing",detail:reason};
        }
        persistRunning(null,{...childResultObject(receipt?.result),observing:reason},"night_spawn_unknown");
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

  async function runGateTriage(args:{threadId:string;projectId:string;runId:string;taskId:string;days:number;providerId?:string;model?:string;reasoningEffort?:string}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") throw new Error("task does not belong to this PM run and project");
    const existing=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="gate-triage");
    if(existing) return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"gate triage already has a receipt for this task",stage:existing};
    const report=readGateReport(db,{projectId:args.projectId,days:args.days});
    const settings=loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
    const providerId=args.providerId??(typeof settings["plan_critique.provider"]==="string"&&settings["plan_critique.provider"]?settings["plan_critique.provider"]:config.pmProviderId);
    const modelId=args.model??(typeof settings["plan_critique.model"]==="string"&&settings["plan_critique.model"]?settings["plan_critique.model"]:config.pmModel);
    const effort=args.reasoningEffort??(typeof settings["plan_critique.reasoning_effort"]==="string"&&settings["plan_critique.reasoning_effort"]?settings["plan_critique.reasoning_effort"]:"medium");
    const source=JSON.stringify({days:args.days,from:report.from,to:report.to,report,providerId,modelId,effort});
    const base={runId:args.runId,taskId:args.taskId,stageId:"gate-triage" as const,input:source};
    recordStage(db,{...base,state:"pending",providerId,model:modelId});
    recordStage(db,{...base,state:"running",providerId,model:modelId});
    let threadId:string|null=null;
    try {
      const [providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:config.hostId}),bb.sdk.providers.models({providerId,hostId:config.hostId})]);
      const provider=providers.find((row)=>row.id===providerId&&row.available),model=catalog.models.find((row)=>row.id===modelId||row.model===modelId);
      if(!provider||!model) throw new Error("gate_triage_provider_or_model_unavailable");
      if(!model.supportedReasoningEfforts.some((row)=>row.reasoningEffort===effort)) throw new Error(`gate_triage_reasoning_effort_unsupported:${effort}`);
      const helperPolicy=requireHelperSpawn({bb,db,projectId:args.projectId,runId:args.runId});
      const placement=await helperChildPlacement({
        bb, db, projectId:args.projectId, runId:args.runId, role:"gate-triage",
      });
      const spawned=await fullAccessSpawn(bb, {...placement,...requiredPolicyField(bb, helperPolicy, providerId, "gate-triage"),...writerExecutionSelection(providerId,modelId,effort,null),
        prompt:gateTriagePrompt(report),environment:workspaceExecutionEnvironment(config.hostId,{path:run.writer_workspace_path??config.pmWorkspacePath,environmentId:null}),
        pluginMetadata:{role:"gate-triage",lanePilotRunId:args.runId,lanePilotTaskId:args.taskId,stageId:"gate-triage",parentPmThreadId:args.threadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true}});
      threadId=stringAt(spawned,"id");if(!threadId) throw new Error("gate_triage_thread_id_missing");
      recordStage(db,{...base,state:"running",providerId,model:modelId,threadId});
      await waitThreadIdle(bb,threadId,"gate_triage_timeout");
      const output=(await bb.sdk.threads.output({threadId})).output;
      if(typeof output!=="string"||!output.trim()) throw new Error("gate_triage_output_empty");
      const result=parseGateTriageResult(output);
      const state=result.decision==="recommendations"?"blocked":"passed";
      recordStage(db,{...base,state,providerId,model:modelId,threadId,result,reason:state==="blocked"?"gate_triage_recommendations_available":undefined});
      return {runId:args.runId,taskId:args.taskId,state,result,reason:state==="blocked"?"gate_triage_recommendations_available":null};
    } catch(cause) {
      const reason=cause instanceof Error?cause.message:String(cause);
      if(threadId) {
        const thread=await bb.sdk.threads.get({threadId}).catch(()=>null);
        if(["active","starting"].includes(stringAt(thread,"status")??"")) await bb.sdk.threads.stop({threadId}).catch(()=>undefined);
      }
      recordStage(db,{...base,state:"failed",providerId,model:modelId,threadId,reason,result:{error:reason}});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
    }
  }

  async function runNightFix(args:{threadId:string;projectId:string;runId:string;taskId:string}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") throw new Error("task does not belong to this PM run and project");
    const taskContract=taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    const receipts=listStageReceipts(db,args.runId,args.taskId);
    const accepted=receipts.find((row)=>row.stageId==="acceptance-receipt");
    const review=receipts.find((row)=>row.stageId==="night-review");
    if(accepted?.state!=="passed"||!accepted.outputSha256) throw new Error("night fix requires an accepted writer receipt first");
    if(!review||!review.result||!(review.state==="blocked"||review.state==="passed")) throw new Error("night fix requires a completed night review");
    const reviewValue=review.result&&typeof review.result==="object"?review.result as Record<string,unknown>:{};
    const parsed=parseNightReviewResult(JSON.stringify({decision:reviewValue.decision,summary:reviewValue.summary,findings:reviewValue.findings}));
    const settings=loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
    const configuredLimit=settings["night_review.max_fix_tasks"];
    const repairSelection=resolveStageWriterSelection({settings,config,stageProviderKey:"night_review.provider",stageModelKey:"night_review.model"});
    const repairProviderId=repairSelection.providerId;
    const repairModelId=repairSelection.model;
    const repairEffort=typeof settings["night_review.reasoning_effort"]==="string"&&settings["night_review.reasoning_effort"]?settings["night_review.reasoning_effort"] as string:"high";
    const repairTier=settings["night_review.service_tier"]==="fast"?"fast":"standard";
    const maxFixTasks=typeof configuredLimit==="number"?configuredLimit:typeof configuredLimit==="string"?Number(configuredLimit):5;
    const plan=buildNightFixPlan(parsed,task,maxFixTasks);
    const source=JSON.stringify({acceptedSha256:accepted.outputSha256,reviewSha256:review.outputSha256,maxFixTasks:Math.max(1,Math.min(10,Number.isFinite(maxFixTasks)?Math.trunc(maxFixTasks):5)),paths:plan.paths,repairProviderId,repairModelId,repairEffort,repairTier});
    const base={runId:args.runId,taskId:args.taskId,stageId:"night-fix" as const,input:source};
    const existing=receipts.find((row)=>row.stageId==="night-fix");
    if(existing) return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"night fix already has a receipt; create a new task for another fix",stage:existing};
    const before=await services.workspaceDirt(config,task.project_cwd);
    if(!before.ok) throw new Error(`night_fix_snapshot_failed:${before.reason}`);
    recordStage(db,{...base,state:"pending",providerId:repairProviderId,model:repairModelId});
    recordStage(db,{...base,state:"running",providerId:repairProviderId,model:repairModelId});
    let threadId:string|null=null;
    try {
      const [providers,catalog]=await Promise.all([bb.sdk.providers.list({hostId:config.hostId}),bb.sdk.providers.models({providerId:repairProviderId,hostId:config.hostId})]);
      const provider=providers.find((item)=>item.id===repairProviderId&&item.available);
      const model=catalog.models.find((item)=>item.id===repairModelId||item.model===repairModelId);
      if(!provider||!model) throw new Error("night_fix_provider_or_model_unavailable");
      if(!model.supportedReasoningEfforts.some((item)=>item.reasoningEffort===repairEffort)) throw new Error(`night_fix_reasoning_effort_unsupported:${repairEffort}`);
      const tier=provider.capabilities.supportsServiceTier?bbServiceTier(repairTier):null;
      if(tier&&!(provider.serviceTiers??[]).some((item)=>item.id===tier)) throw new Error(`night_fix_service_tier_unsupported:${tier}`);
      const helperPolicy=requireHelperSpawn({bb,db,projectId:args.projectId,runId:args.runId});
      const placement=await helperChildPlacement({
        bb, db, projectId:args.projectId, runId:args.runId, role:"night-fixer",
      });
      const spawned=await fullAccessSpawn(bb, {...placement,...requiredPolicyField(bb, helperPolicy, repairProviderId, "night-fixer"),...writerExecutionSelection(repairProviderId,repairModelId,repairEffort,tier),
        prompt:nightFixPrompt({task,findings:plan.findings,paths:plan.paths}),
        environment:workspaceExecutionEnvironment(config.hostId,workspace),
        pluginMetadata:{role:"night-fixer",lanePilotRunId:args.runId,lanePilotTaskId:args.taskId,stageId:"night-fix",parentPmThreadId:args.threadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true}});
      threadId=stringAt(spawned,"id");if(!threadId) throw new Error("night_fix_thread_id_missing");
      await waitThreadIdle(bb,threadId,"night_fix_timeout");
      const output=(await bb.sdk.threads.output({threadId})).output;
      const after=await services.workspaceDirt(config,task.project_cwd);
      if(!after.ok) throw new Error(`night_fix_snapshot_failed:${after.reason}`);
      const changed=attemptProduced(after.snapshots,before.snapshots).sort();
      const outsideFinding=changed.filter((path)=>!plan.paths.includes(path));
      const unowned=findUnownedChanges(changed,task);
      const stopped=changed.length?null:nightFixBlockedReason(output);
      if(stopped!==null) {
        const reason=`night_fix_blocked:${stopped}`;
        recordStage(db,{...base,state:"blocked",providerId:repairProviderId,model:repairModelId,threadId,reason,result:{paths:plan.paths,changed,output:typeof output==="string"?output.slice(0,12000):""}});
        return {runId:args.runId,taskId:args.taskId,state:"blocked",reason};
      }
      if(!changed.length) throw new Error("night_fix_made_no_changes");
      if(outsideFinding.length||unowned.length) throw new Error(`night_fix_out_of_scope_changes:${[...new Set([...outsideFinding,...unowned])].join(",")}`);
      const verification=await services.runVerification(config,task,args.runId);
      const failed=task.verify==="none"||verification.length===0||verification.some((result)=>result.exitCode!==0);
      const settings=loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
      let merge:{merge:boolean;reason:string;pullRequest?:unknown}={merge:false,reason:"merge_not_explicitly_authorized"};
      const environmentId=workspace.environmentId;
      if(settings["night_review.auto_merge"]===true&&environmentId) {
        const environment=await bb.sdk.environments.get({environmentId});
        const pr=await bb.sdk.environments.pullRequest({environmentId});
        const row=valueAt(pr,"pullRequest");
        const readiness=decideNightMerge({explicitlyEnabled:true,fixState:failed?"failed":"passed",verificationPassed:!failed,
          managedWorktree:stringAt(environment,"hostId")===config.hostId&&valueAt(environment,"managed")===true,
          pullRequestOutcome:valueAt(pr,"outcome")==="available"?"available":valueAt(pr,"outcome")==="absent"?"absent":"unavailable",
          pullRequestState:stringAt(row,"state")??undefined,attention:stringAt(row,"attention")??undefined,
          checksState:stringAt(valueAt(row,"checks"),"state")??undefined,reviewState:stringAt(valueAt(row,"review"),"state")??undefined,
          mergeability:stringAt(valueAt(row,"mergeability"),"state")??undefined});
        merge={...readiness,pullRequest:row?{number:valueAt(row,"number"),url:valueAt(row,"url"),attention:valueAt(row,"attention")}:undefined};
        if(readiness.merge) {
          try {
            const merged=await bb.sdk.environments.mergePullRequest({environmentId,method:"squash"});
            merge={...readiness,reason:stringAt(merged,"message")??"pull_request_merged",pullRequest:row?{number:valueAt(row,"number"),url:valueAt(row,"url")}:undefined};
          } catch(mergeError) {
            const reconciled=await bb.sdk.environments.pullRequest({environmentId}).catch(()=>null);
            const reconciledPr=valueAt(reconciled,"pullRequest");
            merge={merge:stringAt(reconciledPr,"state")==="merged",reason:stringAt(reconciledPr,"state")==="merged"?"merge_confirmed_after_api_error":"merge_outcome_requires_reconciliation",
              pullRequest:reconciledPr?{number:valueAt(reconciledPr,"number"),url:valueAt(reconciledPr,"url"),detail:mergeError instanceof Error?mergeError.message:String(mergeError)}:undefined};
          }
        }
      } else if(settings["night_review.auto_merge"]===true) merge={merge:false,reason:"managed_worktree_required"};
      const state=failed?"blocked":"passed";
      const result={sourceSha256:accepted.outputSha256,reviewSha256:review.outputSha256,paths:plan.paths,changed,
        output:typeof output==="string"?output.slice(0,12000):"",verification,verificationPassed:!failed,merge};
      recordStage(db,{...base,state,providerId:repairProviderId,model:repairModelId,threadId,result,
        reason:failed?"night_fix_verification_failed":undefined});
      return {runId:args.runId,taskId:args.taskId,state,result};
    } catch(cause) {
      const reason=cause instanceof Error?cause.message:String(cause);
      if(threadId) {
        const thread=await bb.sdk.threads.get({threadId}).catch(()=>null);
        if(["active","starting"].includes(stringAt(thread,"status")??"")) await bb.sdk.threads.stop({threadId}).catch(()=>undefined);
      }
      recordStage(db,{...base,state:"failed",providerId:repairProviderId,model:repairModelId,threadId,reason,result:{error:reason}});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
    }
  }

  async function runWorkspaceStatus(args:{threadId:string;projectId:string;runId:string;taskId:string}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") throw new Error("task does not belong to this PM run and project");
    const taskContract=taskV2Schema.parse(taskRow.contract);
    // The status of the accepted attempt's own worktree, not of the run workspace its work was merged into.
    const acceptedAttempt=[...listAttemptsForTask(db,args.runId,args.taskId)].reverse().find((attempt)=>attempt.state==="accepted")?.id;
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract,acceptedAttempt);
    const task=workspace.task;
    const base={runId:args.runId,taskId:args.taskId,stageId:"workspace-status" as const,input:JSON.stringify({environmentId:workspace.environmentId,path:workspace.path})};
    const existing=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="workspace-status");
    if(existing) return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"workspace status already has a receipt; create a new task for another snapshot",stage:existing};
    recordStage(db,{...base,state:"pending"});
    if(!workspace.environmentId) {
      recordStage(db,{...base,state:"skipped",reason:"managed_worktree_not_selected"});
      return {runId:args.runId,taskId:args.taskId,state:"skipped",reason:"managed_worktree_not_selected"};
    }
    recordStage(db,{...base,state:"running"});
    try {
      const environment=await bb.sdk.environments.get({environmentId:workspace.environmentId});
      const managedWorkspace=resolveManagedWorkspace(environment,config.hostId);
      if(managedWorkspace.path!==task.project_cwd) throw new Error("managed workspace path does not match the accepted task workspace");
      const [status,diff]=await Promise.all([
        bb.sdk.environments.status({environmentId:managedWorkspace.environmentId}),
        bb.sdk.environments.diff({environmentId:managedWorkspace.environmentId,target:"uncommitted"}),
      ]);
      const statusJson=JSON.stringify(status),diffJson=JSON.stringify(diff),maxBytes=24_000;
      const result={environmentId:managedWorkspace.environmentId,hostId:managedWorkspace.hostId,path:managedWorkspace.path,
        status:statusJson.slice(0,maxBytes),statusTruncated:statusJson.length>maxBytes,
        diff:diffJson.slice(0,maxBytes),diffTruncated:diffJson.length>maxBytes,
        capturedAt:Date.now(),readOnly:true};
      const state=valueAt(status,"outcome")==="available"?"passed":"blocked";
      const reason=state==="blocked"?`workspace_status_${String(valueAt(status,"outcome")??"unavailable")}`:undefined;
      recordStage(db,{...base,state,result,reason});
      return {runId:args.runId,taskId:args.taskId,state,result,reason};
    } catch(cause) {
      const reason=cause instanceof Error?cause.message:String(cause);
      recordStage(db,{...base,state:"failed",reason,result:{error:reason}});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
    }
  }

  return { runNightReview, runGateTriage, runNightFix, runWorkspaceStatus };
}
