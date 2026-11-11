import { getRun, listStageReceipts } from "../../storage";
import { requireGreen } from "@lane-pilot/workflow-engine";
import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { withUsage } from "../../usage/server";
import type { DocsUnit } from "../docs";
import { pluginStopped } from "./plugin-stopped";
import { docsUnitRecordKey } from "./docs-unit-records";
import { prepareDocsUnit, writeDocsUnit, verifyDocsUnit, commitDocsUnit, unitLabelOf } from "./docs-unit-steps";
import type { NightlyShared, UnitInputs, UnitPlan, Verified } from "./docs-night-state";

  /**
   * The executors of the docs graphs. Registered by server.ts once the workflow engine exists (the services are assembled before it is). Every step is
   * reentrant: the unit record and the git state are the progress, so a step a reload cut off is simply run again, and while the plugin is stopping a
   * step holds instead of failing, so the run is picked up by the next instance.
   */
  export function registerDocsGraphs(n:NightlyShared,engine:WorkflowEngine):void {
    const {ctx,services,bb,db}=n;

    const held=async<T>(work:()=>Promise<T>):Promise<T>=>{
      try{ return await work(); }
      catch(cause){ if(ctx.isDisposed()) return await new Promise<T>(()=>undefined); throw cause; }
    };
    const stopOf=(c:StepContext)=>():string|null=>ctx.isDisposed()?"plugin_stopped":c.signal.aborted?"aborted":null;
    const input=(c:StepContext,name:string)=>c.resolve(`$inputs.${name}`);
    const text=(value:unknown)=>typeof value==="string"?value:"";
    const list=(value:unknown):string[]=>Array.isArray(value)?value.map(String):[];
    const inputsOf=(c:StepContext):UnitInputs=>({projectId:text(input(c,"project_id")),place:{hostId:text(input(c,"host_id")),path:text(input(c,"path"))},basePath:text(input(c,"base_path")),
      scopes:list(input(c,"scopes")),unit:input(c,"unit") as DocsUnit,roots:list(input(c,"roots")),exclude:list(input(c,"exclude")),workspaces:(Array.isArray(input(c,"workspaces"))?input(c,"workspaces"):[]) as UnitInputs["workspaces"],
      base:text(input(c,"base")),runKey:text(input(c,"run_key")),assignment:text(input(c,"assignment"))});
    const keyOf=(i:UnitInputs)=>docsUnitRecordKey(i.projectId,i.place.path,unitLabelOf(i.unit));
    const earlier=(c:StepContext,ref:string):unknown=>{ try{ return c.resolve(ref); }catch{ return undefined; } };

    engine.register("lp.docs_prepare",{reentrant:true,run:(c)=>held(async()=>{
      const found=await prepareDocsUnit(n,inputsOf(c));
      return {output:found.state==="skipped"?{state:"skipped",row:found.row}:found.state==="resume"?{state:"resume"}:{state:"ready",plan:found.plan}};
    })});

    engine.register("lp.docs-unit",{reentrant:true,run:(c)=>held(async()=>{
      const i=inputsOf(c);
      const threadId=await writeDocsUnit(n,i,(earlier(c,"prepare.plan") as UnitPlan|undefined)??null,{runId:c.runId,stepKey:c.stepKey,nodeId:c.nodeId},stopOf(c));
      return {output:{state:"written",thread_id:threadId,handoff:`docs agent ended in ${threadId}`},threadId};
    })});

    engine.register("lp.docs_verify",{reentrant:true,run:(c)=>held(async()=>{
      const i=inputsOf(c);
      const done=await verifyDocsUnit(n,keyOf(i),stopOf(c));
      if(done.state==="skipped") return {output:{state:"skipped",row:done.row}};
      return {output:{state:"ok",checked:done.verified},...(await withUsage(bb,done.threadId))};
    })});

    engine.register("lp.docs_commit",{reentrant:true,run:(c)=>held(async()=>{
      const i=inputsOf(c);
      const verified=earlier(c,"verify.checked") as Verified|undefined;
      if(!verified) throw new Error("docs unit has no verified pages to commit");
      return {output:{row:await commitDocsUnit(n,keyOf(i),verified)}};
    })});

    // The docs upkeep of one accepted task: the stage function is called until its receipt is final, as the hourly schedule called it.
    engine.register("lp.docs-maintenance",{reentrant:true,run:(c)=>held(async()=>{
      const runId=text(input(c,"run_id")), taskId=text(input(c,"task_id")), threadId=text(input(c,"pm_thread_id"));
      const projectId=engine.journal.getRun(c.runId)?.project_id??getRun(db,runId)?.project_id??"";
      const since=Date.now();
      let result:Record<string,unknown>={state:"running"};
      try{
        for(let round=0;round<60&&!ctx.isDisposed()&&!c.signal.aborted;round++){
          result=await services.runDocsMaintenance({threadId,projectId,runId,taskId,timeoutSec:60,assignment:text(input(c,"assignment"))||undefined,workflow:{runId:c.runId,stepKey:c.stepKey,nodeId:c.nodeId}});
          if(result.state!=="running") break;
        }
      }catch(cause){
        if(ctx.isDisposed()||pluginStopped(cause)) throw cause;
        const reason=cause instanceof Error?cause.message:String(cause);
        bb.log.warn(`Lane Pilot docs maintenance failed for project ${projectId}: ${reason}`);
        result={state:"failed",reason};
      }
      if(ctx.isDisposed()) return await new Promise<never>(()=>undefined);
      const receipt=listStageReceipts(db,runId,taskId).find((row)=>row.stageId==="docs-maintenance");
      const usage=receipt?.threadId&&receipt.updatedAt>=since?await withUsage(bb,receipt.threadId):{};
      const state=text(result.state), reason=text(result.reason);
      return {output:{state,...(reason?{reason}:{}),handoff:`docs-maintenance ${state}${reason?`: ${reason}`:""}`},...usage};
    })});

    // The verdict of the upkeep: a stage that failed or was blocked fails the graph run (its step above keeps the output and what it spent).
    // `running` is not red: the stage is still observing and the next hour's run picks its receipt up again.
    engine.register("lp.docs-maintenance.verdict",{reentrant:true,run:async(c)=>{
      const state=text(earlier(c,"docs.state")), reason=text(earlier(c,"docs.reason"));
      requireGreen("docs_maintenance",[{stage:"docs-maintenance",state,reason}],new Set(["failed","blocked"]));
      return {output:{state}};
    }});
  }
