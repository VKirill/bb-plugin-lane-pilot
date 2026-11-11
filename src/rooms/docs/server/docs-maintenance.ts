import { wfRunsByIdemPrefix } from "@lane-pilot/workflow-engine";
import { claimDailySchedule, getActivation, getRun, listProjectsWithBindingSettings, listRunsWithAttempts, listStageReceipts, loadProjectSettings, loadPrototypeConfig } from "../../storage";
import { recordStage } from "../../runs/server";
import { configuredSetting } from "../../contracts/server";
import { isNotFound, valueAt } from "@lane-pilot/kit";
import { docsScheduleDue, localDateKey, parseDocsSettings } from "../docs";
import { DOCS_MAINTENANCE } from "../../contracts";
import { pluginStopped } from "./plugin-stopped";
import type { NightlyShared } from "./docs-night-state";

  /**
   * The docs upkeep of one accepted task as a graph run (`lp.docs-maintenance`). The run of an earlier hour that is still going is joined; one that
   * ended with the receipt still open (the stage was still observing) is followed by a new run, as the hour before called the stage again.
   */
  export async function runDocsMaintenanceGraph(n:NightlyShared,args:{
threadId:string;projectId:string;runId:string;taskId:string}):Promise<void> {
    const {ctx,services,bb,db}=n;
    const engine=services.workflowEngine;
    const workflow=services.workflowEngine.resolveWorkflow(DOCS_MAINTENANCE);
    if(!workflow) throw new Error(`built-in workflow ${DOCS_MAINTENANCE} is not loaded`);
    const prefix=`docs-maintenance:${args.runId}:${args.taskId}:`;
    const runs=wfRunsByIdemPrefix(db, `${prefix}%`);
    const live=runs.find((row)=>row.status==="running"||row.status==="waiting");
    const key=live?.idem_key??`${prefix}${runs.length}`;
    const started=engine.start({workflow,key,link:{projectId:args.projectId,runId:args.runId,taskId:args.taskId},inputs:{run_id:args.runId,task_id:args.taskId,pm_thread_id:args.threadId}});
    const summary=await started.done;
    if(summary.stopped||ctx.isDisposed()) throw new Error("plugin reloaded: the docs maintenance run goes on in the next instance");
    if(summary.status!=="succeeded"&&summary.status!=="running"&&summary.status!=="waiting") throw new Error(summary.error??summary.reason??`docs maintenance run ${summary.status}`);
  }

  export async function runScheduledDocsMaintenance(n:NightlyShared,signal?:AbortSignal):Promise<void> {
    const {ctx,services,bb,db}=n;

    const projectIds=listProjectsWithBindingSettings(db);
    const now=new Date(), today=localDateKey(now);
    for(const projectId of projectIds){
      signal?.throwIfAborted();
      const config=loadPrototypeConfig(db,projectId); if(!config) continue;
      const settings=loadProjectSettings(db,projectId);
      const docsSettings=parseDocsSettings(Object.fromEntries(["docs.enabled","docs.maintain","docs.since","docs.page_cap","docs.hour"].map((key)=>[key,configuredSetting(settings,key)])));
      if(!docsSettings.enabled||!docsSettings.maintain) continue;
      const activation=getActivation(db,projectId); if(!activation) continue;
      const run=getRun(db,activation.run_id); if(!run||run.closed_at||run.pm_thread_id!==activation.pm_thread_id) continue;
      const runHistory=listRunsWithAttempts(db,projectId).find((item)=>item.id===run.id);
      const taskId=runHistory?.attempts.map((item)=>item.task_id).find((candidate)=>{
        const receipts=listStageReceipts(db,run.id,candidate);
        if(!receipts.some((receipt)=>receipt.stageId==="acceptance-receipt"&&receipt.state==="passed")) return false;
        const docs=receipts.find((receipt)=>receipt.stageId==="docs-maintenance");
        return !docs || docs.state==="pending" || docs.state==="running";
      });
      if(!taskId) continue;
      // The PM chat of the run is gone (deleted or archived): maintenance reads it first and would throw "Thread not found"
      // every hour, leaving the receipt running for good (hub, 2026-10-08, layout-A3). The open receipts end canceled.
      const pm=await bb.sdk.threads.get({threadId:activation.pm_thread_id}).then((value)=>value as unknown,(cause:unknown)=>isNotFound(cause)?null:undefined);
      if(pm===null||(pm!==undefined&&valueAt(pm,"archivedAt")!=null)){
        for(const candidate of new Set(runHistory?.attempts.map((item)=>item.task_id))){
          const open=listStageReceipts(db,run.id,candidate).find((receipt)=>receipt.stageId==="docs-maintenance"&&(receipt.state==="pending"||receipt.state==="running"));
          if(open) recordStage(db,{runId:run.id,taskId:candidate,stageId:"docs-maintenance",state:"canceled",input:"pm_chat_gone",providerId:open.providerId,model:open.model,threadId:open.threadId,reason:"pm_chat_gone"});
        }
        bb.log.info(`Lane Pilot docs maintenance for project ${projectId} skipped: the PM chat ${activation.pm_thread_id} of run ${run.id} is gone`);
        continue;
      }
      const docs=listStageReceipts(db,run.id,taskId).find((receipt)=>receipt.stageId==="docs-maintenance");
      const resume=docs?.state==="pending"||docs?.state==="running";
      if(!resume) {
        if(!docsScheduleDue(now,docsSettings.hour,null)||!claimDailySchedule(db,projectId,"docs-maintenance",today)) continue;
      }
      // One project's failure must not leave the projects after it unprocessed.
      try{ await runDocsMaintenanceGraph(n,{threadId:activation.pm_thread_id,projectId,runId:run.id,taskId}); }
      catch(cause){
        if(signal?.aborted||pluginStopped(cause)) throw cause;
        bb.log.warn(`Lane Pilot docs maintenance failed for project ${projectId}: ${cause instanceof Error?cause.message:String(cause)}`);
      }
    }
  }
