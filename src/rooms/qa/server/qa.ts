import { taskV2Schema } from "../../contracts";
import { claimStageSpawn, countAttempts, recordSecretIssuance, getRun, getRunSettingsScopes, getTask, listStageReceipts, loadProjectSettings } from "../../storage/database";
import { QA_HOST_KEY, QA_WORKSPACE_KEY, qaCodexPreflight, qaHostUnreachableReason, resolveBrowserQaTarget, resolveStaleBrowserQaReceipt } from "../qa-host";
import { sha256 } from "../../tasks/contract";
import { parseOpenCodeToolTelemetry } from "../../stability/opencode-telemetry";
import { MAIN_ATTEMPT_LIMIT } from "../../runs/state-machine";
import { configuredSetting } from "../../core/server/context";
import { freezeRunRouting, inheritedProjectSettings } from "../../runs/server/run-routing";
import { recordStage } from "../../runs/server/stage-records";
import { qaStateToStatus } from "../../critique/verdict";
import { allowedSecretNames, secretFixLines, secretProblem, waitingSecretReason } from "../../secrets/server/secrets";
import { awaitQaVerdict, parseQaCases, runQaThread } from "./qa-thread";
import { stringAt, valueAt } from "../../core/server/values";
import type { ServerCore } from "../../core/server/core";

