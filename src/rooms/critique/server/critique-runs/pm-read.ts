import { countAttempts, listStageReceipts, openDatabase, resolveTaskFile, taskHomeOf } from "../../../storage";
import { roleSelection, sdkCriticCatalog } from "../../critic-pair";
import { bbServiceTier, listedServiceTier, resolveStageWriterSelection, writerExecutionSelection } from "@lane-pilot/models";
import { settingOff, settingOn } from "@lane-pilot/models";
import { buildExecutionPacket, packetSelectedLines, readFirstIo, repoReadRoot, sha256 } from "../../../tasks";
import { graphStepMetadata, setAsideOnStartFailure, zcodeBusyPeek } from "../../../platform/server";
import { configuredSetting } from "../../../contracts/server";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, resolveCodeCriticDefault, resolveQualityMode } from "../../../contracts/quality-mode";
import { helperChildPlacement, recordStage, requireHelperSpawn, requiredPolicyField } from "../../../runs/server";
import { fullAccessSpawn } from "../../../platform/server";
import { bestEffort, stringAt, orMiss, isNotFound } from "@lane-pilot/kit";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StageHelperSettings } from "../../../platform/server";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import { hostContract } from "../../../contracts";
import { parsePmReadResult, parsePmReadSettings, pmReadPacketPrompt } from "../../pm-read";
import { prepareCriticPacket, readCanonicalPlan } from "../critique-packet";

import { PacketInput, wfHasSucceededLinkedWorkflow } from "@lane-pilot/workflow-engine";
import { limitProbe, logLimitMove } from "./limit-probe";
import { readAnswer } from "./read-answer";

