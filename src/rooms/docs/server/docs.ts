import { taskV2Schema } from "../../contracts";
import type { StageHelperSettings } from "../../platform/server";
import { claimDocsSpawn, getRun, getTask, listStageReceipts } from "../../storage";
import { bbServiceTier, listedServiceTier, writerExecutionSelection } from "@lane-pilot/models";
import { sha256 } from "../../tasks";
import { extractModelJson } from "@lane-pilot/workflow-engine";
import { docsInputHash, docsMaintenancePrompt, docsReviewPrompt, docsSelection, DOCS_NEW_PAGE, parseDocsSettings, selectDocsPages, validateDocsEdits } from "../docs";
import type { DocsPage } from "../../contracts/docs-page";
import type { HelperRole } from "../../contracts";
import { boundedAgentName } from "../../contracts/review-vocabulary";
import { DocsChildSnapshot, docsChildSnapshot, docsResultObject, resolveDocsSnapshotPageCap } from "../../runs/server";
import { modelCatalogOf, resolveSpawnModel, spawnUsageOf, warmSpawnUsage } from "../../platform/server";
import { configuredSetting } from "../../contracts/server";
import { documentaryGateOf, fullAccessSpawn, graphStepMetadata } from "../../platform/server";
import { isDocumentaryRole } from "../../contracts";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { recordStage } from "../../runs/server";
import { bestEffort, stringAt, valueAt } from "@lane-pilot/kit";
import { observeStageChild } from "@lane-pilot/thread-observe";
import { postOwnerItem } from "../../owner-waiting";
import type { ServerCore } from "../../contracts/server";

import type { DocsNightlyApi } from "./docs-nightly";
import type { StageChildrenPort } from "../../contracts/stage-children-api";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  stageHelperSettings: StageHelperSettings;
  docsVerdict: DocsNightlyApi["docsVerdict"];
  reconcileDocsChild: StageChildrenPort["reconcileDocsChild"];
}


