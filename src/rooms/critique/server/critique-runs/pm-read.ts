import { countAttempts, listStageReceipts, openDatabase } from "../../../storage";
import { roleSelection, sdkCriticCatalog } from "../../critic-pair";
import { bbServiceTier, listedServiceTier, resolveStageWriterSelection, writerExecutionSelection } from "@lane-pilot/models";
import { settingOff, settingOn } from "@lane-pilot/models";
import { sha256 } from "../../../tasks";
import { graphStepMetadata, setAsideOnStartFailure, zcodeBusyPeek } from "../../../platform/server";
import { configuredSetting } from "../../../contracts/server";
import { CODE_CRITIC_DEFAULT_SETTING, QUALITY_MODE_SETTING, applyCodeCriticDefault, applyQualityMode, resolveCodeCriticDefault, resolveQualityMode } from "../../../contracts/quality-mode";
import { MAIN_ATTEMPT_LIMIT } from "../../../contracts/state-machine";
import { helperChildPlacement, recordStage, requireHelperSpawn, requiredPolicyField } from "../../../runs/server";
import { fullAccessSpawn } from "../../../platform/server";
import { bestEffort, stringAt, orMiss, isNotFound } from "@lane-pilot/kit";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StageHelperSettings } from "../../../platform/server";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { resolve } from "node:path";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import { buildExecutionPacket } from "../../../tasks/execution-packet";
import { parsePmReadResult, parsePmReadSettings, pmReadPrompt } from "../../pm-read";
import { limitProbe, logLimitMove } from "./limit-probe";
import { readAnswer } from "./read-answer";

export async function runPmRead(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;stageHelperSettings:StageHelperSettings;taskId:string;pmThreadId:string;config:PrototypeConfig;task:TaskV2;/** The PM's plan: the scout reports what it leaves open against the code. */plan?:string;workflow?:{runId:string;stepKey:string;nodeId:string}})
  :Promise<{state:"skipped"|"passed"|"failed";summary:string;reason?:string}> {
  const settings=await input.stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  const parsedSettings=parsePmReadSettings(Object.fromEntries([
    "pm_read.enabled","pm_read.min_lines","pm_read.provider","pm_read.model","pm_read.reasoning_effort","pm_read.service_tier",
  ].map((key)=>[key,configuredSetting(settings,key)])));
  // The input is what was read and how, not which model read it: the model pick asks the provider catalog, and a summary of the
  // same read_first stays good. A receipt of other read_first (lane_pilot_update_task) is read again (2026-10-29 audit: it
  // returned the old summary without reading the new files).
  // The plan is part of the input since the scout reads it (2026-11-10): its open questions are about that plan, so an edited plan is read again.
  const source=JSON.stringify({taskId:input.taskId,readFirst:input.task.read_first,settings:parsedSettings,...(input.plan?.trim()?{planSha256:sha256(input.plan.trim())}:{})});
  const base={runId:input.runId,taskId:input.taskId,stageId:"pm-read" as const,input:source,attempt:Math.min(countAttempts(input.db,input.runId,input.taskId),MAIN_ATTEMPT_LIMIT)};
  const existing=listStageReceipts(input.db,input.runId,input.taskId).find((row)=>row.stageId==="pm-read");
  if(existing&&existing.inputSha256===sha256(source)) {
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
  const qualityMode = resolveQualityMode(input.task, settings[QUALITY_MODE_SETTING]);
  const reviewed = applyCodeCriticDefault(applyQualityMode(settings, qualityMode), qualityMode, input.task.risk, resolveCodeCriticDefault(settings[CODE_CRITIC_DEFAULT_SETTING]));
  if (settingOff(reviewed["plan_critique.enabled"]) && !settingOn(reviewed["code_critique.enabled"])) {
    recordStage(input.db,{...base,state:"pending",replaceOnNewInput:true,restart:true});
    recordStage(input.db,{...base,state:"skipped",reason:qualityMode === "quick" ? "quality_mode_quick" : "critics_disabled"});
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
    const packet=await buildExecutionPacket(input.task.read_first,async(path)=>{
      const file=await input.bb.sdk.files.read({hostId:input.config.hostId,rootPath:input.task.project_cwd,path:resolve(input.task.project_cwd, path)});
      if(typeof file.content!=="string") return null;
      return {content:file.content,contentEncoding:file.contentEncoding,sha256:file.sha256,sizeBytes:file.sizeBytes};
    });
    const selectedLines=packet.entries.reduce((total,entry)=>total+entry.windows.reduce((sum,window)=>sum+window.excerpt.split(/\r?\n/).length,0),0);
    if(selectedLines<parsedSettings.minLines) {
      const result={selectedLines,minLines:parsedSettings.minLines,packetSha256:packet.sha256,summary:""};
      recordStage(input.db,{...base,state:"skipped",providerId,model:modelId,result,reason:"read_first_below_min_lines"});
      return {state:"skipped",summary:""};
    }
    recordStage(input.db,{...base,state:"running",providerId,model:modelId}); started=true;
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
      prompt:pmReadPrompt({task:input.task,plan:input.plan}),
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
    const result={...parsed,selectedLines,minLines:parsedSettings.minLines,packetSha256:packet.sha256};
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
