import { taskV2Schema } from "../../contracts";
import { claimDocsSpawn, getRun, getRunSettingsScopes, getTask, listStageReceipts, loadProjectSettings } from "../../database";
import { bbServiceTier, writerExecutionSelection } from "../../jev-reasoning";
import { sha256 } from "../../stages/contract";
import { extractModelJson } from "../../stages/model-json";
import { docsInputHash, docsMaintenancePrompt, docsSelection, parseDocsSettings, selectDocsPages, validateDocsEdits } from "../../stages/docs";
import type { DocsPage } from "../../stages/docs";
import { boundedAgentName } from "../../stages/role";
import { DocsChildSnapshot, docsChildSnapshot, docsResultObject, resolveDocsSnapshotPageCap } from "../child-snapshots";
import { configuredSetting } from "../context";
import { fullAccessSpawn } from "../pm-spawn";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../run-routing";
import { recordStage } from "../stage-records";
import { stringAt, valueAt } from "../values";
import { observeStageChild } from "@lane-pilot/thread-observe";
import type { ServerCore } from "../core";
import type { Services } from "../services";

export function createDocsStage(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, host, workspaceExecutionEnvironment } = ctx;

  async function runDocsMaintenance(args:{threadId:string;projectId:string;runId:string;taskId:string;timeoutSec?:number}):Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if (valueAt(metadata,"role") !== "pm" || stringAt(metadata,"lanePilotRunId") !== args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run = getRun(db,args.runId), config = await configForRun(args.projectId, run), taskRow = getTask(db,args.taskId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId || !config || !taskRow || taskRow.run_id !== args.runId || taskRow.kind !== "bb") throw new Error("task does not belong to this PM run and project");
    const taskContract = taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    if (listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="acceptance-receipt")?.state !== "passed") throw new Error("docs maintenance requires an accepted writer receipt first");
    const settings = loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
    const docsAgent=boundedAgentName(settings["docs.agent"],"docs-maintainer");
    const docsChoice=docsSelection(settings);
    const docsProviderId=docsChoice.providerId;
    const docsModelId=docsChoice.model;
    const configuredDocsEffort=docsChoice.reasoningLevel;
    const docsServiceTier=docsChoice.serviceTier;
    const parsedSettings:Record<string,unknown> = Object.fromEntries(["docs.enabled","docs.maintain","docs.since","docs.page_cap","docs.hour","docs.agent"].map((key)=>[key,configuredSetting(settings,key)]));
    const docsSettings = parseDocsSettings(parsedSettings);
    const base = {runId:args.runId,taskId:args.taskId,stageId:"docs-maintenance" as const,input:JSON.stringify({taskId:args.taskId,settings:docsSettings,agent:docsAgent,providerId:docsProviderId,model:docsModelId,reasoningEffort:configuredDocsEffort,serviceTier:docsServiceTier})};
    const existing = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
    if (existing && !["pending","running"].includes(existing.state)) {
      return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"docs maintenance already has a receipt; create a new task for another run",stage:existing};
    }
    if (!existing) recordStage(db,{...base,state:"pending",providerId:docsProviderId,model:docsModelId});
    const claimed = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
    if (claimed?.state === "pending") {
      recordStage(db,{...base,state:"running",providerId:docsProviderId,model:docsModelId,threadId:claimed.threadId,result:claimed.result,reason:"docs_spawn_requested"});
    }
    let receipt = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
    const liveChild = Boolean(receipt?.threadId || docsChildSnapshot(receipt?.result));
    // Auto mode: a folder that is not a working codebase on this machine gets no docs after its tasks either.
    if (docsSettings.mode === "auto" && docsSettings.enabled && docsSettings.maintain && !liveChild) {
      const verdict = await services.docsVerdict(args.projectId, { hostId:config.hostId, path:run.writer_workspace_path! }).catch(() => null);
      if (verdict && !verdict.need) {
        const reason = `docs_not_needed:${verdict.reason}`;
        recordStage(db,{...base,state:"skipped",reason});
        return {runId:args.runId,taskId:args.taskId,state:"skipped",reason};
      }
    }
    if ((!docsSettings.enabled || !docsSettings.maintain) && !liveChild) {
      recordStage(db,{...base,state:"skipped",reason:!docsSettings.enabled?"disabled_by_project_setting":"docs_maintain_disabled"});
      return {runId:args.runId,taskId:args.taskId,state:"skipped",reason:!docsSettings.enabled?"disabled_by_project_setting":"docs_maintain_disabled"};
    }
    let threadId:string|null=receipt?.threadId??null;
    const changed:Array<{path:string;sha256:string}> = [];
    const observeMs=Math.min(240, Math.max(1, args.timeoutSec ?? 60)) * 1000;
    const persistRunning=(nextThreadId:string|null, result:unknown, reason?:string)=>{
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
      if (current && !["pending","running"].includes(current.state)) return current;
      recordStage(db,{...base,state:"running",providerId:docsProviderId,model:docsModelId,
        threadId:nextThreadId ?? current?.threadId ?? null,
        result:{...docsResultObject(current?.result),...docsResultObject(result)},reason});
      return undefined;
    };
    const finishObservation=async(childId:string, snapshot:DocsChildSnapshot|null):Promise<Record<string,unknown>>=>{
      const already=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
      if (already && !["pending","running"].includes(already.state)) {
        return {runId:args.runId,taskId:args.taskId,state:already.state,reason:"docs maintenance already has a receipt; create a new task for another run",stage:already};
      }
      const observed=await observeStageChild(bb,childId,observeMs);
      const latest=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
      if (latest && !["pending","running"].includes(latest.state)) {
        return {runId:args.runId,taskId:args.taskId,state:latest.state,reason:"docs maintenance already has a receipt; create a new task for another run",stage:latest};
      }
      const prior=docsResultObject(latest?.result ?? receipt?.result);
      if (observed.kind === "observing") {
        persistRunning(childId,{...prior,...(snapshot?{snapshot}:{}),observing:observed.detail});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:observed.detail};
      }
      if (observed.kind === "product_failure") {
        recordStage(db,{...base,state:"failed",providerId:docsProviderId,model:docsModelId,threadId:childId,reason:`${observed.via}:${observed.detail}`,result:{error:`${observed.via}:${observed.detail}`}});
        return {runId:args.runId,taskId:args.taskId,state:"failed",threadId:childId,reason:`${observed.via}:${observed.detail}`};
      }
      if (!snapshot) {
        persistRunning(childId,{...prior,observing:"docs_snapshot_missing"});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:"docs_snapshot_missing"};
      }
      const pageCap=resolveDocsSnapshotPageCap(snapshot, prior);
      if (pageCap === null) {
        persistRunning(childId,{...prior,snapshot,observing:"docs_snapshot_page_cap_missing"});
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:"docs_snapshot_page_cap_missing"};
      }
      const raw=(await bb.sdk.threads.output({threadId:childId})).output; if(typeof raw!=="string"||!raw.trim()) throw new Error("docs_maintainer_output_empty");
      let decoded:unknown; try { decoded=extractModelJson(raw,"array"); } catch { throw new Error("docs_maintainer_output_must_be_json_array"); }
      const edits=validateDocsEdits(decoded,snapshot.pages,pageCap);
      for (const edit of edits) {
        await bb.sdk.files.write({hostId:config.hostId,rootPath:task.project_cwd,path:`${task.project_cwd}/${edit.path}`,content:edit.content,contentEncoding:"utf8",createParents:false,expectedSha256:edit.expectedSha256});
        const readback=await bb.sdk.files.read({hostId:config.hostId,rootPath:task.project_cwd,path:`${task.project_cwd}/${edit.path}`});
        const afterContent=stringAt(readback,"content");
        if (afterContent !== edit.content) throw new Error(`docs_write_readback_mismatch:${edit.path}`);
        changed.push({path:edit.path,sha256:sha256(afterContent)});
      }
      const result={selected:snapshot.pages.length,changed,inputSha256:snapshot.inputSha256,since:snapshot.since,truncated:snapshot.truncated,threadId:childId,snapshot};
      recordStage(db,{...base,state:"passed",providerId:docsProviderId,model:docsModelId,threadId:childId,result});
      return {runId:args.runId,taskId:args.taskId,state:"passed",result};
    };
    try {
      receipt = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
      threadId = receipt?.threadId ?? null;
      let snapshot = docsChildSnapshot(receipt?.result);
      if (!threadId) {
        const recovered = await services.reconcileDocsChild(args.projectId, args.runId, args.taskId);
        if (recovered.kind === "found") {
          threadId = recovered.threadId;
          persistRunning(threadId, { ...docsResultObject(receipt?.result), ...(snapshot?{snapshot}:{}) });
          receipt = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
        } else if (recovered.kind !== "not_found") {
          persistRunning(null, { ...docsResultObject(receipt?.result), ...(snapshot?{snapshot}:{}), observing:recovered.kind });
          return {runId:args.runId,taskId:args.taskId,state:"running",reason:"observing",detail:recovered.kind};
        }
      }
      if (threadId) return await finishObservation(threadId, snapshot);
      if (!snapshot) {
        const inventory = await host.call("listDocsPages",{requestedHostId:config.hostId,projectCwd:task.project_cwd},{hostId:config.hostId,timeoutMs:60_000});
        if (inventory.hostId !== config.hostId) throw new Error("docs inventory came from a different host");
        receipt = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
        snapshot = docsChildSnapshot(receipt?.result);
        threadId = receipt?.threadId ?? null;
        if (threadId) return await finishObservation(threadId, snapshot);
        if (!snapshot) {
          const selected = selectDocsPages(inventory.pages as DocsPage[],docsSettings.since,docsSettings.pageCap);
          if (!selected.pages.length) {
            const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
            if (current && !["pending","running"].includes(current.state)) {
              return {runId:args.runId,taskId:args.taskId,state:current.state,reason:"docs maintenance already has a receipt; create a new task for another run",stage:current};
            }
            const result={selected:0,changed:[],inputSha256:docsInputHash([]),since:docsSettings.since,truncated:false};
            recordStage(db,{...base,state:"passed",result});
            return {runId:args.runId,taskId:args.taskId,state:"passed",result};
          }
          snapshot = { pages:selected.pages, since:docsSettings.since, truncated:selected.truncated, inputSha256:docsInputHash(selected.pages),
            pageCap:docsSettings.pageCap, dispatchInput:JSON.parse(base.input) };
          persistRunning(null, { snapshot }, "docs_spawn_requested");
          receipt = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
        }
      }
      const resolvedPageCap=resolveDocsSnapshotPageCap(snapshot, receipt?.result);
      if (resolvedPageCap === null) {
        persistRunning(threadId, { snapshot, observing:"docs_snapshot_page_cap_missing" });
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId,reason:"observing",detail:"docs_snapshot_page_cap_missing"};
      }
      if (!claimDocsSpawn(db, args.runId, args.taskId)) {
        receipt = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
        if (receipt?.threadId) return await finishObservation(receipt.threadId, snapshot);
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId:receipt?.threadId??null,reason:"observing",detail:"docs_spawn_claimed"};
      }
      const [providers,catalog] = await Promise.all([bb.sdk.providers.list({hostId:config.hostId}),bb.sdk.providers.models({providerId:docsProviderId,hostId:config.hostId})]);
      const provider=providers.find((item)=>item.id===docsProviderId&&item.available);
      const model=catalog.models.find((item)=>item.id===docsModelId||item.model===docsModelId);
      if (!provider||!model) throw new Error("docs_writer_provider_or_model_unavailable");
      const docsEffort=configuredDocsEffort??(model.supportedReasoningEfforts.some((item)=>item.reasoningEffort==="medium")?"medium":model.supportedReasoningEfforts[0]?.reasoningEffort);
      if (!docsEffort) throw new Error("docs_writer_model_has_no_supported_reasoning_effort");
      const tier=provider.capabilities.supportsServiceTier?bbServiceTier(docsServiceTier):null;
      if(tier&&!(provider.serviceTiers??[]).some((item)=>item.id===tier)) throw new Error(`docs_writer_service_tier_unsupported:${tier}`);
      const helperPolicy=requireHelperSpawn({bb,db,projectId:args.projectId,runId:args.runId});
      const placement=await helperChildPlacement({
        bb, db, projectId:args.projectId, runId:args.runId, role:"docs-maintainer",
      });
      const spawned=await fullAccessSpawn(bb, {...placement,...requiredPolicyField(bb, helperPolicy, docsProviderId, "docs-maintainer"),...writerExecutionSelection(docsProviderId,docsModelId,docsEffort,tier),prompt:docsMaintenancePrompt({since:docsSettings.since,pages:snapshot.pages,pageCap:resolvedPageCap,agent:docsAgent}),environment:workspaceExecutionEnvironment(config.hostId,workspace),pluginMetadata:{role:"docs-maintainer",lanePilotRunId:args.runId,lanePilotTaskId:args.taskId,stageId:"docs-maintenance",parentPmThreadId:args.threadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true}});
      threadId=stringAt(spawned,"id"); if(!threadId) throw new Error("docs_maintainer_thread_id_missing");
      persistRunning(threadId, { ...docsResultObject(receipt?.result), snapshot, spawnAttempted:true });
      receipt = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
      return await finishObservation(threadId, snapshot);
    } catch(cause) {
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
      if (current && !["pending","running"].includes(current.state)) {
        return {runId:args.runId,taskId:args.taskId,state:current.state,reason:"docs maintenance already has a receipt; create a new task for another run",stage:current};
      }
      const reason=cause instanceof Error?cause.message:String(cause);
      if (!threadId) {
        const recovered = await services.reconcileDocsChild(args.projectId, args.runId, args.taskId).catch(() => ({ kind:"error" as const, message:reason }));
        if (recovered.kind === "found") {
          persistRunning(recovered.threadId, { ...docsResultObject(receipt?.result), observing:reason });
          return {runId:args.runId,taskId:args.taskId,state:"running",threadId:recovered.threadId,reason:"observing",detail:reason};
        }
        persistRunning(null, { ...docsResultObject(receipt?.result), observing:reason }, "docs_spawn_unknown");
        return {runId:args.runId,taskId:args.taskId,state:"running",reason:"observing",detail:reason};
      }
      if (reason.includes("events_list_error") || reason.includes("host") || reason.includes("disconnect") || reason.includes("ECONN") || reason.includes("502")) {
        persistRunning(threadId, { ...docsResultObject(receipt?.result), observing:reason });
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId,reason:"observing",detail:reason};
      }
      const state=changed.length?"blocked":"failed";
      recordStage(db,{...base,state,providerId:docsProviderId,model:docsModelId,threadId,reason,result:{error:reason,changed,inputSha256:null}});
      return {runId:args.runId,taskId:args.taskId,state,reason,changed};
    }
  }

  return { runDocsMaintenance };
}
