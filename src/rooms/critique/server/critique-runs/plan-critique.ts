import { unownedExpectedOutputs } from "../../../tasks";
import { hostContract, taskV2Schema } from "../../../contracts";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import { getRun, getTask, getTaskPlan, listLiveTasksForRun, listOpenAttempts, listStageReceipts, openDatabase } from "../../../storage";
import { criticPairCandidates, roleSelection, sdkCriticCatalog, usable } from "../../critic-pair";
import { bbServiceTier, findModelIn, listedServiceTier, resolveStageWriterSelection, writerExecutionSelection, writerServiceTier } from "@lane-pilot/models";
import { settingOff } from "@lane-pilot/models";
import { sha256 } from "../../../tasks";
import { critiquePrompt, parseCritique, shouldRunPlanCritique } from "../../critique";
import { planCriticTier } from "../../critic-level";
import { ownerWordsOfRun } from "../owner-words";
import { binaryOutputs, dropIntendedGaps, dropNoisyGaps, findTaskPlaceholderPaths } from "../../critique-coverage";
import type { CoverageCallers, CoverageFinding } from "../../critique-coverage";
import { inlinePlanFile } from "./plan-text";
import { boundedAgentName } from "../../../contracts";
import { graphStepMetadata, setAsideOnStartFailure, zcodeBusyPeek } from "../../../platform/server";
import type { StageHelperSettings } from "../../../platform/server";
import { QUALITY_MODE_SETTING, applyQualityMode, resolveQualityMode } from "../../../contracts";
import { helperChildPlacement, recordStage, requireHelperSpawn, requiredPolicyField } from "../../../runs/server";
import { fullAccessSpawn } from "../../../platform/server";
import { bestEffort, stringAt, orMiss, isNotFound } from "@lane-pilot/kit";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { limitProbe, logLimitMove } from "./limit-probe";
import { verdictReasons } from "./verdict-reasons";
import { dependencyFindings } from "./dependency-findings";
import { readAnswer } from "./read-answer";

