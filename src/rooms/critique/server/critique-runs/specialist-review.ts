import { getRun, listStageReceipts, openDatabase } from "../../../storage";
import { roleSelection, sdkCriticCatalog } from "../../critic-pair";
import { bbServiceTier, findModelIn, listedServiceTier, resolveStageWriterSelection, writerExecutionSelection } from "@lane-pilot/models";
import { sha256 } from "../../../tasks";
import { parseSpecialistResult, shouldRunSpecialist, specialistPrompt, unreadableAnswer } from "../../specialist";
import { boundedAgentName } from "../../../contracts";
import { graphStepMetadata, setAsideOnStartFailure, zcodeBusyPeek } from "../../../platform/server";
import type { StageHelperSettings } from "../../../platform/server";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import { helperChildPlacement, recordStage, requireHelperSpawn, requiredPolicyField } from "../../../runs/server";
import { critiqueSpawn } from "../critique-runs";
import { bestEffort, stringAt, orMiss, isNotFound } from "@lane-pilot/kit";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { limitProbe, logLimitMove } from "./limit-probe";
import { verdictReasons } from "./verdict-reasons";
import { readAnswer } from "./read-answer";



export async function runSpecialistReview(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;stageHelperSettings:StageHelperSettings;taskId:string;config:PrototypeConfig;task:TaskV2;plan:string;workflow?:{runId:string;stepKey:string;nodeId:string};/** Set on the one rerun after the first pick's thread would not start. */afterStartFailure?:boolean})
  : Promise<{allowed:boolean;reason?:string;review?:unknown}> {
  const settings = await input.stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  const policy = shouldRunSpecialist({enabled:settings["specialist.enabled"],when:settings["specialist.when"],risk:input.task.risk});
  const agent=boundedAgentName(settings["specialist.agent"],"specialist-reviewer");
  const source = `${input.plan}\n\n${JSON.stringify(input.task)}\n\nagent=${agent}`;
  const base = {runId:input.runId,taskId:input.taskId,stageId:"specialist-review" as const,input:source};
  const kept = listStageReceipts(input.db,input.runId,input.taskId).find((row) => row.stageId === "specialist-review");
  if (kept?.state === "passed" && kept.inputSha256 === sha256(source)) return {allowed:true,review:kept.result};
  // An updated task goes through its review again over the receipt of the earlier contract (lane_pilot_update_task).
  // The rerun after a thread that would not start opens the stage it just recorded failed.
  recordStage(input.db,{...base,state:"pending",replaceOnNewInput:true,restart:true,reopen:input.afterStartFailure});
  if (!policy.run) {
    const failedPolicy = policy.reason?.startsWith("invalid_") || policy.reason?.startsWith("unsupported_");
    recordStage(input.db,{...base,state:failedPolicy ? "blocked" : "skipped",reason:policy.reason ?? undefined});
    return failedPolicy ? {allowed:false,reason:policy.reason ?? "specialist_policy_invalid"} : {allowed:true};
  }

  const legacy=resolveStageWriterSelection({settings,config:input.config,stageProviderKey:"specialist.provider",stageModelKey:"specialist.model"});
  const selection=await roleSelection({zcodeBusy:zcodeBusyPeek(input.bb),catalog:sdkCriticCatalog(input.bb,input.config.hostId),settings,role:"specialist-reviewer",fallback:{providerId:legacy.providerId,model:legacy.model},spent:await limitProbe(input.bb,input.config.hostId,settings)});
  logLimitMove(input.bb,`specialist review for ${input.taskId}`,selection.issues);
  const providerId=selection.providerId;
  const modelId=selection.model;
  const effort = selection.effort ?? (typeof settings["specialist.reasoning_effort"] === "string" && settings["specialist.reasoning_effort"]
    ? settings["specialist.reasoning_effort"] as string : "high");
  const savedTier = settings["specialist.service_tier"];
  const serviceTier = savedTier === "fast" ? "fast" : "standard";
  let threadId:string|null = null;
  recordStage(input.db,{...base,state:"running",providerId,model:modelId});
  try {
    const [providers,catalog] = await Promise.all([
      input.bb.sdk.providers.list({hostId:input.config.hostId}),
      input.bb.sdk.providers.models({providerId,hostId:input.config.hostId}),
    ]);
    const provider = providers.find((row) => row.id === providerId && row.available);
    const model = findModelIn(catalog.models, modelId);
    if (!provider || !model) throw new Error("specialist_provider_or_model_unavailable");
    if (!model.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) {
      throw new Error(`specialist_reasoning_effort_unsupported:${effort}`);
    }
    const tier = listedServiceTier(provider, bbServiceTier(serviceTier));
    if (tier && !(provider.serviceTiers ?? []).some((item) => item.id === tier)) throw new Error(`specialist_service_tier_unsupported:${tier}`);
    const helperPolicy=requireHelperSpawn(input);
    // An answer that does not read (magicseo T3.2, 2026-10-30: Gemini answered the rubric items {id,result,evidence} and no
    // status) is asked for again in the same thread (readAnswer); a second unreadable answer passes the task as the code
    // critic's failed_infra does, rather than blocking it on the reviewer's form. The receipt says the review did not run.
    const placement = await helperChildPlacement({
      bb:input.bb, db:input.db, projectId:input.projectId, runId:input.runId, role:"specialist-reviewer", taskTitle:input.task.title,
    });
    const spawned = await critiqueSpawn(input.bb, {
      ...placement,
      ...requiredPolicyField(input.bb, helperPolicy, providerId, "specialist-reviewer"),
      ...writerExecutionSelection(providerId,modelId,effort,tier),
      prompt:specialistPrompt({task:input.task,plan:input.plan,agent}),
      environment:{type:"host",hostId:input.config.hostId,workspace:{type:"unmanaged",path:input.task.project_cwd}},
      pluginMetadata:{role:"specialist-reviewer",lanePilotRunId:input.runId,lanePilotTaskId:input.taskId,
        stageId:"specialist-review",parentPmThreadId:getRun(input.db,input.runId)?.pm_thread_id ?? null,
        helperMode:helperPolicy.mode,helperRequired:helperPolicy.policy?.required===true,...graphStepMetadata(input.workflow)},
    });
    threadId = stringAt(spawned,"id");
    if (!threadId) throw new Error("specialist_thread_id_missing");
    recordStage(input.db,{...base,state:"running",providerId,model:modelId,threadId});
    await waitThreadIdle(input.bb,threadId,"specialist_thread_timeout");
    const raw = (await input.bb.sdk.threads.output({threadId})).output;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("specialist_output_empty");
    let review;
    try {
      // Like the plan critic it may cite a file it opened, which the hub cannot see: file, line and quoted evidence are still required.
      review = await readAnswer(input.bb, threadId, raw, (text) => parseSpecialistResult(text), "status, summary, findings and evidence", "specialist_thread_timeout");
    } catch (cause) {
      if (!unreadableAnswer(cause)) throw cause;
      const reason = `failed_infra:specialist answer unreadable twice: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 600)}`;
      recordStage(input.db,{...base,state:"failed",providerId,model:modelId,threadId,reason,result:{error:reason}});
      return {allowed:true,reason};
    }
    const blocked = review.decision === "block";
    const why = verdictReasons(review, "specialist-review");
    recordStage(input.db,{...base,state:blocked ? "blocked" : "passed",providerId,model:modelId,threadId,
      result:{...review,rawOutput:raw.slice(0,12_000)},reason:blocked ? why.receipt : undefined});
    return blocked ? {allowed:false,reason:why.returned,review} : {allowed:true,review};
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (threadId) {
      const thread = await orMiss(input.bb.sdk.threads.get({threadId}), null, isNotFound);
      if (stringAt(thread,"status") === "active" || stringAt(thread,"status") === "starting") {
        await bestEffort(input.bb.log, "critique thread stop", input.bb.sdk.threads.stop({ threadId }), undefined);
      }
    }
    recordStage(input.db,{...base,state:"failed",providerId,model:modelId,threadId,reason,result:{error:reason}});
    // The provider is broken, not the plan: one more run, which picks the peer now that this pair is set aside.
    if (setAsideOnStartFailure(input.bb,`specialist review for ${input.taskId}`,providerId,modelId,reason) && !input.afterStartFailure) return runSpecialistReview({...input,afterStartFailure:true});
    return {allowed:false,reason:`specialist_review_failed:${reason}`};
  }
}
