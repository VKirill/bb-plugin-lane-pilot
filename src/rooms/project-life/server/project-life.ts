import { acceptanceArtifactDir } from "../../tasks/acceptance-v2";
import { taskV2Schema } from "../../../contracts";
import { claimStageSpawn, getRun, getRunSettingsScopes, getTask, listOpenAttempts, listStageReceipts, loadProjectSettings } from "../../../database";
import { bbServiceTier, writerExecutionSelection } from "@lane-pilot/models";
import { PROJECT_LIFE_DEFAULT_WRITER, findOutOfScopeProjectLifeWrites, foldCoveredTaskIds, parseProjectLifeFinalMessage, parseProjectLifeSettings, projectLifePrompt, projectLifeWriterSelection, shouldTriggerProjectLife } from "../project-life";
import { ProjectLifeChildSnapshot, childResultObject, projectLifeChildSnapshot, spawnRefused } from "../../../server/child-snapshots";
import { configuredSetting } from "../../../server/context";
import { fullAccessSpawn } from "../../../server/pm-spawn";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../../server/run-routing";
import { recordStage } from "../../../server/stage-records";
import { stringAt, valueAt } from "../../../server/values";
import { observeStageChild } from "@lane-pilot/thread-observe";
import type { ServerCore } from "../../../server/core";
import type { Services } from "../../../server/services";

