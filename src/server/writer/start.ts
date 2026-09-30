import type { DirtSnapshot } from "../../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { countAttempts, createAttempt, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, listStageReceipts, loadProjectSettings, transitionAttempt } from "../../database";
import { reconcile } from "../../reconcile";
import { emergencyFallbackDecision, sameWriterSelection } from "../../stages/emergency-writer";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../../state-machine";
import type { AttemptState } from "../../state-machine";
import { parseWorkspaceMode } from "../../workspace/routing";
import { recordStage } from "../stage-records";
import { id, stringAt } from "../values";
import { resolve } from "node:path";
import type { ServerCore } from "../core";
import type { Services } from "../services";

export function createWriterStart(ctx: ServerCore, services: Services) {
  const { bb, db, effectiveProjectSettings, host, markCanceledWriterStages, refreshRun, runPolicyFor } = ctx;

  function startWriterTask(input:{
    projectId:string; runId:string; taskId:string; firstAttemptId:string; pmThreadId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; writerThreadId?:string; dirtBefore?:DirtSnapshot[]; pmReadContext?:string;
  }): void {
    const key = `${input.runId}:${input.taskId}`;
    if (services.activeWriterTasks.has(key)) return;
    services.activeWriterTasks.add(key);
    let attemptId = input.firstAttemptId;
    let writerThreadId = input.writerThreadId;
    let writerSelection:{providerId:string;model:string;reasoningLevel?:string;serviceTier?:"default"|"fast"|null;selectionSource?:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"}}|undefined;
    const existingTrace=getReasoningTrace(db,attemptId);
    if(existingTrace) writerSelection={
      providerId:existingTrace.providerId, model:existingTrace.model,
      reasoningLevel:existingTrace.effectiveReasoningLevel, serviceTier:existingTrace.serviceTier,
      selectionSource:existingTrace.selectionSource,
    };
    let activeTask = input.task;
    let dirtBefore = input.dirtBefore ?? [];
    let baselineDirtBefore:DirtSnapshot[]|null=input.dirtBefore?[...input.dirtBefore]:null;
    let baselineWorkspacePath:string|null=input.dirtBefore?input.task.project_cwd:null;
    let executionPacketSha256:string|null = null;
    let last: Record<string, unknown> = {};
    let primaryFailure:Record<string,unknown>|null=null;
    const pmReadContext=input.pmReadContext ?? stringAt(listStageReceipts(db,input.runId,input.taskId).find((row)=>row.stageId==="pm-read")?.result,"summary") ?? "";
    let releaseWriterSlot:(()=>void)|undefined;
    void (async () => {
      const policy=runPolicyFor(input.runId);
      // "In the project folder" shares one checkout: writers there go one at a time, whatever the pool says,
      // because a parallel writer's half-done edits would land in this writer's diff and checks.
      const inPlace=parseWorkspaceMode((await effectiveProjectSettings(input.projectId,getRunSettingsScopes(db,input.runId))).values["adoc.040"])==="in_place";
      releaseWriterSlot=await services.runWriterPool.acquire(input.runId,inPlace?1:policy.pools.provider);
      const latestAttempt=getAttempt(db,attemptId);
      if(!latestAttempt||["canceled","blocked","accepted"].includes(latestAttempt.state)){
        if(latestAttempt?.state==="canceled"){
          markCanceledWriterStages(latestAttempt,"writer attempt canceled while waiting for provider pool");
          refreshRun(input.runId);
        }
        return;
      }
      recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"running",
        input:input.plan, attempt:countAttempts(db, input.runId, input.taskId) });
      while (countAttempts(db, input.runId, input.taskId) <= MAIN_ATTEMPT_LIMIT) {
        if (!writerThreadId) {
          const spawned = await services.spawnWriterAttempt({
            projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId,
            config:input.config, task:input.task, plan:input.plan, pmThreadId:input.pmThreadId, pmReadContext,
            retryIndex:Math.max(0,countAttempts(db,input.runId,input.taskId)-1),
          });
          if (!spawned.ok) {
            last = { status:spawned.status, reason:spawned.reason, attemptId:spawned.attemptId };
          } else {
            writerThreadId = spawned.threadId;
            writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
            activeTask = {...input.task,project_cwd:spawned.workspacePath,
              verification:input.task.verification.map(command=>({...command,cwd:spawned.workspacePath}))};
            dirtBefore = spawned.dirtBefore;
            baselineDirtBefore ??=[...spawned.dirtBefore];
            baselineWorkspacePath ??=spawned.workspacePath;
            executionPacketSha256 = spawned.executionPacketSha256 ?? null;
          }
        }
        if (writerThreadId) {
          last = { ...await services.finishWriterAttempt({
            projectId:input.projectId, config:input.config, task:activeTask, runId:input.runId,
            taskId:input.taskId, attemptId, pmThreadId:input.pmThreadId, writerThreadId, dirtBefore,
          }), ...(executionPacketSha256 ? { executionPacketSha256 } : {}) };
          const workspaceBinding=getAttempt(db,attemptId);
          if(workspaceBinding?.workspace_path) last={...last,workspace:{path:workspaceBinding.workspace_path,
            environmentId:workspaceBinding.environment_id,decision:workspaceBinding.workspace_decision}};
        }
        if (last.status === "accepted") break;
        // A failed attempt's own worktree is never merged; the next attempt starts from a fresh one.
        const failedBinding=getAttempt(db,attemptId);
        const failedBase=getRun(db,input.runId)?.writer_workspace_path;
        if(failedBinding?.workspace_path&&failedBinding.environment_id===null&&failedBase&&resolve(failedBinding.workspace_path)!==resolve(failedBase)) {
          await host.call("gitRemoveWorktree",{requestedHostId:input.config.hostId,basePath:failedBase,worktreePath:failedBinding.workspace_path},
            {hostId:input.config.hostId,timeoutMs:60_000}).catch((cause)=>bb.log.warn(`Lane Pilot could not remove worktree of ${attemptId}: ${cause instanceof Error?cause.message:String(cause)}`));
        }
        if (last.status === "spawn_rejected" && typeof last.reason === "string"
          && (last.reason.startsWith("execution_packet_failed:") || last.reason.startsWith("attempt_worktree_")
            || last.reason.startsWith("attempt_workspace_"))) {
          const rejected = getAttempt(db, attemptId);
          if (rejected?.state === "spawn_rejected") transitionAttempt(db, attemptId, "blocked", { reason:last.reason });
          last = { ...last, status:"blocked" };
          break;
        }
        if (last.status !== "accepted" && last.status !== "blocked") primaryFailure={...last};
        const failed = String(last.status) as AttemptState;
        if (!RETRY_ELIGIBLE.includes(failed)) break;
        const attempt = getAttempt(db, attemptId);
        if (attempt?.state === "spawn_unknown" || attempt?.state === "spawn_requested") {
          writerThreadId = await services.reconcileAttemptThread(input.projectId, attempt).catch(() => "");
        } else if (attempt) {
          const scanned = await reconcile({
            list: async ({ limit, offset }) => (await bb.sdk.threads.list({
              projectId:input.projectId, originPluginId:"lane-pilot", includeHidden:true, limit, offset,
            })).map((thread) => ({ id:thread.id })),
            metadata: async (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
          }, { lanePilotRunId:attempt.run_id, lanePilotTaskId:attempt.task_id, attemptId:attempt.id });
          if (scanned.kind === "blocked" || scanned.kind === "error") {
            if (scanned.kind === "blocked") transitionAttempt(db, attempt.id, "blocked", { reason:`reconcile_${scanned.reason}` });
            last = { ...last, status:"blocked", reason:scanned.kind === "blocked" ? scanned.reason : scanned.message };
            break;
          }
        }
        if (countAttempts(db, input.runId, input.taskId) >= MAIN_ATTEMPT_LIMIT) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) {
            const exhausted = `retry limit 2 exhausted${typeof last.reason === "string" && last.reason ? `: ${last.reason}` : ""}`;
            transitionAttempt(db, latest.id, "blocked", { reason:exhausted });
            last = { ...last, status:"blocked", reason:exhausted };
          }
          break;
        }
        attemptId = id("lpattempt");
        createAttempt(db, { id:attemptId, runId:input.runId, taskId:input.taskId });
        writerThreadId = undefined;
        writerSelection=undefined;
        activeTask = input.task;
        dirtBefore = [];
        executionPacketSha256 = null;
      }
      if (last.status !== "accepted" && primaryFailure) {
        const decision=emergencyFallbackDecision({
          state:String(primaryFailure.status ?? "unknown"),
          reason:typeof primaryFailure.reason === "string" ? primaryFailure.reason : null,
          stopConfirmed:primaryFailure.stopConfirmed === true,
        });
        if (decision.run) {
          const settings=loadProjectSettings(db,input.projectId,getRunSettingsScopes(db,input.runId));
          const primaryProvider=typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : input.config.writerProviderId;
          const primaryModel=typeof settings["writer.model"] === "string" && settings["writer.model"] ? settings["writer.model"] as string : input.config.writerModel;
          const emergencySelection={providerId:input.config.pmProviderId,model:input.config.pmModel};
          if (sameWriterSelection({providerId:primaryProvider,model:primaryModel},emergencySelection)) {
            last={...last,emergencyFallback:{state:"skipped",reason:"configured_pm_selection_matches_primary",trigger:decision.reason}};
          } else {
            const primaryAttemptId=typeof primaryFailure.attemptId === "string" ? primaryFailure.attemptId : attemptId;
            const emergencyAttemptId=id("lpattempt");
            createAttempt(db,{id:emergencyAttemptId,runId:input.runId,taskId:input.taskId});
            writerSelection=undefined;
            const spawned=await services.spawnWriterAttempt({
              projectId:input.projectId,runId:input.runId,taskId:input.taskId,attemptId:emergencyAttemptId,
              config:input.config,task:input.task,plan:input.plan,pmThreadId:input.pmThreadId,pmReadContext,
              emergency:{...emergencySelection,reason:decision.reason},
            });
            if (!spawned.ok) {
              const fallbackFailureReason=`emergency_fallback_failed:${spawned.reason}`;
              transitionAttempt(db,emergencyAttemptId,"blocked",{reason:fallbackFailureReason});
              last={status:"blocked",reason:fallbackFailureReason,attemptId:emergencyAttemptId,
                emergencyFallback:{state:"failed",reason:spawned.reason,trigger:decision.reason,attemptId:emergencyAttemptId}};
              writerThreadId=undefined;
            } else {
              writerThreadId=spawned.threadId;
              writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
              activeTask={...input.task,project_cwd:spawned.workspacePath,
                verification:input.task.verification.map(command=>({...command,cwd:spawned.workspacePath}))};
              executionPacketSha256=spawned.executionPacketSha256 ?? null;
              const fallbackWorkspace=getAttempt(db,emergencyAttemptId)?.workspace_path;
              dirtBefore=baselineWorkspacePath&&fallbackWorkspace===baselineWorkspacePath
                ? baselineDirtBefore??spawned.dirtBefore : spawned.dirtBefore;
              const emergencyFallback={reason:decision.reason,primaryAttemptId,providerId:emergencySelection.providerId,model:emergencySelection.model};
              last={...await services.finishWriterAttempt({
                projectId:input.projectId,config:input.config,task:activeTask,runId:input.runId,taskId:input.taskId,
                attemptId:emergencyAttemptId,pmThreadId:input.pmThreadId,writerThreadId,dirtBefore,
                emergencyFallback,
              }),emergencyFallback:{state:"completed",...emergencyFallback,attemptId:emergencyAttemptId}};
              const workspaceBinding=getAttempt(db,emergencyAttemptId);
              if(workspaceBinding?.workspace_path) last={...last,workspace:{path:workspaceBinding.workspace_path,
                environmentId:workspaceBinding.environment_id,decision:workspaceBinding.workspace_decision}};
            }
          }
        }
      }
      const accepted = last.status === "accepted";
      const reason = accepted ? undefined : String(last.reason ?? last.status ?? "writer_failed");
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
        if (current?.state === "pending") {
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
        }
        const terminal = accepted ? "passed" : last.status === "canceled" ? "canceled" : "failed";
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:terminal,
          input:input.plan, attempt:Math.min(countAttempts(db, input.runId, input.taskId),MAIN_ATTEMPT_LIMIT),
          providerId:stageId==="writer-agent"?writerSelection?.providerId:undefined,
          model:stageId==="writer-agent"?writerSelection?.model:undefined,threadId:writerThreadId,
          result:stageId === "writer-agent" ? {
            ...last,
            execution: writerSelection ? {
              providerId:writerSelection.providerId,
              model:writerSelection.model,
              reasoningLevel:writerSelection.reasoningLevel ?? null,
              serviceTier:writerSelection.serviceTier ?? null,
              selectionSource:writerSelection.selectionSource ?? null,
            } : last,
          } : accepted ? stageId === "verification"
            ? { produced:last.produced, verification:last.verification, runV2:last.runV2 }
            : last : null, reason:accepted ? undefined : reason });
      }
      refreshRun(input.runId);
      if (accepted) services.maintainMemoryAfterAcceptance(input.projectId, input.runId, input.taskId, input.pmThreadId);
      if (accepted) services.maintainProjectLifeAfterAcceptance(input.projectId, input.runId, input.taskId, input.pmThreadId);
    })().catch((cause: unknown) => {
      // After a reload the database is closed: stop quietly, the next load reconciles the attempt.
      if (ctx.state.disposed) return;
      try {
        const message = cause instanceof Error ? cause.message : String(cause);
        const reason = `internal_error: ${message}`;
        bb.log.error(`Lane Pilot writer attempt ${attemptId} failed: ${message}`);
        const attempt = getAttempt(db, attemptId);
        if(attempt?.state==="canceled"){
          markCanceledWriterStages(attempt,"writer attempt canceled before provider dispatch");
          refreshRun(input.runId);
          return;
        }
        if (attempt && ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested", "provider_error", "timeout", "empty_output", "validation_failed"].includes(attempt.state)) {
          transitionAttempt(db, attemptId, "blocked", { threadId:writerThreadId, reason });
        }
        for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
          const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
          if (!current || current.state === "passed" || current.state === "failed" || current.state === "skipped") continue;
          if (current.state === "pending") recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId,
            state:"failed", input:input.plan,
            attempt:Math.min(countAttempts(db, input.runId, input.taskId),MAIN_ATTEMPT_LIMIT),
            providerId:stageId==="writer-agent"?writerSelection?.providerId:undefined,
            model:stageId==="writer-agent"?writerSelection?.model:undefined,threadId:writerThreadId, reason });
        }
        try {
          refreshRun(input.runId);
        } catch (refreshCause) {
          bb.log.error(`Lane Pilot failed to refresh run ${input.runId} after attempt ${attemptId} error: ${refreshCause instanceof Error ? refreshCause.message : String(refreshCause)}`);
        }
      } catch (inner) {
        // A failure while recording the failure must never escape a detached task and crash BB.
        try { bb.log.error(`Lane Pilot writer attempt ${attemptId} could not record its failure: ${inner instanceof Error ? inner.message : String(inner)}`); } catch { /* ctx.state.disposed */ }
      }
    }).finally(() => {
      releaseWriterSlot?.();
      services.activeWriterTasks.delete(key);
    });
  }

  return { startWriterTask };
}
