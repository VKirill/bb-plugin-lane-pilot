import { isTaskSatisfied, loadBlockedBy } from "../blocked-by";
import { setRunHalted } from "../runs-halt";
import { isLiveDecision } from "../../live-folder";
import { pmReadBrief } from "../../writer-brief";
import { buildCliInvocation } from "../../argv-builder";
import { requiredCliFlags } from "../../cli-flags";
import { classifyCliOutcome } from "../../cli-outcome";
import { cliReceiptAttemptKey, cliReceiptRunKey, DISPATCH_IDEMPOTENT_WINDOW_MS, DISPATCH_STAGES_PENDING } from "../../constants";
import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import { createAttempt, createTask, freeTaskId, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getRunWriterHost, getTask, getTaskPlan, latestTaskAttemptState, listAttemptsForTask, listOpenAttempts, listRunsWithAttempts, listStageReceipts, listTaskKinds, listTaskTerminalStates, recordFinishedAttempt, loadProjectSettings, loadPrototypeConfig, saveProjectSetting, saveTaskGitBase, saveTaskPlan, setRunState, transitionAttempt } from "../../database";
import { sha256 } from "../../stages/contract";
import { liveFolderLockNote, nextStep, taskFamily } from "../../failure-class";
import { isMainfixTask } from "../../validate-output";
import { validateTaskV2 } from "../../task-v2";
import { appendExcludeCommand, persistTaskFolder } from "../../verification/git-integrate";
import { lintReply } from "../contract-lint";
import { createTaskLinter } from "../lint-task";
import { runPlanCritique, runPmRead, runSpecialistReview } from "../critique-runs";
import { closeWriterStages, recordStage } from "../stage-records";
import { id, stringAt, valueAt } from "../values";
import { buildTask } from "../writer-task";
import { countRunNudges } from "../writer-silence";
import { isAbsolute, relative, resolve } from "node:path";
import type { ServerCore } from "../core";
import type { Services } from "../services";

/** How long a dispatch waits for its stages before it answers «queued» and lets them go on in the background. */
const dispatchAnswerMs = () => {
  const set = Number(process.env.LANE_PILOT_DISPATCH_ANSWER_MS);
  return process.env.LANE_PILOT_DISPATCH_ANSWER_MS && Number.isFinite(set) && set >= 0 ? set : 15_000;
};

function canonicalJson(value:unknown): string {
  const sorted = (item:unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, sorted(v)]))
    : item;
  return JSON.stringify(sorted(value));
}