export async function runPlanCritique(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;stageHelperSettings:StageHelperSettings;taskId:string;config:PrototypeConfig;task:TaskV2;plan:string;pmReadContext?:string;workflow?:{runId:string;stepKey:string;nodeId:string}})
  : Promise<{allowed:boolean;reason?:string;critique?:unknown}> {
  const projectSettings = await input.stageHelperSettings(input.bb,input.db,input.projectId,input.runId);
  // quality_mode (task, else project, else standard) decides whether this task goes through the plan critique at all.
  const qualityMode = resolveQualityMode(input.task,projectSettings[QUALITY_MODE_SETTING]);
  const settings = applyQualityMode(projectSettings,qualityMode);
  const agent = boundedAgentName(settings["plan_critique.agent"],"plan-critic");
  // quick and a disabled critique are decided first: the model pick asks the provider catalog and the coverage scan takes up
  // to 30 s, both for a critic that will not run (2026-10-29 audit).
  const disabled = settingOff(settings["plan_critique.enabled"]);
  if (qualityMode === "quick" || disabled) {
    const skip = { runId:input.runId, taskId:input.taskId, stageId:"plan-critique" as const, input:`${input.plan}\n\n${JSON.stringify(input.task)}\n\nagent=${agent}\n\npm_read=${input.pmReadContext ?? ""}` };
    recordStage(input.db, { ...skip, state:"pending", replaceOnNewInput:true, restart:true });
    recordStage(input.db, qualityMode === "quick" ? { ...skip, state:"skipped", reason:"quality_mode_quick", result:{ qualityMode } } : { ...skip, state:"skipped", reason:"disabled_by_project_setting" });
    return { allowed:true };
  }
  const legacy=resolveStageWriterSelection({settings,config:input.config,stageProviderKey:"plan_critique.provider",stageModelKey:"plan_critique.model"});
  // The strong critic judges high and critical risk, quality_mode full and a task that changes files outside its section (repo_scope); every other task goes to the light row (hub, 30 days to 2026-11-14:
  // serious defects in 10 of 13 returns at high/critical risk, 4 of 25 below it). The tier is kept in the receipt (critic_tier).
  const criticTier=planCriticTier(input.task,qualityMode).tier;
  const selection=await roleSelection({zcodeBusy:zcodeBusyPeek(input.bb),catalog:sdkCriticCatalog(input.bb,input.config.hostId),settings,role:criticTier==="strong"?"plan-critic":"plan-critic-light",fallback:{providerId:legacy.providerId,model:legacy.model},spent:await limitProbe(input.bb,input.config.hostId,settings)});
  logLimitMove(input.bb,`plan critic for ${input.taskId}`,selection.issues);
  let providerId=selection.providerId;
  let modelId=selection.model;
  const mode = settings["plan_critique.mode"] === "advisory" ? "advisory" : "gate";
  const runTasks = listLiveTasksForRun(input.db,input.runId).map((row) => ({id:row.id,...row.contract as {lane?:string;owns_paths?:string[];verify?:TaskV2["verify"];verification?:TaskV2["verification"]}}));
  let coverageStatus:"complete"|"truncated"|"unavailable"="unavailable";
  let coveragePathCount=0;
  let coverageCallers:CoverageCallers[]|undefined;
  let structuralFindings:CoverageFinding[]=runTasks.flatMap((task)=>findTaskPlaceholderPaths(task).map((path)=>({code:"task_placeholder" as const,path:`tasks/${task.id}/${path}`,
    severity:"error" as const,finding:`Task ${task.id} contains unresolved REPLACE_ME at ${path}`}))).slice(0,10);
  // An expected file the task may not write fails every attempt (SelfyStudio 2026-10-03): caught here, before a writer runs.
  const unownedOutputs=unownedExpectedOutputs(input.task);
  const openTasks:Array<{id:string;depends_on:string[]}>=[];
  for(const row of listOpenAttempts(input.db)) {
    if(row.project_id!==input.projectId||row.task_id===input.task.id||openTasks.some((open)=>open.id===row.task_id))continue;
    const parsed=taskV2Schema.safeParse(getTask(input.db,row.task_id)?.contract);
    if(parsed.success)openTasks.push({id:row.task_id,depends_on:parsed.data.depends_on});
  }
  const planFindings:CoverageFinding[]=[...dependencyFindings(input.task,openTasks),
    ...binaryOutputs(input.task.expected_outputs).slice(0,3).map((entry)=>({code:"output_binary" as const,path:`tasks/${input.task.id}/expected_outputs`,severity:"warning" as const,
      finding:`Task ${input.task.id} expects ${entry}, a binary file a model cannot author; say in the plan where it is copied from (a package, a URL, an existing file) or drop it from expected_outputs`}))];
  structuralFindings=[...planFindings.filter((finding)=>finding.severity==="error"),...unownedOutputs.slice(0,5).map((entry)=>({code:"output_unowned" as const,path:`tasks/${input.task.id}/expected_outputs`,severity:"error" as const,
    finding:`Task ${input.task.id} expects ${entry}, which is outside its owns_paths: the writer may not create it, so no attempt can pass`})),...structuralFindings,...planFindings.filter((finding)=>finding.severity!=="error")].slice(0,10);
  try {
    const coverageHost=input.bb.hosts.experimental_client({contract:hostContract});
    const scan=await coverageHost.call("inspectCritiqueCoverage",{requestedHostId:input.config.hostId,workspacePath:input.task.project_cwd,
      plan:input.plan,tasks:runTasks.map((task)=>({id:task.id,lane:task.lane??"write",ownsPaths:task.owns_paths??[],hasVerification:task.verify==="none"||!!task.verification?.length,
        verification:(task.verification??[]).map((command)=>({command:command.command,timeoutSec:command.timeout_sec??undefined}))}))},{hostId:input.config.hostId,timeoutMs:30_000});
    coverageStatus=scan.status;coveragePathCount=scan.pathCount;coverageCallers=scan.callers;// A bad command of a task already running must not block an unrelated dispatch of the run.
    structuralFindings=[...structuralFindings,...dropNoisyGaps(dropIntendedGaps(scan.findings,input.task.never_touch??[])).map((finding)=>finding.code==="verify_filter_ignored"&&finding.path!==`tasks/${input.task.id}`?{...finding,severity:"warning" as const}:finding)].slice(0,10);
  } catch {
    coverageStatus="unavailable";
  }
  if(coverageStatus==="truncated"&&!structuralFindings.some((finding)=>finding.code==="coverage_scan_truncated")) structuralFindings.push({code:"coverage_scan_truncated",path:".",severity:"info",finding:"Workspace path listing reached its file bound; ownership coverage is partial"});
  if(coverageStatus==="unavailable") structuralFindings.push({code:"coverage_scan_truncated",path:".",severity:"warning",finding:"Workspace path listing is unavailable; only plan/TaskV2 data was reviewed"});
  // The owner's own words feed the prompt and the input hash: a critique of the same plan without them is not reused.
  const ownerWords = await ownerWordsOfRun({ bb: input.bb, db: input.db, runId: input.runId, taskId: input.taskId });
  // A plan that is just the path of a file under the project is read here: the critic gets the text, the receipt the sha256 of the version it judged.
  const planFile = await inlinePlanFile(input.bb,{hostId:input.config.hostId,projectCwd:input.task.project_cwd,plan:input.plan});
  const source = `${input.plan}\n\n${JSON.stringify(input.task)}\n\nagent=${agent}\n\npm_read=${input.pmReadContext ?? ""}\n\nstructural_coverage=${coverageStatus}\n\nstructural_findings=${JSON.stringify(structuralFindings)}\n\nowner_words=${JSON.stringify(ownerWords)}${planFile?`\n\nplan_file_sha256=${planFile.sha256}`:""}`;
  const base = { runId:input.runId, taskId:input.taskId, stageId:"plan-critique" as const, input:source };
  // A resumed dispatch keeps a critique that passed on this very input (resetHelperStages): it is not bought twice.
  const kept = listStageReceipts(input.db,input.runId,input.taskId).find((row) => row.stageId === "plan-critique");
  const structuralBlock=mode==="gate"&&structuralFindings.some((finding)=>finding.severity==="error");
  if (kept?.state === "passed" && kept.inputSha256 === sha256(source)) {
    // A structural error blocks under a gate whatever was kept: the same input without the receipt blocks too (SMA audit R-06).
    if (structuralBlock) return { allowed:false, reason:"structural_plan_critique_blocked", critique:{ structuralFindings } };
    // An advisory «changes requested» is kept as passed; read under a gate it blocks as a fresh one would (SMA audit N-06). The
    // receipt stays: passed cannot turn back, and the same input blocks the same way until the task changes.
    const keptResult = kept.result as { decision?: string } | null;
    if (mode === "gate" && keptResult?.decision === "changes_requested") {
      const why = verdictReasons(keptResult as never, "plan-critique");
      return { allowed:false, reason:why.returned, critique:kept.result };
    }
    return { allowed:true, critique:kept.result };
  }
  // An updated task runs its critique again over the receipt of the earlier contract (lane_pilot_update_task).
  recordStage(input.db, { ...base, state:"pending", replaceOnNewInput:true, restart:true });
  if(structuralBlock) {
    recordStage(input.db,{...base,state:"blocked",reason:"structural_plan_critique_blocked",result:{decision:"changes_requested",mode,
      structuralCoverage:{status:coverageStatus,pathCount:coveragePathCount},structuralFindings}});
    return {allowed:false,reason:"structural_plan_critique_blocked",critique:{structuralFindings}};
  }
  // «Three write tasks» means a plan of three tasks, not a chat's history: a PM chat is one run for days, and counting every
  // task still at work made 28 of the 41 plan critiques of the owner's prototype chat run on low-risk one-page fixes
  // (thr_zwif89vbnb, 2026-11-02). The batch is the live tasks that share this task's plan text.
  // ponytail: a plan edited between two dispatches of one batch splits the count; a batch id on dispatch would be exact.
  const planTasks = runTasks.filter((task) => task.id === input.taskId || getTaskPlan(input.db, task.id) === input.plan);
  let policy:ReturnType<typeof shouldRunPlanCritique>;
  try {
    policy = shouldRunPlanCritique({
      taskRisk:input.task.risk,
      tasks:planTasks,
      minScore:settings["plan_critique.min_score"],
      minWriteTasks:settings["plan_critique.min_write_tasks"],
      onHighRisk:settings["plan_critique.on_high_risk"],
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    recordStage(input.db,{...base,state:"failed",reason,result:{error:reason,policy:"task-risk-v1"}});
    return {allowed:false,reason:`plan_critique_policy_invalid:${reason}`};
  }
  // A task that also changes a shared part of the repository (an SDK the other bots use) is never below the threshold.
  if (!policy.run && input.task.repo_scope !== true) {
    recordStage(input.db,{...base,state:"skipped",reason:"below_critique_threshold",result:{
      policy:"task-risk-v1",score:policy.score,writeTaskCount:policy.writeTaskCount,decision:policy.reason,
      taskRisk:input.task.risk,structuralCoverage:{status:coverageStatus,pathCount:coveragePathCount},structuralFindings,
    }});
    return {allowed:true,reason:"plan_critique_threshold_not_met"};
  }
  recordStage(input.db, { ...base, state:"running", providerId, model:modelId });
  let threadId:string|null = null;
  try {
    const savedTier = settings["plan_critique.service_tier"];
    const tier = savedTier === "fast" || savedTier === "standard" ? savedTier : writerServiceTier(settings);
    const configuredEffort = selection.effort ?? (typeof settings["plan_critique.reasoning_effort"] === "string"
      ? settings["plan_critique.reasoning_effort"] as string
      : typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : "medium");
    // A critic that never settles or cannot be read is its failure, not the task's: the role's next usable pair takes
    // over; a spent pool marks the stage failed_infra and the task goes on (hub 2026-10-30: critique_thread_timeout ×4).
    const pairs: { providerId:string; model:string }[] = [{ providerId, model: modelId }];
    const criticCatalog = sdkCriticCatalog(input.bb, input.config.hostId);
    for (const candidate of criticPairCandidates(settings, input.config)) {
      if (pairs.length >= 3) break;
      if (pairs.some((pair) => pair.providerId === candidate.providerId && pair.model === candidate.model)) continue;
      try { if (await usable(criticCatalog, candidate, configuredEffort, tier)) pairs.push(candidate); } catch { /* unusable pairs are skipped */ }
    }
    let lastError: string | null = null;
    for (const [round, pair] of pairs.entries()) {
      providerId = pair.providerId; modelId = pair.model;
      try {
        const [providers, catalog] = await Promise.all([
          input.bb.sdk.providers.list({ hostId:input.config.hostId }),
          input.bb.sdk.providers.models({ providerId, hostId:input.config.hostId }),
        ]);
        const provider = providers.find((row) => row.id === providerId && row.available);
        const model = findModelIn(catalog.models, modelId);
        if (!provider || !model) throw new Error("critique_provider_or_model_unavailable");
        const levels = model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
        if (!new Set<string>(levels).has(configuredEffort)) throw new Error(`critique_reasoning_effort_unsupported:${configuredEffort}`);
        const serviceTier = listedServiceTier(provider, bbServiceTier(tier));
        if (serviceTier && !(provider.serviceTiers ?? []).some((item) => item.id === serviceTier)) {
          throw new Error(`critique_service_tier_unsupported:${serviceTier}`);
        }
        const helperPolicy=requireHelperSpawn(input);
        const placement = await helperChildPlacement({
          bb:input.bb, db:input.db, projectId:input.projectId, runId:input.runId, role:"plan-critic", taskTitle:input.task.title,
        });
        const spawned = await fullAccessSpawn(input.bb, {
          ...placement,
          ...requiredPolicyField(input.bb, helperPolicy, providerId, "plan-critic"),
          ...writerExecutionSelection(providerId, modelId, configuredEffort, serviceTier),
          prompt:critiquePrompt({ plan:input.plan, task:input.task, agent, pmReadContext:input.pmReadContext, structuralFindings, ownerWords, ...(planFile?{planText:planFile.inlined}:{}), ...(coverageCallers?{callers:coverageCallers}:{}) }),
          environment:{ type:"host", hostId:input.config.hostId,
            workspace:{ type:"unmanaged", path:input.task.project_cwd } },
          pluginMetadata:{ role:"plan-critic", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId,
            stageId:"plan-critique", parentPmThreadId:getRun(input.db, input.runId)?.pm_thread_id ?? null,
            helperMode:helperPolicy.mode, helperRequired:helperPolicy.policy?.required===true, ...graphStepMetadata(input.workflow) },
        });
        threadId = stringAt(spawned, "id");
        if (!threadId) throw new Error("critique_thread_id_missing");
        recordStage(input.db, { ...base, state:"running", providerId, model:modelId, threadId });
        await waitThreadIdle(input.bb,threadId,"critique_thread_timeout");
        const raw = (await input.bb.sdk.threads.output({ threadId })).output;
        if (typeof raw !== "string" || !raw.trim()) throw new Error("critique_output_empty");
        // ponytail: the critic reads the checkout itself, so a file it cites may be one it opened; the hub cannot see the host's files to check
        // the path, so only file, line and quoted evidence are required (settleVerdict). A host-side path check if invented paths show up.
        const critique = await readAnswer(input.bb, threadId, raw, parseCritique, "status, summary, findings and evidence");
        const blocked = critique.decision === "changes_requested" && mode === "gate";
        const result = { ...critique, mode, critic_tier:criticTier, ...(planCriticTier(input.task,qualityMode).reason==="repo_scope"?{critic_tier_reason:"repo_scope"}:{}), ...(planFile?{plan_sha256:planFile.sha256}:{}), ...(qualityMode !== "standard" ? { qualityMode } : {}), structuralCoverage:{status:coverageStatus,pathCount:coveragePathCount}, structuralFindings, rawOutput:raw.slice(0, 12_000) };
        const why = verdictReasons(critique, "plan-critique");
        recordStage(input.db, { ...base, state:blocked ? "blocked" : "passed", providerId, model:modelId,
          threadId, result, reason:blocked ? why.receipt : undefined });
        return blocked ? { allowed:false, reason:why.returned, critique:result } : { allowed:true, critique:result };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (threadId) {
          const thread = await orMiss(input.bb.sdk.threads.get({ threadId }), null, isNotFound);
          if (stringAt(thread, "status") === "active" || stringAt(thread, "status") === "starting") {
            await bestEffort(input.bb.log, "critique thread stop", input.bb.sdk.threads.stop({ threadId }), undefined);
          }
        }
        threadId = null;
        // Only a critic that could not answer retries: a dead or empty thread. A verdict the task disagrees with, a
        // malformed form the model keeps sending and a host refusal are the caller's problem, not the critic's pool.
        // An answer still unreadable after the one re-ask (readAnswer) fails closed here: no writer has started yet, so a plan
        // nobody reviewed waits for the PM instead of going on.
        const retryable = /critique_thread_timeout|critique_output_empty/.test(message);
        if (!retryable) throw cause;
        lastError = message;
      }
    }
    const infraReason = `failed_infra:${lastError ?? "critic pool exhausted"}`;
    recordStage(input.db, { ...base, state:"failed", providerId, model:modelId, reason:infraReason, result:{ error:infraReason, criticPairs:pairs, critic_tier:criticTier } });
    return { allowed:true, reason:infraReason };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (threadId) {
      const thread = await orMiss(input.bb.sdk.threads.get({ threadId }), null, isNotFound);
      if (stringAt(thread, "status") === "active" || stringAt(thread, "status") === "starting") {
        await bestEffort(input.bb.log, "critique thread stop", input.bb.sdk.threads.stop({ threadId }), undefined);
      }
    }
    setAsideOnStartFailure(input.bb, `plan critique for ${input.taskId}`, providerId, modelId, reason);
    recordStage(input.db, { ...base, state:"failed", providerId, model:modelId, threadId, reason,
      result:{ error:reason } });
    return { allowed:false, reason:`plan_critique_failed:${reason}` };
  }
}