export function createProjectLifeStage(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, host, workspaceExecutionEnvironment } = ctx;

  /**
   * Project life is a background stage the plugin itself runs after an accepted wave goes idle — the PM
   * never calls it. It rewrites PROGRESS/plans/todos only; LESSONS.md and decision drafts stay with the PM.
   */
  function maintainProjectLifeAfterAcceptance(projectId:string, runId:string, taskId:string, pmThreadId:string):void {
    if (!shouldTriggerProjectLife(listOpenAttempts(db).map((attempt) => attempt.run_id), runId)) return;
    void (async () => {
      // Project life commits PROGRESS and plans to main; a folder without git has no main.
      const run = getRun(db, runId);
      const config = await configForRun(projectId, run);
      if (run?.writer_workspace_path && config && await services.isLiveFolder(runId, config.hostId, run.writer_workspace_path)) return;
      for (let round = 0; round < 60 && !ctx.state.disposed; round++) {
        const result = await runProjectLifeMaintenance({ threadId:pmThreadId, projectId, runId, taskId, timeoutSec:60 });
        if (result.state !== "running") return;
      }
    })().catch((cause: unknown) => {
      if (!ctx.state.disposed) bb.log.warn(`Lane Pilot project-life after ${taskId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  async function runProjectLifeMaintenance(args:{threadId:string;projectId:string;runId:string;taskId:string;timeoutSec?:number}):Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") throw new Error("task does not belong to this PM run and project");
    const taskContract=taskV2Schema.parse(taskRow.contract);
    // Project-life memory commits must ONLY happen on the base checkout's main branch, never in an attempt/area worktree.
    const workspace={
      path: run.writer_workspace_path!,
      environmentId: run.writer_environment_id ?? null,
      task: { ...taskContract, project_cwd: run.writer_workspace_path! },
    };
    const accepted=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="acceptance-receipt");
    if(accepted?.state!=="passed") throw new Error("project-life maintenance requires an accepted writer receipt first");

    const settings=loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
    const projectLifeSettings=parseProjectLifeSettings({"project_life.enabled":configuredSetting(settings,"project_life.enabled")});
    const projectLifeSelection=projectLifeWriterSelection(settings);
    const projectLifeProviderId=projectLifeSelection.providerId;
    const projectLifeModel=projectLifeSelection.model;
    const projectLifeEffort=typeof settings["project_life.reasoning_effort"]==="string"&&settings["project_life.reasoning_effort"]
      ? settings["project_life.reasoning_effort"] as string : PROJECT_LIFE_DEFAULT_WRITER.reasoningEffort;
    const projectLifeTier=settings["project_life.service_tier"]==="standard"?"standard":PROJECT_LIFE_DEFAULT_WRITER.serviceTier;

    const runReceipts=listStageReceipts(db,args.runId);
    const acceptedTaskIds=[...new Set(runReceipts.filter((row)=>row.stageId==="acceptance-receipt"&&row.state==="passed").map((row)=>row.taskId))];
    if(!acceptedTaskIds.includes(args.taskId)) throw new Error("triggering task has not been accepted in this run");
    const priorCovered=runReceipts.filter((row)=>row.stageId==="project-life"&&row.state==="passed")
      .flatMap((row)=>projectLifeChildSnapshot(row.result)?.coveredTaskIds ?? []);
    const coveredTaskIds=foldCoveredTaskIds(acceptedTaskIds,priorCovered);

    const base={runId:args.runId,taskId:args.taskId,stageId:"project-life" as const,
      input:JSON.stringify({coveredTaskIds,providerId:projectLifeProviderId,model:projectLifeModel,reasoningEffort:projectLifeEffort,serviceTier:projectLifeTier})};
    const existing=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
    if(existing && !["pending","running"].includes(existing.state)) {
      return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"project-life already has a receipt; create a new task for another run",stage:existing};
    }
    const inFlightElsewhere=runReceipts.find((row)=>row.stageId==="project-life"&&["pending","running"].includes(row.state)&&row.taskId!==args.taskId);
    if(!existing){
      if(inFlightElsewhere) return {runId:args.runId,taskId:args.taskId,state:"skipped",reason:"project_life_in_flight_elsewhere"};
      recordStage(db,{...base,state:"pending"});
    }
    const liveChild=Boolean(existing?.threadId || projectLifeChildSnapshot(existing?.result));
    if(!projectLifeSettings.enabled && !liveChild) {
      recordStage(db,{...base,state:"skipped",reason:"disabled_by_project_setting",result:{coveredTaskIds}});
      return {runId:args.runId,taskId:args.taskId,state:"skipped",reason:"disabled_by_project_setting"};
    }
    if(!coveredTaskIds.length && !liveChild) {
      recordStage(db,{...base,state:"skipped",reason:"no_uncovered_tasks",result:{coveredTaskIds}});
      return {runId:args.runId,taskId:args.taskId,state:"skipped",reason:"no_uncovered_tasks"};
    }
    const claimed=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
    if(claimed?.state==="pending") recordStage(db,{...base,state:"running",providerId:projectLifeProviderId,model:projectLifeModel,threadId:claimed.threadId,result:claimed.result,reason:"project_life_spawn_requested"});
    let receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
    let threadId:string|null=receipt?.threadId??null;
    const observeMs=Math.min(240, Math.max(1, args.timeoutSec ?? 60)) * 1000;
    const persistRunning=(nextThreadId:string|null, result:unknown, reason?:string)=>{
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
      if(current && !["pending","running"].includes(current.state)) return current;
      recordStage(db,{...base,state:"running",providerId:projectLifeProviderId,model:projectLifeModel,
        threadId:nextThreadId ?? current?.threadId ?? null,
        result:{...childResultObject(current?.result),...childResultObject(result)},reason});
      return undefined;
    };
    const finishObservation=async(childId:string, snapshot:ProjectLifeChildSnapshot|null):Promise<Record<string,unknown>>=>{
      const already=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
      if(already && !["pending","running"].includes(already.state)) {
        return {runId:args.runId,taskId:args.taskId,state:already.state,reason:"project-life already has a receipt; create a new task for another run",stage:already};
      }
      const observed=await observeStageChild(bb,childId,observeMs);
      const latest=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
      if(latest && !["pending","running"].includes(latest.state)) {
        return {runId:args.runId,taskId:args.taskId,state:latest.state,reason:"project-life already has a receipt; create a new task for another run",stage:latest};
      }
      const prior=childResultObject(latest?.result ?? receipt?.result);
      if(observed.kind==="observing") {
        persistRunning(childId,{...prior,...(snapshot?{snapshot}:{}),observing:observed.detail});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:observed.detail};
      }
      if(observed.kind==="product_failure") {
        recordStage(db,{...base,state:"failed",providerId:projectLifeProviderId,model:projectLifeModel,threadId:childId,reason:`${observed.via}:${observed.detail}`,result:{error:`${observed.via}:${observed.detail}`}});
        return {runId:args.runId,taskId:args.taskId,state:"failed",threadId:childId,reason:`${observed.via}:${observed.detail}`};
      }
      if(!snapshot) {
        persistRunning(childId,{...prior,observing:"project_life_snapshot_missing"});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:"project_life_snapshot_missing"};
      }
      const raw=(await bb.sdk.threads.output({threadId:childId})).output;
      if(typeof raw!=="string"||!raw.trim()) throw new Error("project_life_output_empty");
      const final=parseProjectLifeFinalMessage(raw);
      if(!final.commit) {
        const result={...final,coveredTaskIds:snapshot.coveredTaskIds};
        recordStage(db,{...base,state:"passed",providerId:projectLifeProviderId,model:projectLifeModel,threadId:childId,result});
        return {runId:args.runId,taskId:args.taskId,state:"passed",result};
      }
      const changes=await host.call("gitOwnershipChanges",{
        requestedHostId:config.hostId,projectCwd:workspace.path,baseSha:snapshot.baseHeadSha,compareCommitted:true,unfiltered:true,
      },{hostId:config.hostId,timeoutMs:30_000});
      if(changes.status!=="ready") throw new Error(`project_life_commit_verification_unavailable:${changes.reason??changes.status}`);
      if(final.commit.length<7||!changes.headSha?.startsWith(final.commit)) throw new Error("project_life_commit_head_mismatch");
      const outOfScope=findOutOfScopeProjectLifeWrites(changes.paths);
      if(outOfScope.length) {
        recordStage(db,{...base,state:"failed",providerId:projectLifeProviderId,model:projectLifeModel,threadId:childId,reason:"project_life_out_of_scope_write",result:{...final,outOfScope}});
        return {runId:args.runId,taskId:args.taskId,state:"failed",threadId:childId,reason:"project_life_out_of_scope_write"};
      }
      const result={...final,files:changes.paths,coveredTaskIds:snapshot.coveredTaskIds};
      recordStage(db,{...base,state:"passed",providerId:projectLifeProviderId,model:projectLifeModel,threadId:childId,result});
      return {runId:args.runId,taskId:args.taskId,state:"passed",result};
    };
    // Set when this call won the spawn claim and when it asked BB for the child: until then no child can exist.
    let claimedHere=false, spawnCalled=false;
    try {
      receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
      threadId=receipt?.threadId??null;
      let snapshot=projectLifeChildSnapshot(receipt?.result);
      if(!threadId){
        const recovered=await services.reconcileProjectLifeChild(args.projectId,args.runId,args.taskId);
        if(recovered.kind==="found"){
          threadId=recovered.threadId;
          persistRunning(threadId,{...childResultObject(receipt?.result),...(snapshot?{snapshot}:{})});
          receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
        } else if(recovered.kind!=="not_found") {
          persistRunning(null,{...childResultObject(receipt?.result),...(snapshot?{snapshot}:{}),observing:recovered.kind});
          return {runId:args.runId,taskId:args.taskId,state:"running",reason:"observing",detail:recovered.kind};
        }
      }
      if(threadId) return await finishObservation(threadId,snapshot);
      if(!snapshot){
        const gitBase=await host.call("gitOwnershipBase",{
          requestedHostId:config.hostId,projectCwd:workspace.path,baseRef:"HEAD",
        },{hostId:config.hostId,timeoutMs:30_000});
        if(gitBase.status!=="ready") throw new Error(`project_life_git_base_unavailable:${gitBase.reason??gitBase.status}`);
        const tasks=coveredTaskIds.map((id)=>services.projectLifeTaskSummary(args.runId,id));
        snapshot={coveredTaskIds,tasks,baseHeadSha:gitBase.baseSha,agent:"project-life-maintainer",dispatchInput:JSON.parse(base.input)};
        persistRunning(null,{snapshot},"project_life_spawn_requested");
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
      }
      if(!claimStageSpawn(db,args.runId,args.taskId,"project-life")){
        receipt=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
        if(receipt?.threadId) return await finishObservation(receipt.threadId,snapshot);
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:receipt?.threadId??null,reason:"observing",detail:"project_life_spawn_claimed"};
      }
      claimedHere=true;
      const [providers,catalog]=await Promise.all([
        bb.sdk.providers.list({hostId:config.hostId}),
        bb.sdk.providers.models({providerId:projectLifeProviderId,hostId:config.hostId}),
      ]);
      const provider=providers.find((item)=>item.id===projectLifeProviderId&&item.available);
      const model=catalog.models.find((item)=>item.id===projectLifeModel||item.model===projectLifeModel);
      if(!provider||!model) throw new Error("project_life_writer_provider_or_model_unavailable");
      if(!model.supportedReasoningEfforts.some((item)=>item.reasoningEffort===projectLifeEffort)) throw new Error(`project_life_writer_reasoning_effort_unsupported:${projectLifeEffort}`);
      const tier=provider.capabilities.supportsServiceTier?bbServiceTier(projectLifeTier):null;
      if(tier&&!(provider.serviceTiers??[]).some((item)=>item.id===tier)) throw new Error(`project_life_writer_service_tier_unsupported:${tier}`);
      const helperPolicy=requireHelperSpawn({bb,db,projectId:args.projectId,runId:args.runId});
      const placement=await helperChildPlacement({
        bb, db, projectId:args.projectId, runId:args.runId, role:"project-life-maintainer",
      });
      const artifactDirs=coveredTaskIds.map((id)=>acceptanceArtifactDir(workspace.path,args.runId,id));
      spawnCalled=true;
      const spawned=await fullAccessSpawn(bb, {...placement,...requiredPolicyField(bb, helperPolicy, projectLifeProviderId, "project-life"),
        ...writerExecutionSelection(projectLifeProviderId,projectLifeModel,projectLifeEffort,tier),
        prompt:projectLifePrompt({workspace:workspace.path,runId:args.runId,artifactDirs,tasks:snapshot.tasks,nowIso:new Date().toISOString()}),
        environment:workspaceExecutionEnvironment(config.hostId,workspace),
        pluginMetadata:{role:"project-life-maintainer",lanePilotRunId:args.runId,lanePilotTaskId:args.taskId,
          stageId:"project-life",parentPmThreadId:args.threadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true}});
      threadId=stringAt(spawned,"id"); if(!threadId) throw new Error("project_life_maintainer_thread_id_missing");
      persistRunning(threadId,{...childResultObject(receipt?.result),snapshot,spawnAttempted:true});
      return await finishObservation(threadId,snapshot);
    } catch(cause) {
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="project-life");
      if(current && !["pending","running"].includes(current.state)) {
        return {runId:args.runId,taskId:args.taskId,state:current.state,reason:"project-life already has a receipt; create a new task for another run",stage:current};
      }
      const reason=cause instanceof Error?cause.message:String(cause);
      if(!threadId){
        // A failure before the spawn request, or a spawn BB refused, leaves no child to wait for: kept running, the stage
        // stayed open for good once its claim was taken (SelfyStudio, 2026-10-05: «HTTP 409: Environment unavailable»).
        // A host hiccup before the claim is retried by the next round; after this call's own claim nothing would retry it.
        const transient=["events_list_error","host","disconnect","ECONN","502"].some((word)=>reason.includes(word));
        const neverSpawned=spawnCalled?spawnRefused(reason):claimedHere||(!transient&&childResultObject(current?.result).spawnAttempted!==true);
        if(neverSpawned&&!ctx.state.disposed){
          recordStage(db,{...base,state:"failed",providerId:projectLifeProviderId,model:projectLifeModel,reason,result:{error:reason}});
          return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
        }
        const recovered=await services.reconcileProjectLifeChild(args.projectId,args.runId,args.taskId).catch(()=>({kind:"error" as const,message:reason}));
        if(recovered.kind==="found"){
          persistRunning(recovered.threadId,{...childResultObject(receipt?.result),observing:reason});
          return {runId:args.runId,taskId:args.taskId,state:"running",threadId:recovered.threadId,reason:"observing",detail:reason};
        }
        persistRunning(null,{...childResultObject(receipt?.result),observing:reason},"project_life_spawn_unknown");
        return {runId:args.runId,taskId:args.taskId,state:"running",reason:"observing",detail:reason};
      }
      if(reason.includes("events_list_error")||reason.includes("host")||reason.includes("disconnect")||reason.includes("ECONN")||reason.includes("502")){
        persistRunning(threadId,{...childResultObject(receipt?.result),observing:reason});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId,reason:"observing",detail:reason};
      }
      recordStage(db,{...base,state:"failed",providerId:projectLifeProviderId,model:projectLifeModel,threadId,reason,result:{error:reason}});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
    }
  }

  return { maintainProjectLifeAfterAcceptance, runProjectLifeMaintenance };
}