export function createWriterDispatch(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, cliSettingsFor, configForRun, db, ensureRunScopes, getThreadBounded, host, refreshRun } = ctx;

  async function readWriterWorkspaceFile(args:{
    threadId:string; projectId:string; path:string; offset:number; maxLines:number;
  }): Promise<Record<string, unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    // The PM sending a task again is the restart after an owner's stop.
    if (runId) await setRunHalted(bb.storage.kv as never, runId, false);
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    const run = getRun(db, runId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId) {
      throw new Error("run does not belong to this PM thread and project");
    }
    const hostId = getRunWriterHost(db, runId);
    const workspacePath = run.writer_workspace_path;
    if (!hostId || !workspacePath) throw new Error("run has no frozen writer host or workspace binding");
    if (args.path.includes("\0") || isAbsolute(args.path)) throw new Error("lane_pilot_read_path_escaped_workspace");
    const absolute = resolve(workspacePath, args.path);
    const rel = relative(workspacePath, absolute);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("lane_pilot_read_path_escaped_workspace");
    const file = await host.call("readBoundedFile", {
      requestedHostId: hostId,
      projectCwd: workspacePath,
      relativePath: rel.split("\\").join("/"),
      offset: args.offset,
      maxLines: args.maxLines,
    }, { hostId, timeoutMs: 15_000 });
    if (file.hostId !== hostId) throw new Error("lane_pilot_read_host_mismatch");
    return file;
  }

  /** An open or accepted task of this run with the same id, contract and plan, created in the last 30 minutes. */
  function findLiveDuplicate(runId:string, requestedId:string, contract:TaskV2, plan:string): Record<string,unknown>|null {
    const row = db.prepare("SELECT contract_json, created_at FROM lane_pilot_task WHERE id=? AND run_id=?").get(requestedId, runId) as
      {contract_json:string; created_at:number}|undefined;
    if (!row || Date.now() - row.created_at > DISPATCH_IDEMPOTENT_WINDOW_MS) return null;
    if (canonicalJson(JSON.parse(row.contract_json)) !== canonicalJson({ ...contract, id:requestedId })) return null;
    if (sha256(getTaskPlan(db, requestedId) ?? "") !== sha256(plan)) return null;
    const latest = listAttemptsForTask(db, runId, requestedId).at(-1);
    // A task that ended blocked or canceled is dispatched again under a new id, as before. One without an attempt yet is still in preflight.
    if (latest ? ["blocked", "canceled"].includes(latest.state)
      : db.prepare("SELECT 1 FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND state IN ('blocked','failed') LIMIT 1").get(runId, requestedId)) return null;
    return { runId, taskId:requestedId, attemptId:latest?.id ?? null, writerThreadId:latest?.thread_id ?? null, state:latest?.state ?? "queued", deduplicated:true,
      stages:listStageReceipts(db, runId, requestedId),
      note:"This task id with the same contract and plan was already dispatched in the last 30 minutes; this is that task, nothing new was created. Poll lane_pilot_wait_writer or end your turn with lane_pilot_remind on the task id." };
  }

  /** A member of the task's family («P1», «P1.2») with an open attempt or parked for a restart, in this project; mainfixes are their own work. */
  async function runningFamilyMember(projectId:string, taskId:string):Promise<{ taskId:string; parked:boolean } | null> {
    const family = taskFamily(taskId);
    const same = (other:string) => !isMainfixTask(other) && taskFamily(other) === family;
    const open = listOpenAttempts(db).find((row) => row.project_id === projectId && same(row.task_id));
    if (open) return { taskId:open.task_id, parked:false };
    const parked = (await services.stability.loadParked()).find((row) => row.projectId === projectId && same(row.taskId) && getRun(db, row.runId)?.closed_at == null);
    return parked ? { taskId:parked.taskId, parked:true } : null;
  }

  const lintTask = createTaskLinter(ctx, services);

  async function dispatchWriter(args:{threadId:string; projectId:string; task?:TaskV2; plan?:string; baseRef?:string}): Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    // Settings of the section this run works in, read by every stage below.
    await ensureRunScopes(runId);
    const run = getRun(db, runId);
    // A native run's host, workspace and writer come from its binding and current settings, never from a stale prototype config.
    const config = await configForRun(args.projectId, run);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${args.projectId}`);
    const workspacePath = run?.writer_workspace_path;
    if (!run || !workspacePath) {
      const reason = "run has no persisted writerWorkspacePath; reactivate Lane Pilot to create a run with a workspace snapshot";
      return { runId, state:"rejected", reason, unapplied:[{ key:"task.project_cwd", reason }] };
    }
    const runConfig = { ...config, writerWorkspacePath:workspacePath };
    if (listTaskKinds(db, runId).includes("cli")) {
      throw new Error("V1: BB writer cannot join a CLI run-controller run");
    }
    const taskId = args.task ? freeTaskId(db, args.task.id) : id("lptask");
    const prepared = args.task ? { ...args.task, id:taskId } : buildTask(runConfig, taskId);
    const canonicalPlan = args.plan ?? prepared.objective;
    if (canonicalPlan.trim().length === 0) throw new Error("canonical plan must be non-empty");
    const valid = validateTaskV2(prepared);
    if (!valid.ok) throw new Error(`task-v2 invalid: ${valid.errors.join("; ")}`);
    if (resolve(valid.task.project_cwd) !== resolve(workspacePath)) {
      const reason = `task.project_cwd must equal the configured writerWorkspacePath (${workspacePath})`;
      return { runId, state:"rejected", reason, unapplied:[{ key:"task.project_cwd", reason }] };
    }
    valid.task.project_cwd = workspacePath;
    // The PM sending the same task again (its call ended «terminated» while the stages went on) gets the task it already has.
    const duplicate = args.task ? findLiveDuplicate(runId, args.task.id, valid.task, canonicalPlan) : null;
    if (duplicate) return duplicate;
    // A task is one writer session that restarts itself after a machinery fault: sending another member of its family
    // (`<id>.N`) while one runs or is parked would start a second writer on the same work.
    const inProgress = args.task && !isMainfixTask(args.task.id) ? await runningFamilyMember(args.projectId, args.task.id) : null;
    if (inProgress) {
      const hint = `${inProgress.taskId} of the same task is ${inProgress.parked ? "parked and restarts by itself" : "running"}: use lane_pilot_update_task / lane_pilot_answer_writer; redispatch only to change the contract, and cancel it first with lane_pilot_cancel_task`;
      return { ok:false, error:{ code:"task_in_progress", retryable:false, sideEffects:"none", hint }, runningTaskId:inProgress.taskId, hint };
    }
    // Contract lint: every contract mistake a helper or writer would only trip over later goes back to the PM now,
    // in one message with the fix, before a task or an attempt exists.
    const lint = await lintTask(args.projectId, runId, valid.task, workspacePath, config.hostId);
    if (lint.errors.length) return lintReply(runId, lint.errors);
    createTask(db, { id:taskId, runId, kind:"bb", contract:valid.task });
    saveTaskPlan(db, taskId, canonicalPlan);
    if (run.run_gate === "pre-merge") {
      const reason = "explicit_review_gate_requires_operator";
      recordStage(db,{runId,taskId,stageId:"run-gate",state:"blocked",input:JSON.stringify({gate:run.run_gate,planSha256:sha256(canonicalPlan)}),
        result:{decision:"operator_review_required",gate:run.run_gate,writerDispatched:false},reason});
      for(const stageId of ["pm-read","plan-critique","specialist-review","writer-agent","verification","acceptance-receipt"] as const) {
        recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason:"run gate stopped execution before automated stage dispatch"});
      }
      setRunState(db,runId,"blocked");
      return {runId,taskId,state:"blocked",reason,gate:run.run_gate,writerDispatched:false,stages:listStageReceipts(db,runId,taskId)};
    }
    // The attempt exists before the long stages: pm-read and plan critique each wait for a helper thread for minutes,
    // and the tool call used to end «terminated» in that wait while the dispatch went on unseen (live 2026-10-06, §6.1).
    const attemptId = id("lpattempt");
    createAttempt(db, { id:attemptId, runId, taskId });
    transitionAttempt(db, attemptId, "queued", { reason:DISPATCH_STAGES_PENDING });
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
      recordStage(db, { runId, taskId, stageId, state:"pending", input:canonicalPlan });
    }
    const runStages = async (): Promise<Record<string,unknown>> => {
      const pmRead=await runPmRead({bb,db,projectId:args.projectId,runId,taskId,pmThreadId:args.threadId,config:runConfig,task:valid.task});
      if(pmRead.state==="failed") {
        const reason=`pm_read_failed:${pmRead.reason ?? "unknown"}`;
        recordStage(db,{runId,taskId,stageId:"plan-critique",state:"skipped",input:canonicalPlan,reason:"PM read stage failed"});
        recordStage(db,{runId,taskId,stageId:"specialist-review",state:"skipped",input:canonicalPlan,reason:"PM read stage failed"});
        for(const stageId of ["writer-agent","verification","acceptance-receipt"] as const) recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason:"PM read stage failed"});
        transitionAttempt(db,attemptId,"blocked",{reason});
        setRunState(db,runId,"blocked");
        refreshRun(runId);
        return {runId,taskId,attemptId,state:"blocked",reason,stages:listStageReceipts(db,runId,taskId)};
      }
      const critique = await runPlanCritique({ bb, db, projectId:args.projectId, runId, taskId,
        config:runConfig, task:valid.task, plan:canonicalPlan, pmReadContext:pmRead.summary || undefined });
      if (!critique.allowed) {
        recordStage(db, { runId, taskId, stageId:"specialist-review", state:"skipped", input:canonicalPlan,
          reason:"plan-critique did not allow dispatch" });
        for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
          recordStage(db, { runId, taskId, stageId, state:"skipped", input:canonicalPlan,
            reason:"upstream plan-critique stage did not pass" });
        }
        transitionAttempt(db, attemptId, "blocked", { reason:critique.reason ?? "plan-critique did not allow dispatch" });
        setRunState(db, runId, "blocked");
        return { runId, taskId, attemptId, state:"blocked", reason:critique.reason, stages:listStageReceipts(db, runId, taskId) };
      }
      const specialist = await runSpecialistReview({bb,db,projectId:args.projectId,runId,taskId,
        config:runConfig,task:valid.task,plan:canonicalPlan});
      if (!specialist.allowed) {
        for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
          recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason:"specialist review did not allow dispatch"});
        }
        transitionAttempt(db,attemptId,"blocked",{reason:specialist.reason ?? "specialist review did not allow dispatch"});
        setRunState(db,runId,"blocked");
        return {runId,taskId,attemptId,state:"blocked",reason:specialist.reason,stages:listStageReceipts(db,runId,taskId)};
      }
      // A folder without git has no base commit to measure ownership against: the writer's work is the difference of
      // two content snapshots of the folder.
      const live=await services.isLiveFolder(runId,config.hostId,workspacePath);
      const gitBase=live?null:await host.call("gitOwnershipBase",{
        requestedHostId:config.hostId,projectCwd:workspacePath,...(args.baseRef===undefined?{}:{baseRef:args.baseRef}),
      },{hostId:config.hostId,timeoutMs:30_000});
      if(gitBase&&gitBase.status!=="ready"&&(args.baseRef!==undefined||gitBase.status!=="not-git")) {
        const reason=`git ownership base unavailable: ${gitBase.reason??gitBase.status}`;
        recordStage(db,{runId,taskId,stageId:"run-gate",state:"blocked",input:canonicalPlan,
          result:{decision:"ownership_base_unavailable",baseRef:args.baseRef??null},reason});
        for(const stageId of ["writer-agent","verification","acceptance-receipt"] as const) {
          recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason:"git ownership base preflight failed"});
        }
        transitionAttempt(db,attemptId,"blocked",{reason});
        setRunState(db,runId,"blocked");
        refreshRun(runId);
        return {runId,taskId,attemptId,state:"blocked",reason,stages:listStageReceipts(db,runId,taskId)};
      }
      if(gitBase?.status==="ready"&&!saveTaskGitBase(db,taskId,{
        baseRef:gitBase.baseRef,baseSha:gitBase.baseSha,initialHeadSha:gitBase.headSha!,branch:gitBase.branch!,compareCommitted:gitBase.compareCommitted,
      })) {
        const reason="could not persist immutable git ownership base snapshot";
        recordStage(db,{runId,taskId,stageId:"run-gate",state:"blocked",input:canonicalPlan,result:{decision:"ownership_base_persist_failed"},reason});
        for(const stageId of ["writer-agent","verification","acceptance-receipt"] as const) recordStage(db,{runId,taskId,stageId,state:"skipped",input:canonicalPlan,reason});
        transitionAttempt(db,attemptId,"blocked",{reason});
        setRunState(db,runId,"blocked");refreshRun(runId);
        return {runId,taskId,attemptId,state:"blocked",reason,stages:listStageReceipts(db,runId,taskId)};
      }
      try {
        await persistTaskFolder({
          taskId, plan:canonicalPlan,
          // The line goes into the repository's real info/exclude, resolved by git on the workspace's own host —
          // never into a stray `.git` of a subfolder workspace (OVH 2026-10-06). PLAN.md is written regardless.
          exclude: live ? undefined : async (line) => {
            const ran=await host.call("runCommand",{
              requestedHostId:config.hostId,cwd:workspacePath,command:appendExcludeCommand(line),timeoutSec:30,
            },{hostId:config.hostId,timeoutMs:30_000});
            if(ran.exitCode!==0) throw new Error(ran.stderr.trim()||`git exited ${ran.exitCode}`);
          },
          writeFile: async (rel, content) => {
            await bb.sdk.files.write({
              hostId:config.hostId, rootPath:workspacePath, path:`${workspacePath}/${rel}`,
              content, contentEncoding:"utf8", createParents:true, expectedSha256:null,
            });
          },
        });
      } catch (cause) {
        bb.log.warn(`Lane Pilot could not persist task folder for ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      // A cancel during the stages ends the queued attempt: the writer must not start for it.
      const waiting = getAttempt(db, attemptId);
      if (waiting?.state !== "queued") return { runId, taskId, attemptId, state:waiting?.state ?? "canceled", reason:waiting?.reason ?? "attempt ended before its stages finished", stages:listStageReceipts(db, runId, taskId) };
      transitionAttempt(db, attemptId, "queued");
      services.startWriterTask({
        projectId:args.projectId, runId, taskId, firstAttemptId:attemptId,
        pmThreadId:args.threadId, config:runConfig, task:valid.task, plan:canonicalPlan, pmReadContext:pmRead.summary || undefined,
      });
      // The writer's brief carries the read stage's facts, not its open questions: those are the PM's to settle.
      const openQuestions = pmRead.summary ? pmReadBrief(pmRead.summary).openQuestions : [];
      const warnings: string[] = lint.warnings.map((warning) => warning.message);
      if (live) warnings.push("mode live-folder: this folder has no git. The writer edits the live files in place; nothing is committed or merged, so there is no ship step. One writer at a time works in the folder, later tasks queue. A task that is not accepted is rolled back from a backup of its owns_paths (~/.lane-pilot/live-backups, kept 7 days); files outside owns_paths are not rolled back.");
      return { runId, taskId, attemptId, writerThreadId:null, state:"queued", stages:listStageReceipts(db, runId, taskId),
        ...(warnings.length ? { warnings } : {}),
        ...(openQuestions.length ? { pmReadOpenQuestions:openQuestions,
          pmReadNote:"The writer does not see these questions. If one changes what the writer should do, wait for this attempt's receipt and, if it is not accepted, dispatch again with the answer in the plan; otherwise the writer decides from the code." } : {}) };
    };
    const work = runStages().catch((cause): Record<string,unknown> => {
      const reason = `dispatch_failed:${cause instanceof Error ? cause.message : String(cause)}`;
      bb.log.warn(`Lane Pilot dispatch of ${taskId} failed: ${reason}`);
      transitionAttempt(db, attemptId, "blocked", { reason });
      closeWriterStages(db, { runId, taskId, plan:canonicalPlan, terminal:"failed", attempt:0, reason });
      setRunState(db, runId, "blocked");
      refreshRun(runId);
      return { runId, taskId, attemptId, state:"blocked", reason, stages:listStageReceipts(db, runId, taskId) };
    });
    // Stages that finish within the budget answer as before; slower ones go on in the background and the PM polls.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early = await Promise.race([work, new Promise<null>((done) => { timer = setTimeout(() => done(null), dispatchAnswerMs()); })]);
    clearTimeout(timer);
    if (early) return early;
    return { runId, taskId, attemptId, writerThreadId:null, state:"queued", stagesPending:true, stages:listStageReceipts(db, runId, taskId),
      note:"pm-read and plan critique are still running; the writer starts by itself once they pass. Poll lane_pilot_wait_writer or end your turn with lane_pilot_remind on the task id. Do not send the task again: the same id and contract returns this task." };
  }

  /**
   * Each task of the run touched in the last 3 hours, by its latest attempt: a long run always has something
   * running, so a bare «running» hid that tasks had ended blocked (SelfyStudio 2026-10-04: the PM took two blocked
   * tasks for waiting ones for two hours).
   */
  function recentTaskSummary(runId:string) {
    const since = Date.now() - 3 * 3600_000;
    const rows = db.prepare(`SELECT task_id, state, reason, updated_at, created_at FROM lane_pilot_attempt WHERE run_id=? AND updated_at>=? ORDER BY created_at`)
      .all(runId, since) as Array<{ task_id:string; state:string; reason:string|null; updated_at:number; created_at:number }>;
    const latest = new Map(rows.map((row) => [row.task_id, row]));
    const tasks = [...latest.values()].filter((row) => row.updated_at >= since).sort((a, b) => b.updated_at - a.updated_at).slice(0, 40).map((row) => {
      const writer = listStageReceipts(db, runId, row.task_id).find((stage) => stage.stageId === "writer-agent");
      const waiting = row.state === "queued" && writer?.state === "pending" ? writer.reason : null;
      return { taskId:row.task_id, state:row.state, ...(row.reason ? { reason:row.reason.slice(0, 400) } : {}), ...(waiting ? { waiting } : {}) };
    });
    return { tasks, ids:new Set(tasks.map((row) => row.taskId)) };
  }

  /** A writer's unanswered question in a folder without git keeps the folder locked: the wait receipt says so. */
  const folderLockNote = (attempt:{ id:string; state:string; reason:string | null }):string =>
    liveFolderLockNote(attempt.state, attempt.reason, isLiveDecision(getAttempt(db, attempt.id)?.workspace_decision));

  async function waitWriter(args:{threadId:string; projectId:string; runId:string; timeoutSec:number}): Promise<Record<string, unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm" || stringAt(metadata, "lanePilotRunId") !== args.runId) {
      throw new Error("runId does not belong to this Lane Pilot PM thread");
    }
    const run = getRun(db, args.runId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId) {
      throw new Error("run does not belong to this PM thread and project");
    }
    const deadline = Date.now() + Math.min(240, Math.max(1, args.timeoutSec)) * 1000;
    while (Date.now() < deadline) {
      // A plugin reload closes this instance's database; the writer keeps running, so ask for a fresh poll.
      if (ctx.state.disposed) return { runId:args.runId, state:"running", reason:"Lane Pilot was reloaded; call lane_pilot_wait_writer again" };
      const listedRun = listRunsWithAttempts(db, args.projectId).find((item) => item.id === args.runId);
      const latestByTask = new Map<string, {id:string;state:string;attempt_no:number;thread_id:string|null;reason:string|null;task_id:string}>();
      for (const attempt of listedRun?.attempts ?? []) {
        if (!latestByTask.has(attempt.task_id) || latestByTask.get(attempt.task_id)!.attempt_no < attempt.attempt_no) {
          latestByTask.set(attempt.task_id, attempt);
        }
      }
      if (latestByTask.size === 0) {
        const stages = listStageReceipts(db, args.runId);
        const writerStage = stages.find((row) => row.stageId === "writer-agent");
        if (writerStage?.state === "skipped" && writerStage.reason) {
          const reason = stages.find((row) => row.stageId === "plan-critique")?.reason ?? writerStage.reason;
          return { runId:args.runId, state:"blocked", receipt:null, stages, ...(reason ? { reason } : {}) };
        }
      }
      for (const attempt of latestByTask.values()) {
        if ((attempt.state !== "running" && attempt.state !== "cancel_requested") || !attempt.thread_id) continue;
        const thread = await getThreadBounded(attempt.thread_id);
        const threadStatus = stringAt(thread, "status");
        if (threadStatus === "error" || (attempt.state === "cancel_requested" && threadStatus === "idle")) {
          const failedState = attempt.state === "cancel_requested" ? "canceled" : "provider_error";
          const reason = attempt.state === "cancel_requested" ? "writer stop observed" : "writer thread status error";
          transitionAttempt(db, attempt.id, failedState, { reason });
          refreshRun(args.runId);
          latestByTask.set(attempt.task_id, { ...attempt, state:failedState, reason });
        }
      }
      for (const attempt of latestByTask.values()) {
        const key = `${args.runId}:${attempt.task_id}`;
        if (attempt.state !== "provider_error" || services.activeWriterTasks.has(key)) continue;
        const task = getTask(db, attempt.task_id);
        const currentRun = getRun(db, args.runId);
        const config = await configForRun(args.projectId, currentRun);
        const parsed = task?.kind === "bb" ? taskV2Schema.safeParse(task.contract) : null;
        if (currentRun?.writer_workspace_path && currentRun.pm_thread_id && config && parsed?.success) {
          const taskWorkspace=acceptedTaskWorkspace(args.runId,attempt.task_id,currentRun.writer_workspace_path,parsed.data,attempt.id);
          services.startWriterTask({
            projectId:args.projectId,
            runId:args.runId,
            taskId:attempt.task_id,
            firstAttemptId:attempt.id,
            pmThreadId:currentRun.pm_thread_id,
            writerThreadId:attempt.thread_id ?? undefined,
            config:{ ...config, writerWorkspacePath:taskWorkspace.path },
            task:taskWorkspace.task,
            plan:getTaskPlan(db, attempt.task_id) ?? parsed.data.objective,
          });
        }
      }
      const states = listTaskTerminalStates(db, args.runId);
      const state = states.length && states.every((item) => !["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(item))
        ? (states.includes("accepted") ? "accepted" : states.includes("blocked") ? "blocked" : states.at(-1)!)
        : "running";
      if (state !== "running") {
        // A finished task records its stage receipts just before it leaves services.activeWriterTasks; wait for that.
        if ([...services.activeWriterTasks].some((key) => key.startsWith(`${args.runId}:`))) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        // writer.lastResult is one project-wide slot that the last accepted task overwrites; read each task's own receipt.
        const settings = loadProjectSettings(db,args.projectId,getRunSettingsScopes(db,args.runId));
        const lastResult = settings["writer.lastResult"];
        const taskReceipts = [...latestByTask.values()].flatMap((attempt) => {
          const stage = listStageReceipts(db, args.runId, attempt.task_id).find((row) => row.stageId === "acceptance-receipt");
          const base = stage?.state === "passed" && stage.result && typeof stage.result === "object" ? stage.result
            : valueAt(lastResult, "lanePilotRunId") === args.runId && valueAt(lastResult, "lanePilotTaskId") === attempt.task_id ? lastResult : null;
          if (!base || typeof base !== "object") return [];
          const trace = getReasoningTrace(db, attempt.id);
          return [{ ...base as Record<string, unknown>, reasoning:trace ? [trace] : [] }];
        });
        const receipt = taskReceipts.length > 1 ? { lanePilotRunId:args.runId, tasks:taskReceipts } : taskReceipts[0] ?? null;
        const reasons = [...latestByTask.values()].map((attempt) => attempt.reason).filter((reason): reason is string => Boolean(reason));
        // A blocked task says who holds it and when to look again, so the PM can ask the holder or set a reminder.
        const blockedBy = (await Promise.all([...latestByTask.values()].filter((attempt) => attempt.state === "blocked")
          .map(async (attempt) => { const found = await loadBlockedBy(bb.storage.kv, attempt.id); return found ? { taskId:attempt.task_id, ...found } : null; })))
          .filter((row) => row !== null);
        const nudged = await countRunNudges(bb.storage.kv, (listedRun?.attempts ?? []).map((row) => row.id));
        const next = [...latestByTask.values()].filter((attempt) => attempt.state !== "accepted")
          .map((attempt) => ({ taskId:attempt.task_id, state:attempt.state, next:`${nextStep(attempt.state, attempt.reason)}${folderLockNote(attempt)}` }));
        return { runId:args.runId, state, receipt, stages:listStageReceipts(db, args.runId), nudged, ...(reasons.length ? { reason:reasons.join("; ") } : {}),
          ...(next.length ? { next } : {}),
          ...(blockedBy.length ? { blockedBy } : {}) };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const attempts = listOpenAttempts(db).filter((attempt) => attempt.run_id === args.runId);
    const writerThreadId = attempts.at(-1)?.thread_id ?? null;
    const recent = recentTaskSummary(args.runId);
    return {
      runId:args.runId,
      attemptId:attempts.at(-1)?.id ?? null,
      writerThreadId,
      state:"running",
      nudged:await countRunNudges(bb.storage.kv, listRunsWithAttempts(db, args.projectId).find((item) => item.id === args.runId)?.attempts.map((row) => row.id) ?? []),
      tasks:recent.tasks,
      stages:listStageReceipts(db, args.runId).filter((row) => recent.ids.has(row.taskId)),
      ...(writerThreadId
        ? { message:"Писатель ещё работает. Вызови lane_pilot_wait_writer ещё раз с тем же runId." }
        : { writerStarted:false, message:"Писатель ещё не создан. Старт не закончен или не прошёл. Вызови lane_pilot_wait_writer ещё раз с тем же runId." }),
    };
  }

  async function dispatchCli(args:{
    threadId:string; projectId:string; binary?:"run-controller"|"lane-ctl"; subcommand?:string;
    taskFile?:string; taskId?:string; runDir?:string;
  }): Promise<Record<string,unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    const config = loadPrototypeConfig(db, args.projectId);
    if (!config) throw new Error(`Lane Pilot prototype is not configured for ${args.projectId}`);
    if (listTaskKinds(db, runId).includes("bb")) {
      throw new Error("V1: CLI writer cannot join a BB writer run");
    }
    const binary = args.binary ?? "run-controller";
    const subcommand = args.subcommand ?? "run";
    const settings = await cliSettingsFor(args.projectId, config);
    const runDir = args.runDir
      ?? (typeof settings["ops.run_dir"] === "string" ? settings["ops.run_dir"] : undefined)
      ?? `${config.writerWorkspacePath}/.agents/runs/lane-pilot-${runId}`;
    const invocation = buildCliInvocation({
      binary,
      subcommand,
      settings,
      required: requiredCliFlags({
        binary,
        subcommand,
        runDir,
        projectCwd: String(settings["ops.project_cwd"] ?? config.writerWorkspacePath),
        taskFile: args.taskFile ?? (typeof settings["ops.task_file"] === "string" ? settings["ops.task_file"] : undefined),
        taskId: args.taskId ?? (typeof settings["ops.task_id"] === "string" ? settings["ops.task_id"] : undefined),
      }),
    });
    const invalidSetting = invocation.unapplied.find((row) => row.reason.startsWith("invalid value;"));
    if (invalidSetting) {
      return {
        status:"blocked",
        reason:`invalid setting ${invalidSetting.key}: ${invalidSetting.reason}`,
        applied:invocation.applied,
        unapplied:invocation.unapplied,
        argv:invocation.argv,
        env:invocation.env,
      };
    }
    const executed = await host.call("runCli", {
      requestedHostId: config.hostId,
      binary,
      argv: invocation.argv,
      env: invocation.env,
      cwd: config.writerWorkspacePath,
    }, { hostId:config.hostId, timeoutMs:180_000 });
    const outcome = classifyCliOutcome({
      subcommand,
      exitCode:executed.exitCode,
      stdout:executed.stdout,
    });
    const receiptPath = `${runDir}/cli-receipt.json`;
    const receipt = {
      schemaVersion:1,
      kind:"cli",
      status: outcome.status,
      taskAccepted: outcome.taskAccepted,
      upstreamAccepted: outcome.upstreamAccepted,
      upstreamStatus: outcome.upstreamStatus,
      reason: outcome.reason,
      lanePilotRunId:runId,
      pmThreadId:args.threadId,
      binary,
      argv: executed.argv,
      env: executed.env,
      exitCode: executed.exitCode,
      stdout: executed.stdout,
      stderr: executed.stderr,
      applied: invocation.applied,
      unapplied: invocation.unapplied,
      receiptPath,
    };
    await bb.sdk.files.write({
      hostId: config.hostId,
      rootPath: config.writerWorkspacePath,
      path: receiptPath,
      content: `${JSON.stringify(receipt, null, 2)}\n`,
      contentEncoding: "utf8",
      createParents: true,
      expectedSha256: null,
    });
    const mutating = subcommand === "start" || subcommand === "run";
    let attemptId: string | null = null;
    if (mutating) {
      const existing = db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=? AND kind='cli'")
        .get(runId) as { id: string } | undefined;
      const taskId = existing?.id ?? id("lptask");
      if (!existing) {
        createTask(db, { id: taskId, runId, kind:"cli", contract:{ binary, subcommand, argv:executed.argv, receiptPath } });
      }
      attemptId = id("lpattempt");
      createAttempt(db, { id: attemptId, runId, taskId });
      recordFinishedAttempt(db, attemptId, outcome.status, outcome.reason);
    }
    saveProjectSetting(db, args.projectId, cliReceiptRunKey(runId), JSON.stringify(receipt));
    if (attemptId) {
      saveProjectSetting(db, args.projectId, cliReceiptAttemptKey(attemptId), JSON.stringify(receipt));
    }
    setRunState(db, runId, outcome.status);
    return receipt;
  }

  return { readWriterWorkspaceFile, dispatchWriter, waitWriter, dispatchCli };
}
