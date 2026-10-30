import { taskV2Schema } from "../../contracts";
import { getRun, getTask, listAttemptsForTask, listStageReceipts } from "../../storage";
import { resolveManagedWorkspace } from "../../verification";
import { recordStage } from "../../runs/server";
import { GIT_PLUGIN_ID, gitCallRpc, stringAt, valueAt } from "../../core/server";

/** The retired environments.status/diff calls, kept as the fallback where bb--git RPC fails (older BB served them directly). */
const legacyEnvironments = (bb: unknown) => ((bb as { sdk?: { environments?: { status?: (a:{environmentId:string})=>Promise<unknown>; diff?: (a:{environmentId:string;target:string})=>Promise<unknown> } } }).sdk?.environments ?? {});
import { z } from "zod";
import type { ServerCore } from "../../core/server";

export function createNightStages(ctx: ServerCore) {
  const { acceptedTaskWorkspace, bb, configForRun, db, workspaceExecutionEnvironment } = ctx;

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
      const gitRpc=gitCallRpc(bb);
      const anything=z.unknown();
      const [status,diff]=await Promise.all(gitRpc?[
        gitRpc({pluginId:GIT_PLUGIN_ID,method:"workspaceStatus",input:{environmentId:managedWorkspace.environmentId},outputSchema:anything}),
        gitRpc({pluginId:GIT_PLUGIN_ID,method:"diff",input:{environmentId:managedWorkspace.environmentId,target:{type:"uncommitted"}},outputSchema:anything}),
      ]:[
        legacyEnvironments(bb).status?.({environmentId:managedWorkspace.environmentId}),
        legacyEnvironments(bb).diff?.({environmentId:managedWorkspace.environmentId,target:"uncommitted"}),
      ]).catch(()=>Promise.all([
        legacyEnvironments(bb).status?.({environmentId:managedWorkspace.environmentId}),
        legacyEnvironments(bb).diff?.({environmentId:managedWorkspace.environmentId,target:"uncommitted"}),
      ]));
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

  return { runWorkspaceStatus };
}