export function createDocsStage(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, host, workspaceExecutionEnvironment } = ctx;

  async function runDocsMaintenance(args:{threadId:string;projectId:string;runId:string;taskId:string;timeoutSec?:number;workflow?:{runId:string;stepKey?:string;nodeId?:string};
    /** The owner's assignment (SMA k_ag_docwriter): a document to create or update, runs even when no page changed. */
    assignment?:string}):Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if (valueAt(metadata,"role") !== "pm" || stringAt(metadata,"lanePilotRunId") !== args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run = getRun(db,args.runId), config = await configForRun(args.projectId, run), taskRow = getTask(db,args.taskId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId || !config || !taskRow || taskRow.run_id !== args.runId || taskRow.kind !== "bb") throw new Error("task does not belong to this PM run and project");
    const taskContract = taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    if (listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="acceptance-receipt")?.state !== "passed") throw new Error("docs maintenance requires an accepted writer receipt first");
    const settings = await services.stageHelperSettings(bb,db,args.projectId,args.runId);
    const docsAgent=boundedAgentName(settings["docs.agent"],"docs-maintainer");
    const spawnUsage=spawnUsageOf(ctx);
    await warmSpawnUsage(spawnUsage,config.hostId);
    // The documentary gate (SMA ap_caps): an adapter version with no documentary receipt is out of the offer, so the
      // pick is the stage's next provider; when none is proved the spawn below refuses and the stage stays held.
      const docProved=await bestEffort(ctx.log,"docs capability gate",Promise.resolve().then(()=>documentaryGateOf(bb)?.proved(args.projectId)),undefined);
      const docsRole=resolveSpawnModel({role:"docs-maintainer",settings,catalog:modelCatalogOf(ctx).peek(), usage: spawnUsage,hostId:config.hostId,...(docProved?{capability:{proved:(providerId:string)=>docProved.has(providerId)}}:{})});
    const docsChoice=docsSelection(settings,docsRole);
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
    // A pass that is not needed ends before the stage opens: running -> skipped is not a legal move. A receipt a crashed pass left
    // running with no child ends canceled for the same reason (the hourly schedule tripped on it for every project after the first).
    if (!(existing?.threadId || docsChildSnapshot(existing?.result))) {
      let skipReason:string|null = null;
      // Auto mode: a folder that is not a working codebase on this machine gets no docs after its tasks either.
      if (docsSettings.mode === "auto" && docsSettings.enabled && docsSettings.maintain) {
        const verdict = await bestEffort(ctx.log, `docs verdict ${args.projectId}`, services.docsVerdict(args.projectId, { hostId:config.hostId, path:run.writer_workspace_path! }), null);
        if (verdict && !verdict.need) skipReason = `docs_not_needed:${verdict.reason}`;
      }
      if (!skipReason && (!docsSettings.enabled || !docsSettings.maintain)) skipReason = !docsSettings.enabled?"disabled_by_project_setting":"docs_maintain_disabled";
      if (skipReason) {
        const state = existing?.state === "running" ? "canceled" as const : "skipped" as const;
        recordStage(db,{...base,state,reason:skipReason});
        return {runId:args.runId,taskId:args.taskId,state,reason:skipReason};
      }
    }
    if (!existing) recordStage(db,{...base,state:"pending",providerId:docsProviderId,model:docsModelId});
    const claimed = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
    if (claimed?.state === "pending") {
      recordStage(db,{...base,state:"running",providerId:docsProviderId,model:docsModelId,threadId:claimed.threadId,result:claimed.result,reason:"docs_spawn_requested"});
    }
    let receipt = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
    let threadId:string|null=receipt?.threadId??null;
    const changed:Array<{path:string;sha256:string}> = [];
    const observeMs=Math.min(240, Math.max(1, args.timeoutSec ?? 60)) * 1000;
    /** One helper child of the docs stage (the author and, for the stage gate, the reviewer — separate roles by id). */
    const spawnDocsChild=async(role:HelperRole,prompt:string):Promise<string>=>{
      const [providers,catalog] = await Promise.all([bb.sdk.providers.list({hostId:config.hostId}),bb.sdk.providers.models({providerId:docsProviderId,hostId:config.hostId})]);
      const provider=providers.find((item)=>item.id===docsProviderId&&item.available);
      const model=catalog.models.find((item)=>item.id===docsModelId||item.model===docsModelId);
      if(!provider||!model) throw new Error("docs_writer_provider_or_model_unavailable");
      const effort=configuredDocsEffort??(model.supportedReasoningEfforts.some((item)=>item.reasoningEffort==="medium")?"medium":model.supportedReasoningEfforts[0]?.reasoningEffort);
      if(!effort) throw new Error("docs_writer_model_has_no_supported_reasoning_effort");
      const tier=listedServiceTier(provider, bbServiceTier(docsServiceTier));
      if(tier&&!(provider.serviceTiers??[]).some((item)=>item.id===tier)) throw new Error(`docs_writer_service_tier_unsupported:${tier}`);
      const helperPolicy=requireHelperSpawn({bb,db,projectId:args.projectId,runId:args.runId});
      const placement=await helperChildPlacement({bb,db,projectId:args.projectId,runId:args.runId,role});
      const spawned=await fullAccessSpawn(bb,{...placement,...requiredPolicyField(bb,helperPolicy,docsProviderId,role),...writerExecutionSelection(docsProviderId,docsModelId,effort,tier),prompt,environment:workspaceExecutionEnvironment(config.hostId,workspace),pluginMetadata:{role,lanePilotRunId:args.runId,lanePilotTaskId:args.taskId,stageId:"docs-maintenance",parentPmThreadId:args.threadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true,...graphStepMetadata(args.workflow)}});
      const id=stringAt(spawned,"id"); if(!id) throw new Error(`${role}_thread_id_missing`);
      return id;
    };
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
      const edits=validateDocsEdits(decoded,snapshot.pages,pageCap,{newPages:Boolean(args.assignment?.trim())});
      // The document stage gate (SMA ag_doc_gate): a second role reads the edits before a page is written. The author's
      // own thread can never be the reviewer; the pages are written and committed only on the review's pass. Gate by
      // default; docs.review=off writes without a review. A refusal sends the notes back to the maintainer once (the
      // rework round the receipt keeps as `rework.round`); a second refusal leaves an owner item and fails the pass.
      let reviewed:{threadId?:string;role?:string;verdict:string}|null=null;
      if (String(settings["docs.review"]??"gate")==="gate"&&edits.length) {
        const priorReview=(docsResultObject(prior).review ?? null) as {threadId?:string;role?:string}|null;
        if (priorReview?.threadId === childId) {
          recordStage(db,{...base,state:"failed",providerId:docsProviderId,model:docsModelId,threadId:childId,
            reason:"docs_review_same_role",result:{...prior,error:"docs review refused: the reviewer is the author's own thread"}});
          return {runId:args.runId,taskId:args.taskId,state:"failed",reason:"docs_review_same_role"};
        }
        if (!priorReview?.threadId) {
          const reviewRole="auditor";
          const reviewThreadId=await spawnDocsChild(reviewRole,docsReviewPrompt(snapshot.pages,edits));
          persistRunning(childId,{...prior,review:{threadId:reviewThreadId,role:reviewRole}});
          return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:"docs_review"};
        }
        const reviewObserved=await observeStageChild(bb,priorReview.threadId,observeMs);
        if (reviewObserved.kind === "observing") {
          persistRunning(childId,{...prior,observing:"docs_review"});
          return {runId:args.runId,taskId:args.taskId,state:"running",threadId:childId,reason:"observing",detail:"docs_review"};
        }
        if (reviewObserved.kind === "product_failure") {
          recordStage(db,{...base,state:"failed",providerId:docsProviderId,model:docsModelId,threadId:childId,reason:`${reviewObserved.via}:${reviewObserved.detail}`,result:{error:`${reviewObserved.via}:${reviewObserved.detail}`}});
          return {runId:args.runId,taskId:args.taskId,state:"failed",reason:`${reviewObserved.via}:${reviewObserved.detail}`};
        }
        const reviewRaw=(await bb.sdk.threads.output({threadId:priorReview.threadId})).output;
        let verdict:"pass"|"changes"="changes"; let notes="";
        try { const parsed=extractModelJson(String(reviewRaw),"object") as {verdict?:unknown;notes?:unknown}; verdict=parsed.verdict==="pass"?"pass":"changes"; notes=String(parsed.notes??"").slice(0,1000); } catch { /* an unreadable verdict asks for changes */ }
        if (verdict!=="pass") {
          const reworkRound=(docsResultObject(prior).rework as {round?:number}|undefined)?.round ?? 0;
          if (reworkRound<1) {
            // One rework round: the notes go back to the maintainer as a fresh author child; its edits are reviewed again.
            const reworkId=await spawnDocsChild("docs-maintainer",docsMaintenancePrompt({since:docsSettings.since,pages:snapshot.pages,pageCap,agent:docsAgent,assignment:args.assignment,reviewNotes:notes||"the review asked for changes"}));
            persistRunning(reworkId,{...prior,review:{verdict,notes},rework:{round:reworkRound+1}},`docs_review_refused: rework round ${reworkRound+1}`);
            return {runId:args.runId,taskId:args.taskId,state:"running",threadId:reworkId,reason:"observing",detail:"docs_review_rework"};
          }
          const reason=`docs_review_refused${notes?`:${notes}`:""}`;
          postOwnerItem(db,{key:`docs_review_refused:${args.runId}:${args.taskId}`,source:"docs",kind:"docs_review",projectId:args.projectId,wake:false,
            what:"Проверка документов отклонила правки второй раз — задача ждёт решения.",
            why:`Ревьюер документов не пропустил правки после одного круга доработки${notes?`: ${notes.slice(0,300)}`:"."}`,
            evidence:[{kind:"run",ref:args.runId,label:"docs-maintenance"}]});
          recordStage(db,{...base,state:"failed",providerId:docsProviderId,model:docsModelId,threadId:childId,reason,result:{...prior,review:{...priorReview,verdict},error:"the docs review asked for changes"}});
          return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
        }
        reviewed={...priorReview,verdict};
      }
      for (const edit of edits) {
        await bb.sdk.files.write({hostId:config.hostId,rootPath:task.project_cwd,path:`${task.project_cwd}/${edit.path}`,content:edit.content,contentEncoding:"utf8",createParents:true,expectedSha256:edit.expectedSha256===DOCS_NEW_PAGE?null:edit.expectedSha256});
        const readback=await bb.sdk.files.read({hostId:config.hostId,rootPath:task.project_cwd,path:`${task.project_cwd}/${edit.path}`});
        const afterContent=stringAt(readback,"content");
        if (afterContent !== edit.content) throw new Error(`docs_write_readback_mismatch:${edit.path}`);
        changed.push({path:edit.path,sha256:sha256(afterContent)});
      }
      // A reviewed pass is committed (SMA ag_doc_gate) and its receipt names both roles and the commit. A folder without
      // git, or edits that changed nothing, have no commit to name: that is said in the receipt, it does not fail the pass.
      const committed=reviewed?await bestEffort(ctx.log,"docs commit",host.call("gitCommitDocs",{requestedHostId:config.hostId,projectCwd:task.project_cwd,paths:edits.map((edit)=>edit.path),message:`docs: maintenance of ${args.taskId}`},{hostId:config.hostId,timeoutMs:60_000}),null):null;
      const result={selected:snapshot.pages.length,changed,inputSha256:snapshot.inputSha256,since:snapshot.since,truncated:snapshot.truncated,threadId:childId,
        ...(reviewed?{commit:stringAt(committed,"commit")??null,commitStatus:stringAt(committed,"status")??"failed",roles:{author:"docs-maintainer",reviewer:reviewed.role??"auditor"},review:reviewed}:{}),snapshot};
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
          // An owner's assignment (SMA k_ag_docwriter) runs even when no page made the selection: the maintainer
          // updates or creates the page it names.
          if (!selected.pages.length && !args.assignment?.trim()) {
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
      threadId=await spawnDocsChild("docs-maintainer",docsMaintenancePrompt({since:docsSettings.since,pages:snapshot.pages,pageCap:resolvedPageCap,agent:docsAgent,assignment:args.assignment}));
      persistRunning(threadId, { ...docsResultObject(receipt?.result), snapshot, spawnAttempted:true });
      receipt = listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
      return await finishObservation(threadId, snapshot);
    } catch(cause) {
      const current=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="docs-maintenance");
      if (current && !["pending","running"].includes(current.state)) {
        return {runId:args.runId,taskId:args.taskId,state:current.state,reason:"docs maintenance already has a receipt; create a new task for another run",stage:current};
      }
      const reason=cause instanceof Error?cause.message:String(cause);
      // Held, not failed: an adapter with no documentary receipt starts nothing (SMA ap_caps_held). The stage stays
      // running with the reason named, uncharged, and the next hourly pass asks the table again.
      if (reason.startsWith("capability_unproven:")) {
        persistRunning(threadId, { ...docsResultObject(receipt?.result), observing:reason }, reason);
        return {runId:args.runId,taskId:args.taskId,state:"running",threadId,reason:"observing",detail:reason};
      }
      if (!threadId) {
        const recovered = await bestEffort(ctx.log, `docs child reconcile ${args.taskId}`, services.reconcileDocsChild(args.projectId, args.runId, args.taskId), { kind:"error" as const, message:reason });
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

export type DocsStageApi = ReturnType<typeof createDocsStage>;