export async function runPmRead(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;stageHelperSettings:StageHelperSettings;taskId:string;pmThreadId:string;config:PrototypeConfig;task:TaskV2;/** The PM's plan: the scout reports what it leaves open against the code. */plan?:string;workflow?:{runId:string;stepKey:string;nodeId:string};
  /** The pipeline's execution-packet gate already built the same packet on this workspace: its sha and line count, so the scout does not read every source twice. */packetSha256?:string;selectedLines?:number})
  :Promise<{state:"skipped"|"passed"|"failed";summary:string;reason?:string}> {
  const settings=await input.stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  const parsedSettings=parsePmReadSettings(Object.fromEntries([
    "pm_read.enabled","pm_read.min_lines","pm_read.provider","pm_read.model","pm_read.reasoning_effort","pm_read.service_tier",
  ].map((key)=>[key,configuredSetting(settings,key)])));
  // The input is what was read and how, not which model read it: the model pick asks the provider catalog, and a summary of the
  // same read_first stays good. A receipt of other read_first (lane_pilot_update_task) is read again (2026-10-29 audit: it
  // returned the old summary without reading the new files).
  // The plan is part of the input since the scout reads it (2026-11-10): its open questions are about that plan, so an edited plan is read again.
  // A home task's cache key also names the manifest revision of PLAN.md: a new plan revision is a new input even when the
  // plan parameter text did not change. Legacy tasks keep the source bytes exactly as before.
  const planHome = taskHomeOf(input.db, input.taskId);
  const planManifestSha = input.plan?.trim() && planHome ? resolveTaskFile(input.db, input.taskId, "plan")?.sha256 ?? null : null;
  const source=JSON.stringify({taskId:input.taskId,readFirst:input.task.read_first,settings:parsedSettings,...(input.plan?.trim()?{planSha256:sha256(input.plan.trim())}:{}),...(planManifestSha?{planManifestSha256:planManifestSha}:{})});
  const base={runId:input.runId,taskId:input.taskId,stageId:"pm-read" as const,input:source,attempt:countAttempts(input.db,input.runId,input.taskId)};
  // The no-model skips are decided from settings alone (no host IO) so a disabled or critics-off stage never pays the
  // canonical plan read; only a runnable stage validates the plan before reusing a passed summary.
  const qualityMode = resolveQualityMode(input.task, settings[QUALITY_MODE_SETTING]);
  const reviewed = applyCodeCriticDefault(applyQualityMode(settings, qualityMode), qualityMode, input.task.risk, resolveCodeCriticDefault(settings[CODE_CRITIC_DEFAULT_SETTING]));
  const stageRunnable = parsedSettings.enabled && qualityMode !== "quick" && !(settingOff(reviewed["plan_critique.enabled"]) && !settingOn(reviewed["code_critique.enabled"]));
  const existing=listStageReceipts(input.db,input.runId,input.taskId).find((row)=>row.stageId==="pm-read");
  if(existing&&existing.inputSha256===sha256(source)) {
    // A passed summary is reused only while the canonical plan still verifies against its manifest hash: drift or an
    // unreadable PLAN.md is a named failure, never a stale scout report. The passed receipt stays for the fixed file.
    if(existing.state==="passed"&&stageRunnable&&planHome&&input.plan?.trim()) {
      try { await readCanonicalPlan(input.bb,input.db,{taskId:input.taskId,reader:"pm-read",legacyPlan:input.plan}); }
      catch(cause){ return {state:"failed",summary:"",reason:`pm_read_input_failed:${cause instanceof Error?cause.message:String(cause)}`}; }
    }
    const summary=stringAt(existing.result,"summary")??"";
    return {state:existing.state==="passed"?"passed":existing.state==="skipped"?"skipped":"failed",summary,...(existing.reason?{reason:existing.reason}:{})};
  }
  // A disabled stage is decided before the catalog is asked for a model it would not use.
  if(!parsedSettings.enabled) {
    recordStage(input.db,{...base,state:"pending",replaceOnNewInput:true,restart:true});
    recordStage(input.db,{...base,state:"skipped",reason:"disabled_by_project_setting"});
    return {state:"skipped",summary:""};
  }
  // The summary feeds the plan critic and the code critic. When both are off (a project switch, or quality_mode quick),
  // the read would call a model nobody uses. The graph still reaches this node before the quality-mode fork.
  if (settingOff(reviewed["plan_critique.enabled"]) && !settingOn(reviewed["code_critique.enabled"])) {
    recordStage(input.db,{...base,state:"pending",replaceOnNewInput:true,restart:true});
    recordStage(input.db,{...base,state:"skipped",reason:qualityMode === "quick" ? "quality_mode_quick" : "critics_disabled"});
    return {state:"skipped",summary:""};
  }
  if (qualityMode === "standard" && (input.task.risk === "low" || input.task.risk === "medium") && wfHasSucceededLinkedWorkflow(input.db, input.runId, "scout")) {
    recordStage(input.db,{...base,state:"pending",replaceOnNewInput:true,restart:true});
    recordStage(input.db,{...base,state:"skipped",reason:"scouted_before_plan"});
    return {state:"skipped",summary:""};
  }
  const fallback=resolveStageWriterSelection({settings,config:input.config});
  // One role table (packages/models/src/role-models.ts): the owner's row, else the pm_read selection, else the default; the old pick stands when the host lacks it.
  const picked=await roleSelection({zcodeBusy:zcodeBusyPeek(input.bb),catalog:sdkCriticCatalog(input.bb,input.config.hostId),settings,role:"pm-reader",fallback:{providerId:parsedSettings.provider??fallback.providerId,model:parsedSettings.model??fallback.model},spent:await limitProbe(input.bb,input.config.hostId,settings)});
  logLimitMove(input.bb,`pm read for ${input.taskId}`,picked.issues);
  const providerId=picked.providerId;
  const modelId=picked.model;
  parsedSettings.effort=picked.effort??parsedSettings.effort;
  recordStage(input.db,{...base,state:"pending",providerId,model:modelId,replaceOnNewInput:true,restart:true});
  let threadId:string|null=null;
  // Pending until read_first clears the size threshold: a small read_first is skipped, and skipped
  // is not reachable from running. The host reads the files only to count their lines; the scout opens them itself.
  recordStage(input.db,{...base,state:"pending",providerId,model:modelId});
  let started=false;
  try {
    // The pipeline gate (lp.execution-packet) already built this packet on the same workspace and passed its outcome;
    // only a direct caller without it pays the read here.
    let packetSha256=input.packetSha256;
    let selectedLines=input.selectedLines;
    const host=input.bb.hosts.experimental_client({contract:hostContract});
    const repoRootPath=(await repoReadRoot(host,input.config.hostId,input.task.project_cwd,input.task.read_first))?.root;
    if(packetSha256===undefined||selectedLines===undefined) {
      const packet=await buildExecutionPacket(input.task.read_first,readFirstIo(
        {files:input.bb.sdk.files,host},
        {hostId:input.config.hostId,rootPath:input.task.project_cwd,repoRootPath},
      ));
      packetSha256=packet.sha256;
      selectedLines=packetSelectedLines(packet);
    }
    if(selectedLines<parsedSettings.minLines) {
      const result={selectedLines,minLines:parsedSettings.minLines,packetSha256,summary:""};
      recordStage(input.db,{...base,state:"skipped",providerId,model:modelId,result,reason:"read_first_below_min_lines"});
      return {state:"skipped",summary:""};
    }
    recordStage(input.db,{...base,state:"running",providerId,model:modelId}); started=true;
    // The scout's input goes by reference like the critic's: the whole task contract and the canonical plan (the task
    // home's PLAN.md, hash-checked, or the legacy plan text) arrive inline when small or as a materialized,
    // hash-recorded file under .agents/runs/<run>/inputs/. A materialization failure is a named failure before any spawn.
    let prompt:string;
    try {
      const planText=input.plan?.trim()?(await readCanonicalPlan(input.bb,input.db,{taskId:input.taskId,reader:"pm-read",legacyPlan:input.plan})).text:null;
      const packetInputs:PacketInput[]=[
        {name:"task",value:input.task},
        ...(repoRootPath?[{name:"read_first_repository",value:{selector:"repo:",root:repoRootPath,access:"read-only"}}]:[]),
        ...(planText?[{name:"plan",value:planText}]:[]),
      ];
      const prepared=await prepareCriticPacket(input.bb,input.db,{
        runId:input.runId,projectId:input.projectId,hostId:input.config.hostId,checkoutPath:input.task.project_cwd,
        step:{id:"pm-read",role:"pm-reader",mode:qualityMode},
        goal:`PM read for task ${input.task.id}: ${input.task.title}`,inputs:packetInputs,readers:["pm-read"],
      });
      prompt=pmReadPacketPrompt({packet:prepared.packet});
    } catch(cause) {
      throw new Error(`pm_read_input_failed:${cause instanceof Error?cause.message:String(cause)}`);
    }
    const [providers,catalog]=await Promise.all([
      input.bb.sdk.providers.list({hostId:input.config.hostId}),
      input.bb.sdk.providers.models({providerId,hostId:input.config.hostId}),
    ]);
    const provider=providers.find((row)=>row.id===providerId&&row.available);
    const model=catalog.models.find((row)=>row.id===modelId||row.model===modelId);
    if(!provider||!model) throw new Error("pm_read_provider_or_model_unavailable");
    if(!model.supportedReasoningEfforts.some((row)=>row.reasoningEffort===parsedSettings.effort)) throw new Error(`pm_read_reasoning_effort_unsupported:${parsedSettings.effort}`);
    const serviceTier=listedServiceTier(provider, bbServiceTier(parsedSettings.serviceTier));
    if(serviceTier&&!(provider.serviceTiers??[]).some((row)=>row.id===serviceTier)) throw new Error(`pm_read_service_tier_unsupported:${serviceTier}`);
    const helperPolicy=requireHelperSpawn(input);
    const placement=await helperChildPlacement({
      bb:input.bb, db:input.db, projectId:input.projectId, runId:input.runId, role:"pm-reader", taskTitle:input.task.title,
    });
    const spawned=await fullAccessSpawn(input.bb, {
      ...placement,
      ...requiredPolicyField(input.bb, helperPolicy, providerId, "pm-reader"),
      ...writerExecutionSelection(providerId,modelId,parsedSettings.effort,serviceTier),
      prompt,
      environment:{type:"host",hostId:input.config.hostId,workspace:{type:"unmanaged",path:input.task.project_cwd}},
      pluginMetadata:{role:"pm-reader",lanePilotRunId:input.runId,lanePilotTaskId:input.taskId,stageId:"pm-read",parentPmThreadId:input.pmThreadId,helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true,...graphStepMetadata(input.workflow)}});
    threadId=stringAt(spawned,"id");
    if(!threadId) throw new Error("pm_read_thread_id_missing");
    recordStage(input.db,{...base,state:"running",providerId,model:modelId,threadId});
    await waitThreadIdle(input.bb,threadId,"pm_read_timeout");
    const output=(await input.bb.sdk.threads.output({threadId})).output;
    if(typeof output!=="string"||!output.trim()) throw new Error("pm_read_output_empty");
    const parsed=await readAnswer(input.bb,threadId,output,parsePmReadResult,"summary, keyFacts and openQuestions","pm_read_timeout");
    const summary=JSON.stringify(parsed);
    const result={...parsed,selectedLines,minLines:parsedSettings.minLines,packetSha256};
    recordStage(input.db,{...base,state:"passed",providerId,model:modelId,threadId,result});
    return {state:"passed",summary};
  } catch(cause) {
    const reason=cause instanceof Error?cause.message:String(cause);
    if(threadId) {
      const thread=await orMiss(input.bb.sdk.threads.get({threadId}), null, isNotFound);
      if(["active","starting"].includes(stringAt(thread,"status")??"")) await bestEffort(input.bb.log, "critique thread stop", input.bb.sdk.threads.stop({ threadId }), undefined);
    }
    setAsideOnStartFailure(input.bb,`pm read for ${input.taskId}`,providerId,modelId,reason);
    if(!started) recordStage(input.db,{...base,state:"running",providerId,model:modelId});
    recordStage(input.db,{...base,state:"failed",providerId,model:modelId,threadId,reason,result:{error:reason}});
    return {state:"failed",summary:"",reason};
  }
}