export function createQaStages(ctx: ServerCore) {
  const { acceptedTaskWorkspace, bb, configForRun, db, host } = ctx;

  async function runBrowserQa(args:{threadId:string;projectId:string;runId:string;taskId:string;url:string;cases:string[];envClass:"local"|"staging"|"preview"|"production"|"unknown";viewports:string;authorized:boolean;devServer?:string})
    : Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata,"role") !== "pm" || stringAt(metadata,"lanePilotRunId") !== args.runId) {
      throw new Error("runId does not belong to this Lane Pilot PM thread");
    }
    const run = getRun(db,args.runId);
    // Native runs (most projects) have no prototype config; reading it made every browser check fail as «not this run».
    const config = await configForRun(args.projectId, run);
    const taskRow = getTask(db,args.taskId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId || !config || !taskRow || taskRow.run_id !== args.runId || taskRow.kind !== "bb") {
      throw new Error("task does not belong to this PM run and project");
    }
    const taskContract = taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    const acceptance = listStageReceipts(db,args.runId,args.taskId).find((row) => row.stageId === "acceptance-receipt");
    if (acceptance?.state !== "passed") throw new Error("browser QA requires an accepted writer receipt first");
    const settings = await inheritedProjectSettings(bb,db,args.projectId,getRunSettingsScopes(db,args.runId));
    const routing = freezeRunRouting(db, args.runId, settings);
    const enabled = configuredSetting(settings,"browser_qa.enabled");
    const providerValue = configuredSetting(settings,"browser_qa.provider");
    const provider = providerValue == null || providerValue === "jev" ? "jev"
      : providerValue === "codex" ? "codex" : providerValue === "claude" ? "claude" : "unsupported";
    const modelSetting = configuredSetting(settings,"browser_qa.model");
    const configuredModelValue = typeof modelSetting === "string" ? modelSetting.trim() : "";
    const configuredModel = configuredModelValue && configuredModelValue !== "provider-specific" ? configuredModelValue : undefined;
    const reasoningSetting = configuredSetting(settings,"browser_qa.reasoning_effort");
    const configuredReasoningValue = typeof reasoningSetting === "string" ? reasoningSetting.trim() : "";
    const configuredReasoning = configuredReasoningValue && configuredReasoningValue !== "provider-specific" ? configuredReasoningValue : undefined;
    const requestInput = {url:args.url,cases:args.cases,envClass:args.envClass,viewports:args.viewports,authorized:args.authorized};
    const backendValue = configuredSetting(settings,"browser_qa.backend");
    const backend = backendValue == null || backendValue === "bb-browser" ? "bb-browser"
      : backendValue === "chrome-qa" || backendValue === "live-chrome" || backendValue === "headless" ? backendValue : null;
    const threadQa = backend === "bb-browser";
    // A case that signs in names its login («login: NAME»): it must be a login in Env Catalog and not left out of a non-empty secrets.allow list.
    // Nothing is recorded, so the PM can call again once access is in place (J5/J6).
    const logins = parseQaCases(args.cases).logins;
    if (logins.length) {
      if (!threadQa) return { runId:args.runId,taskId:args.taskId,state:"blocked",reason:"login_cases_need_the_bb_browser_backend: only the browser-check thread can read a login from Env Catalog; set the browser backend to bb-browser or drop the login: prefix" };
      const gate = await ctx.secrets.check({ declared:logins, allowed:allowedSecretNames(loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId))), kinds:["login"] }, { fresh:true });
      const problem = secretProblem(gate);
      if (problem.length || gate.unavailable) {
        return { runId:args.runId,taskId:args.taskId,state:"blocked",reason:waitingSecretReason(problem.length ? problem : logins),
          next:"Nothing was started. Fix the access below, then call lane_pilot_helpers {action:\"browser_qa\"} again with the same arguments:",fix:secretFixLines(gate) };
      }
      // The values are fetched only to be masked: whatever the check thread prints of them never reaches the verdict or the PM.
      for (const name of logins) {
        await ctx.secrets.record(name);
        try { recordSecretIssuance(db,{projectId:args.projectId,runId:args.runId,taskId:args.taskId,consumer:"qa",threadId:args.threadId,secretName:name}); } catch { /* the journal is a record, not a gate */ }
      }
    }
    const base = { runId:args.runId, taskId:args.taskId, stageId:"browser-qa" as const,
      input:JSON.stringify(requestInput),
      attempt:countAttempts(db,args.runId,args.taskId), providerId:threadQa ? "browser-qa-thread" : `browser-qa-${provider}`,
      model:configuredModel ?? null };
    const existing = listStageReceipts(db,args.runId,args.taskId).find((row) => row.stageId === "browser-qa");
    if (existing) {
      const stale = resolveStaleBrowserQaReceipt({ state:existing.state, result:existing.result, updatedAt:existing.updatedAt });
      if (stale.kind === "terminal") {
        return { runId:args.runId,taskId:args.taskId,state:existing.state,reason:"browser QA stage already has a receipt; create a new task for another proof run",stage:existing };
      }
      if (stale.kind === "observe") {
        return { runId:args.runId,taskId:args.taskId,state:existing.state,reason:"browser_qa_dispatch_unconfirmed_waiting_stale_window",stage:existing };
      }
      if (stale.kind === "retry" && (existing.state === "blocked" || existing.state === "skipped")) {
        recordStage(db,{...base,state:"pending",restart:true});
      }
      if (stale.kind === "outcome_unknown") {
        const frozenInput = existing.result && typeof existing.result === "object"
          ? JSON.stringify({ ...(existing.result as Record<string, unknown>), url:args.url })
          : base.input;
        recordStage(db,{...base,input:frozenInput,state:"blocked",reason:stale.reason,result:stale.result});
        return {runId:args.runId,taskId:args.taskId,state:"blocked",reason:stale.reason,stage:listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="browser-qa"),result:stale.result};
      }
    }
    const enabledOff = enabled === false || enabled === 0 || (typeof enabled === "string" && ["false","off","0","no"].includes(enabled.toLowerCase()));
    if (enabledOff) {
      recordStage(db,{...base,state:"skipped",reason:"disabled_by_project_setting"});
      return {runId:args.runId,taskId:args.taskId,state:"skipped",reason:"disabled_by_project_setting",stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (enabled != null && ![true,1,"true","on","1","yes",false,0,"false","off","0","no"].includes(enabled as never)) {
      const reason = "invalid_browser_qa_enabled_setting";
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    const approve = configuredSetting(settings,"browser_qa.approve");
    if (approve === "never") {
      recordStage(db,{...base,state:"skipped",reason:"browser_qa.approve=never"});
      return {runId:args.runId,taskId:args.taskId,state:"skipped",reason:"browser_qa.approve=never",stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (approve != null && approve !== "auto") {
      const reason = `unsupported_browser_qa_approval_setting:${String(approve)}`;
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (provider === "unsupported") {
      const reason = `unsupported_browser_qa_provider:${String(providerValue)}`;
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (provider === "claude" && !threadQa) {
      recordStage(db,{...base,state:"blocked",reason:"claude browser QA requires the configured chrome-devtools MCP RPC; no schema-verified RPC is available"});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason:"claude browser QA requires the configured chrome-devtools MCP RPC; no schema-verified RPC is available",stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (provider === "jev" && !threadQa && configuredModel && configuredModel !== "typesafe/jev-1.13") {
      const reason = "jev_runner_model_is_fixed: choose browser_qa.provider=codex to apply a custom model";
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (provider === "jev" && !threadQa && configuredReasoning) {
      const reason = "jev_runner_does_not_accept_reasoning_effort; clear that setting or select codex";
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    const model = configuredModel;
    let reasoning = configuredReasoning as "low"|"medium"|"high"|"xhigh"|"max"|undefined;
    if (!backend) {
      const reason = `unsupported_browser_qa_backend:${String(backendValue)}`;
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    const timeoutValue = configuredSetting(settings,"browser_qa.timeout_sec");
    const timeoutSec = typeof timeoutValue === "number" && Number.isInteger(timeoutValue) ? Math.min(1800,Math.max(30,timeoutValue)) : 900;
    let qaTarget;
    try {
      qaTarget = resolveBrowserQaTarget({
        writerHostId: config.hostId,
        configuredHostId: routing.qaHostId ?? configuredSetting(settings, QA_HOST_KEY),
        configuredWorkspace: configuredSetting(settings, QA_WORKSPACE_KEY),
        writerWorkspace: task.project_cwd,
        needsWorkspace: !threadQa,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      recordStage(db,{...base,state:"pending"});
      recordStage(db,{...base,state:"blocked",reason});
      return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
    if (provider === "codex" && !threadQa) {
      try {
        const [qaProviders, qaCatalog] = await Promise.all([
          bb.sdk.providers.list({ hostId: qaTarget.hostId }),
          bb.sdk.providers.models({ providerId: "codex", hostId: qaTarget.hostId }),
        ]);
        const preflight = qaCodexPreflight({
          hostId: qaTarget.hostId,
          providers: qaProviders,
          models: qaCatalog.models,
          model,
          reasoning,
        });
        if (!preflight.ok) {
          recordStage(db,{...base,state:"pending"});
          recordStage(db,{...base,state:"blocked",reason:preflight.reason});
          return {runId:args.runId,taskId:args.taskId,state:"blocked",reason:preflight.reason,stages:listStageReceipts(db,args.runId,args.taskId)};
        }
        reasoning = preflight.effort as typeof reasoning;
      } catch (cause) {
        const reason = `browser_qa_catalog_unavailable_on_host:${qaTarget.hostId}:${cause instanceof Error ? cause.message : String(cause)}`;
        recordStage(db,{...base,state:"pending"});
        recordStage(db,{...base,state:"blocked",reason});
        return {runId:args.runId,taskId:args.taskId,state:"blocked",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
      }
    }
    const dispatched = {
      ...requestInput,
      hostId: qaTarget.hostId,
      workspacePath: qaTarget.workspacePath,
      provider,
      model: model ?? null,
      backend,
      reasoning: reasoning ?? null,
    };
    const dispatchedBase = { ...base, input: JSON.stringify(dispatched) };
    const targetSnapshot = {
      writerHostId: config.hostId,
      configuredHostId: qaTarget.hostId,
      workspacePath: qaTarget.workspacePath,
      provider,
      configuredModel: model ?? null,
      configuredBackend: backend,
      configuredReasoning: reasoning ?? null,
    };
    const priorQa = listStageReceipts(db,args.runId,args.taskId).find((row) => row.stageId === "browser-qa");
    // A stage restarted after a check that never ran sits in pending; it moves on like a new one. Only one caller
    // still spawns: claimStageSpawn below is atomic.
    if (!priorQa || priorQa.state === "pending") {
      recordStage(db,{...dispatchedBase,state:"pending"});
      recordStage(db,{...dispatchedBase,state:"running",providerId:base.providerId,model,result:targetSnapshot});
    }
    if (!claimStageSpawn(db, args.runId, args.taskId, "browser-qa")) {
      const current = listStageReceipts(db,args.runId,args.taskId).find((row) => row.stageId === "browser-qa");
      return {runId:args.runId,taskId:args.taskId,state:current?.state ?? "running",reason:"browser_qa_already_dispatched",stage:current};
    }
    try {
      if (threadQa) {
        // The thread's own agent: codex when the project picked a codex model for QA, Claude Code otherwise.
        const agent = provider === "codex" && model
          ? { providerId:"codex", model, effort:reasoning ?? "high" }
          : { providerId:"claude-code", model:"claude-opus-5-5", effort:"high" };
        // A localhost target on another machine is reached over the private VPN when this machine has an address there.
        const vpn = qaTarget.hostId === config.hostId ? null
          : await host.call("vpnAddress",{requestedHostId:config.hostId},{hostId:config.hostId,timeoutMs:15_000}).catch(()=>null);
        const verdict = await runQaThread(ctx, {
          projectId:args.projectId, runId:args.runId, pmThreadId:args.threadId, taskTitle:task.title, qaHostId:qaTarget.hostId, timeoutSec,
          url:args.url, cases:args.cases, viewports:args.viewports, envClass:args.envClass, authorized:args.authorized, devServer:args.devServer, vpnAddress:vpn?.address ?? null, agent,
          // spawnAttempted stays: without it a second call would claim the stage again and start another check.
          onSpawned:(threadId, deadline) => recordStage(db,{...dispatchedBase,state:"running",
            result:{...targetSnapshot,spawnAttempted:true,threadId,link:`@thread:${threadId}`,deadline,timeoutSec,...(logins.length ? { logins } : {})}}),
        });
        const state = verdict.verdict;
        const snapshot = { ...targetSnapshot, url:args.url, backend:"bb-browser", agent, ...verdict };
        const reason = state === "passed" ? undefined : verdict.summary || undefined;
        recordStage(db,{...dispatchedBase,state,result:snapshot,...(reason ? {reason} : {})});
        return {runId:args.runId,taskId:args.taskId,state,link:verdict.link,stage:listStageReceipts(db,args.runId,args.taskId).find((row) => row.stageId === "browser-qa"),result:snapshot,reason};
      }
      let probe;
      try {
        probe = await host.call("probeBrowserQaTarget", {
          requestedHostId: qaTarget.hostId,
          workspacePath: qaTarget.workspacePath,
          url: args.url,
        }, { hostId: qaTarget.hostId, timeoutMs: 15_000 });
      } catch (cause) {
        const reason = qaHostUnreachableReason(qaTarget.hostId, cause);
        recordStage(db,{...dispatchedBase,state:"failed",reason,result:targetSnapshot});
        return {runId:args.runId,taskId:args.taskId,state:"failed",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
      }
      if (probe.hostId !== qaTarget.hostId) throw new Error("browser QA probe came from a different host");
      const result = await host.call("runBrowserQa",{
        requestedHostId:qaTarget.hostId, projectCwd:qaTarget.workspacePath, url:args.url,
        slug:`lp-qa-${args.runId.replace(/[^a-z0-9-]/gi,"").slice(-12)}-${args.taskId.replace(/[^a-z0-9-]/gi,"").slice(-12)}-${Date.now()}`.toLowerCase(),
        cases:args.cases, envClass:args.envClass, viewports:args.viewports, authorized:args.authorized,
        provider:provider as "jev"|"codex", ...(model ? {model} : {}), ...(reasoning ? {reasoningEffort:reasoning} : {}), backend:backend as "live-chrome"|"chrome-qa"|"headless", timeoutSec,
      },{hostId:qaTarget.hostId,timeoutMs:(timeoutSec+30)*1000});
      if (result.hostId !== qaTarget.hostId) throw new Error("browser QA result came from a different host");
      const mismatches = [
        model && result.actualModel !== model ? `configured_model=${model}, actual_model=${result.actualModel ?? "unknown"}` : null,
        reasoning && result.actualReasoningEffort !== reasoning ? `configured_effort=${reasoning}, actual_effort=${result.actualReasoningEffort ?? "unknown"}` : null,
        result.actualBackend !== backend ? `configured_backend=${backend}, actual_backend=${result.actualBackend ?? "unknown"}` : null,
      ].filter((item):item is string => item !== null);
      const state = mismatches.length ? "blocked" : result.verdict === "passed" ? "passed" : result.verdict === "failed" ? "failed" : "blocked";
      const reason = mismatches.length ? `browser_qa_runtime_setting_mismatch:${mismatches.join("; ")}` : result.reason ?? undefined;
      const snapshot = {
        ...result,
        status: qaStateToStatus(state),
        writerHostId: config.hostId,
        configuredHostId: qaTarget.hostId,
        workspacePath: qaTarget.workspacePath,
        url: args.url,
        probe,
        provider,
        configuredModel: model ?? null,
        configuredBackend: backend,
        configuredReasoning: reasoning ?? null,
      };
      recordStage(db,{...dispatchedBase,state,providerId:base.providerId,model:result.actualModel ?? model,result:snapshot,reason});
      return {runId:args.runId,taskId:args.taskId,state,stage:listStageReceipts(db,args.runId,args.taskId).find((row) => row.stageId === "browser-qa"),result:snapshot,reason};
    } catch (cause) {
      // Unloaded mid-check: the stage stays running for the next load to adopt, not failed with a verdict lost.
      if (ctx.isDisposed()) throw cause;
      const reason = cause instanceof Error ? cause.message : String(cause);
      recordStage(db,{...dispatchedBase,state:"failed",reason,result:targetSnapshot});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason,stages:listStageReceipts(db,args.runId,args.taskId)};
    }
  }

  const loadedAt = Date.now();
  /**
   * Browser checks whose wait died with a reload. The check thread goes on, so its verdict is read here and stored;
   * a check claimed before its thread id was saved never confirmed a start and is blocked, so it may run again.
   * Before, such a stage stayed «running» for good and the verdict was lost.
   */
  function resumeBrowserQaThreads(): number {
    const rows = db.prepare(`SELECT run_id, task_id FROM lane_pilot_stage_receipt WHERE stage_id='browser-qa' AND state='running' AND updated_at < ?`)
      .all(loadedAt) as Array<{ run_id:string; task_id:string }>;
    for (const row of rows) {
      const stage = listStageReceipts(db, row.run_id, row.task_id).find((item) => item.stageId === "browser-qa");
      if (!stage) continue;
      const frozen = stage.result && typeof stage.result === "object" ? stage.result as Record<string, unknown> : {};
      const base = { runId:row.run_id, taskId:row.task_id, stageId:"browser-qa" as const, input:JSON.stringify(frozen), attempt:stage.attempt,
        providerId:stage.providerId, model:stage.model };
      const threadId = typeof frozen.threadId === "string" ? frozen.threadId : null;
      if (!threadId) {
        recordStage(db, { ...base, state:"blocked", result:frozen, reason:"browser_qa_dispatch_lost_in_reload" });
        continue;
      }
      const timeoutSec = typeof frozen.timeoutSec === "number" ? frozen.timeoutSec : 1800;
      // After a reload the remembered values are gone: fetch the logins again so the verdict is masked as it would have been.
      const logins = Array.isArray(frozen.logins) ? frozen.logins.filter((name): name is string => typeof name === "string") : [];
      const deadline = typeof frozen.deadline === "number" ? frozen.deadline : stage.updatedAt + timeoutSec * 1000;
      void Promise.all(logins.map((name) => ctx.secrets.record(name))).then(() => awaitQaVerdict(ctx, threadId, deadline, timeoutSec, { projectId: getRun(db, row.run_id)?.project_id ?? "-", runId: row.run_id })).then((verdict) => {
        if (!verdict) return;
        const reason = verdict.verdict === "passed" ? undefined : verdict.summary || undefined;
        recordStage(db, { ...base, state:verdict.verdict, result:{ ...frozen, backend:"bb-browser", ...verdict }, ...(reason ? { reason } : {}) });
        bb.log.info(`Lane Pilot browser check ${row.task_id} adopted after a reload: ${verdict.verdict}`);
      }).catch((cause: unknown) => {
        if (!ctx.isDisposed()) bb.log.warn(`Lane Pilot browser check ${row.task_id} could not be adopted: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    }
    return rows.length;
  }

  async function ingestOpenCodeTelemetry(args:{threadId:string;projectId:string;runId:string;taskId:string;sessionId:string;taskFile:string;sourcePath:string})
    :Promise<Record<string,unknown>> {
    const metadata=await bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
    if(valueAt(metadata,"role")!=="pm"||stringAt(metadata,"lanePilotRunId")!==args.runId) throw new Error("runId does not belong to this Lane Pilot PM thread");
    const run=getRun(db,args.runId),config=await configForRun(args.projectId,run),taskRow=getTask(db,args.taskId);
    if(!run||run.project_id!==args.projectId||run.pm_thread_id!==args.threadId||!config||!taskRow||taskRow.run_id!==args.runId||taskRow.kind!=="bb") {
      throw new Error("telemetry task does not belong to this PM run and project");
    }
    const taskContract=taskV2Schema.parse(taskRow.contract);
    const workspace=acceptedTaskWorkspace(args.runId,args.taskId,run.writer_workspace_path!,taskContract);
    const task=workspace.task;
    if(listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="acceptance-receipt")?.state!=="passed") {
      throw new Error("OpenCode telemetry requires an accepted writer receipt first");
    }
    const existing=listStageReceipts(db,args.runId,args.taskId).find((row)=>row.stageId==="opencode-telemetry");
    if(existing) return {runId:args.runId,taskId:args.taskId,state:existing.state,reason:"telemetry already has a receipt; create a new task for another capture",stage:existing};
    const input={sessionId:args.sessionId,taskFile:args.taskFile,sourcePath:args.sourcePath};
    const base={runId:args.runId,taskId:args.taskId,stageId:"opencode-telemetry" as const,input:JSON.stringify(input),attempt:Math.min(countAttempts(db,args.runId,args.taskId),MAIN_ATTEMPT_LIMIT)};
    recordStage(db,{...base,state:"pending"});
    recordStage(db,{...base,state:"running"});
    try {
      const source=await host.call("readOpenCodeTelemetry",{requestedHostId:config.hostId,projectCwd:task.project_cwd,relativePath:args.sourcePath},{hostId:config.hostId,timeoutMs:30_000});
      if(source.hostId!==config.hostId) throw new Error("OpenCode telemetry came from a different host");
      if(source.relativePath!==args.sourcePath) throw new Error("OpenCode telemetry path changed on host");
      if(Buffer.byteLength(source.content,"utf8")!==source.size) throw new Error("OpenCode telemetry size did not match the host receipt");
      const parsed=parseOpenCodeToolTelemetry(source.content,args.sessionId,args.taskFile);
      const result={source:"opencode.tool.execute.after",sourcePath:source.relativePath,sourceLogSha256:source.sha256,
        sourceSessionSha256:sha256(args.sessionId),taskFile:args.taskFile,logBytes:source.size,lineCount:parsed.lineCount,
        matchingEventCount:parsed.events.length,events:parsed.events.slice(0,64),eventsTruncated:parsed.events.length>64,
        duplicateLines:parsed.duplicateLines,unmatchedSessions:parsed.unmatchedSessions,unmatchedTasks:parsed.unmatchedTasks,
        otherEvents:parsed.otherEvents,malformedLines:parsed.malformedLines,
        compactedSessionEvent:{state:"unavailable",reason:"current OpenCode hook contract does not emit session.compacted"}};
      const state=parsed.events.length===0||parsed.malformedLines>0?"blocked":"passed";
      const reason=parsed.events.length===0?"no_tool_execute_after_event_matched_session_and_task":parsed.malformedLines>0?"telemetry_log_contains_malformed_lines":undefined;
      recordStage(db,{...base,state,result,reason});
      return {runId:args.runId,taskId:args.taskId,state,result,...(reason?{reason}:{})};
    } catch(cause) {
      const reason=cause instanceof Error?cause.message:String(cause);
      recordStage(db,{...base,state:"failed",reason});
      return {runId:args.runId,taskId:args.taskId,state:"failed",reason};
    }
  }

  return { runBrowserQa, resumeBrowserQaThreads, ingestOpenCodeTelemetry };
}
