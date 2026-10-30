import { isTaskSatisfied, loadBlockedBy } from "../../runs/server";
import { setRunHalted } from "../../runs/server";
import { isLiveDecision } from "../live-folder";
import { DISPATCH_IDEMPOTENT_WINDOW_MS, DISPATCH_STAGES_PENDING } from "../../runs";
import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import { QUALITY_MODE_SETTING, browserQaRequired, resolveQualityMode, taskQaPlan } from "../../critique";
import { reserveAppetite, resolveBestOf } from "../best-of";
import type { CodeCriticDefault } from "../../critique";
import { saveCriticCodeDefault } from "./critic-override";
import { getRunObjective, setRunObjective, createAttempt, createTask, freeTaskId, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getRunWriterHost, getTask, getTaskGitBase, getTaskPlan, latestTaskAttemptState, listAttemptsForTask, listOpenAttempts, listRunsWithAttempts, listStageReceipts, listTaskKinds, listTaskTerminalStates, loadProjectSettings, saveTaskPlan, setRunState, transitionAttempt } from "../../storage";
import { sha256 , spendReserve, type BirthKind } from "../../tasks";
import { liveFolderLockNote, nextStep, taskFamily } from "../../runs";
import { commonTaskFolder, isMainfixTask, isTaskBase, parseRepoTop, planWithOutsideReads, repoTopCommand, rerootTask } from "../../tasks";
import { validateTaskV2 } from "../../tasks/task-v2";
import { lintReply } from "../../tasks/server";
import type { LintFinding } from "../../tasks/server";
import { createTaskLinter } from "../../tasks/server";
import { closeWriterStages, recordStage, resetHelperStages } from "../../runs/server";
import { id, stringAt, valueAt } from "../../core/server";
import { buildTask } from "./writer-task";
import { dispatchReply, dispatchRunKey, startDispatchRun, pipelineUnavailable } from "./dispatch-workflow";
import { suggestTests, testHintLine } from "../../verification";
import { jev } from "@lane-pilot/jev";
import { batchAdviceFor, topicLoopGuard } from "./dispatch-guards";
import { reviveCanceledTask } from "./revive";
import { countRunNudges } from "./writer-silence";
import { isAbsolute, relative, resolve } from "node:path";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { runOnHost } from "@lane-pilot/host-calls";
import { pollPause } from "@lane-pilot/kit";

/** How long a dispatch waits for its stages before it answers «queued» and lets them go on in the background. */
const dispatchAnswerMs = () => {
  const set = Number(process.env.LANE_PILOT_DISPATCH_ANSWER_MS);
  return process.env.LANE_PILOT_DISPATCH_ANSWER_MS && Number.isFinite(set) && set >= 0 ? set : 15_000;
};

/** How often a dispatch starts again after reloads before its attempt is blocked and the PM sends the task again. */
export const MAX_DISPATCH_RESUMES = 2;

function canonicalJson(value:unknown): string {
  const sorted = (item:unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, sorted(v)]))
    : item;
  return JSON.stringify(sorted(value));
}

export function createWriterDispatch(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, ensureRunScopes, getThreadBounded, host, refreshRun } = ctx;
  /** Attempts whose pm-read / plan critique this instance is running now: start-up recovery leaves them alone. */
  const liveDispatches = new Set<string>();

  /** A dispatch whose stages threw: the attempt is blocked and its writer stages fail. */
  function failDispatch(runId:string, taskId:string, attemptId:string, plan:string, cause:unknown): Record<string,unknown> {
    const reason = `dispatch_failed:${cause instanceof Error ? cause.message : String(cause)}`;
    bb.log.warn(`Lane Pilot dispatch of ${taskId} failed: ${reason}`);
    transitionAttempt(db, attemptId, "blocked", { reason });
    closeWriterStages(db, { runId, taskId, plan, terminal:"failed", attempt:0, reason });
    setRunState(db, runId, "blocked");
    refreshRun(runId);
    return { runId, taskId, attemptId, state:"blocked", reason, stages:listStageReceipts(db, runId, taskId) };
  }

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
      note:"This task id with the same contract and plan was already dispatched in the last 30 minutes; this is that task, nothing new was created. Poll lane_pilot_wait_writer or end your turn; Lane Pilot sends you the results." };
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

  /**
   * Where a task works. The run's folder as before; a git repository inside it the PM named as project_cwd; or, in a run
   * folder without git (BB-сервис holds 41 plugin repositories), the repository every path of the task lies in: the task
   * moves into it (paths relative to it) and gets a worktree, a git diff and a merge there instead of the live folder.
   */
  async function placeTask(runId:string, hostId:string, runFolder:string, task:TaskV2, plan:string):Promise<{ task:TaskV2; plan:string; movedInto?:string } | { rejected:string }> {
    const repoOf = async (folder:string) => parseRepoTop(await runOnHost(host, { hostId, cwd:runFolder, command:repoTopCommand(folder, runFolder), timeoutSec:20, timeoutMs:25_000 }).catch(() => null));
    if (resolve(task.project_cwd) !== resolve(runFolder)) {
      const named = relative(resolve(runFolder), resolve(task.project_cwd)).split("\\").join("/");
      if (isTaskBase(runFolder, task.project_cwd) && await repoOf(task.project_cwd) === named) return { task:{ ...task, project_cwd:resolve(task.project_cwd) }, plan };
      return { rejected:`task.project_cwd must equal the configured writerWorkspacePath (${runFolder}) or a git repository inside it` };
    }
    const fixed = { ...task, project_cwd:runFolder };
    // The folder of the task's files alone: a check run elsewhere must not hide the repository (drill nogit_repo 2026-10-27).
    const folder = commonTaskFolder({ ...fixed, verification:[] });
    if (!folder || !await services.isLiveFolder(runId, hostId, runFolder)) return { task:fixed, plan };
    const repo = await repoOf(resolve(runFolder, folder));
    const moved = repo ? rerootTask(fixed, repo) : null;
    if (repo && !moved && rerootTask({ ...fixed, verification:[] }, repo)) {
      // Every file is in the repository, so the task cannot work in the folder without git (one writer, no commit, files left untracked in the repository):
      // a check whose cwd lies outside it cannot run in the repository's worktree, and the PM puts it inside.
      return { rejected:`every file of this task is inside the git repository ${repo} of ${runFolder}, so the task works there (its own worktree, merged into its main), but a verification check has its cwd outside it. Set each check's cwd to ${resolve(runFolder, repo)} and write its command with paths relative to that repository (not ${repo}/...)` };
    }
    if (!repo || !moved) return { task:fixed, plan };
    ctx.log(`Lane Pilot: task ${task.id} works in the repository ${repo} of ${runFolder} (its own worktree and merge, not the folder without git)`);
    return { task:moved.task, plan:planWithOutsideReads(plan, moved.outsideReads), movedInto:repo };
  }

  /** `criticCodeDefault`: this task's value of `critic.code.default_for_risk`, over the project's (the bench toggles the code critic per arm with it). */
  async function dispatchWriter(args:{threadId:string; projectId:string; task?:TaskV2; plan?:string; baseRef?:string; objective?:string; requireObjective?:boolean; criticCodeDefault?:CodeCriticDefault; birth?:BirthKind}): Promise<Record<string,unknown>> {
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
    if (args.objective) setRunObjective(db, runId, args.objective);
    if (listTaskKinds(db, runId).includes("cli")) {
      throw new Error("V1: BB writer cannot join a CLI run-controller run");
    }
    const taskId = args.task ? freeTaskId(db, args.task.id) : id("lptask");
    const prepared = args.task ? { ...args.task, id:taskId } : buildTask(runConfig, taskId);
    let canonicalPlan = args.plan ?? prepared.objective;
    if (canonicalPlan.trim().length === 0) throw new Error("canonical plan must be non-empty");
    const valid = validateTaskV2(prepared);
    if (!valid.ok) throw new Error(`task-v2 invalid: ${valid.errors.join("; ")}`);
    const placed = await placeTask(runId, config.hostId, workspacePath, valid.task, canonicalPlan);
    if ("rejected" in placed) return { runId, state:"rejected", reason:placed.rejected, unapplied:[{ key:"task.project_cwd", reason:placed.rejected }] };
    const task = placed.task;
    canonicalPlan = placed.plan;
    // The checkout this task works in: the run's folder, or the git repository inside it the task moved into.
    const taskBase = task.project_cwd;
    const taskConfig = { ...runConfig, writerWorkspacePath:taskBase };
    const movedNote = placed.movedInto ? `mode repository: every path of this task is inside the git repository ${placed.movedInto}, so the task works there: its paths are now relative to ${taskBase}, the writer gets its own worktree of that repository, and accepted work is merged into its main as a commit (not the live folder).` : null;
    // The PM sending the same task again (its call ended «terminated» while the stages went on) gets the task it already has.
    const duplicate = args.task ? findLiveDuplicate(runId, args.task.id, task, canonicalPlan) : null;
    if (duplicate) return duplicate;
    // The same task sent again after its queued attempt was canceled (a replan) is that task and attempt, not a new one.
    const revived = args.task && !isMainfixTask(args.task.id) ? reviveCanceledTask({ ctx, services, live:liveDispatches,
      sameWork:(storedId, contract) => canonicalJson(contract) === canonicalJson({ ...task, id:storedId }) && sha256(getTaskPlan(db, storedId) ?? "") === sha256(canonicalPlan) },
    { projectId:args.projectId, runId, requestedId:args.task.id, pmThreadId:args.threadId, config:taskConfig, task, plan:canonicalPlan }) : null;
    if (revived) return revived;
    // A task is one writer session that restarts itself after a machinery fault: sending another member of its family
    // (`<id>.N`) while one runs or is parked would start a second writer on the same work.
    const inProgress = args.task && !isMainfixTask(args.task.id) ? await runningFamilyMember(args.projectId, args.task.id) : null;
    if (inProgress) {
      const hint = `${inProgress.taskId} of the same task is ${inProgress.parked ? "parked and restarts by itself" : "running"}: use lane_pilot_update_task / lane_pilot_answer_writer; redispatch only to change the contract, and cancel it first with lane_pilot_cancel_task`;
      return { ok:false, error:{ code:"task_in_progress", retryable:false, sideEffects:"none", hint }, runningTaskId:inProgress.taskId, hint };
    }
    // A family the wall ladder ended in the backlog is not sent again; one whose hunters found the ask itself wrong is not sent again unchanged.
    const walled = args.task && !isMainfixTask(args.task.id) ? services.wall?.dispatchGuard({ runId, family:taskFamily(args.task.id), task, plan:canonicalPlan }) ?? null : null;
    if (walled) return { ok:false, error:{ code:"wall_stop", retryable:false, sideEffects:"none", hint:walled }, hint:walled };
    // A fourth try on a topic the run's earlier tasks already worked on (the same file patched, the same test red again) is not sent:
    // the machine puts the whole picture to its hunters and the backlog first (Vampirism Fire 2026-10: nine runner patches, one flaky test through eight tasks).
    // The topic then stays closed to the PM's tasks, a workflow's tasks and the mainfixes alike: one budget per incident whoever sends the task.
    const looped = args.task && ["pm", "workflow"].includes(args.birth ?? "pm") ? await topicLoopGuard(db, runId, task, { wall:services.wall, projectId:args.projectId, pmThreadId:args.threadId }) : null;
    if (looped) return { ok:false, error:{ code:"topic_loop", retryable:false, sideEffects:"none", hint:looped }, hint:looped };
    // Contract lint: every contract mistake a helper or writer would only trip over later goes back to the PM now,
    // in one message with the fix, before a task or an attempt exists.
    const lint = await lintTask(args.projectId, runId, task, taskBase, config.hostId);
    // The queue the task joins, said once in the answer: which open tasks hold it and on what, and how to cut the batch if three own one path.
    const batchAdvice = batchAdviceFor(db, args.projectId, task);
    const withAdvice = (reply:Record<string,unknown>): Record<string,unknown> => batchAdvice.length && reply.state === "queued" ? { ...reply, batchAdvice } : reply;
    // The run's objective (the Tasks board groups by it) comes with the PM's first dispatch; Lane Pilot's own dispatches (mainfix, workflows) need none.
    const noObjective:LintFinding[] = args.requireObjective && !getRunObjective(db, runId)
      ? [{ code:"objective_missing", message:"objective is missing: this run has none yet; add objective to this first dispatch, one phrase in the language the owner writes in saying what the whole batch is for (later dispatches may leave it out)" }] : [];
    if (lint.errors.length || noObjective.length) return lintReply(runId, [...lint.errors, ...noObjective]);
    // Spend reserve: the run's token budget must still hold this task's appetite after the appetites of its open tasks.
    const budgetNow = services.runBudgets.get(runId)?.snapshot();
    if (budgetNow?.limits.maxTokens && task.appetite?.tokens) {
      const openAppetites = listOpenAttempts(db).filter((row) => row.run_id === runId).map((row) => Number((getTask(db, row.task_id)?.contract as { appetite?: { tokens?: number } } | undefined)?.appetite?.tokens ?? 0));
      // Best-of-3 (quality_mode full + writer.best_of) runs three candidates: the reserve holds all of them.
      const dispatchSettings = loadProjectSettings(db, args.projectId, getRunSettingsScopes(db, runId));
      const bestOf = resolveBestOf(dispatchSettings, resolveQualityMode(task, dispatchSettings[QUALITY_MODE_SETTING]));
      const reserve = spendReserve({ budgetTokens:budgetNow.limits.maxTokens, spentTokens:budgetNow.tokens, openAppetites, appetite:reserveAppetite(task.appetite.tokens, bestOf) });
      if (!reserve.ok) return lintReply(runId, [{ code:"spend_reserve", message:`spend reserve: ${reserve.why}; lower the appetite, wait for an open task, or raise the run's budget` }]);
    }
    // The pipeline runs only on the workflow engine: when the engine cannot take it, nothing is created and the PM is told so. The warning is a wall entry (the journal reads the plugin log).
    const unavailable = pipelineUnavailable(services.workflowEngine);
    if (unavailable) {
      bb.log.warn(`Lane Pilot dispatch of ${taskId} refused: engine_unavailable: ${unavailable}`);
      const hint = `the task pipeline runs on the workflow engine and it cannot start now (${unavailable}); nothing was created. Send the task again in a minute; if it repeats, tell the owner.`;
      return { ok:false, error:{ code:"engine_unavailable", retryable:true, sideEffects:"none", hint }, hint };
    }
    createTask(db, { id:taskId, runId, kind:"bb", contract:task, birth:args.birth ?? "pm" });
    await saveCriticCodeDefault(bb.storage.kv as never, taskId, args.criticCodeDefault);
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
    // jgrep-style hint: the test files that cover this task's owns_paths — name and import links in code, Jev on the
    // rest. A hint in the reply only; the contract's verification commands never change on their own.
    const testHintPromise = (async (): Promise<string> => {
      try {
        const ls = await runOnHost(host, { hostId:config.hostId, cwd:task.project_cwd, command:"git ls-files", timeoutSec:20, timeoutMs:25_000 }).catch(() => null);
        if (!ls || ls.exitCode !== 0 || typeof ls.stdout !== "string") return "";
        const readFile = async (path:string): Promise<string | null> => {
          const file = await host.call("readBoundedFile", { requestedHostId:config.hostId, projectCwd:task.project_cwd, relativePath:path, offset:0, maxLines:80 }, { hostId:config.hostId, timeoutMs:10_000 }).catch(() => null);
          return typeof file?.content === "string" ? file.content : null;
        };
        return testHintLine(await suggestTests(jev(), { changedFiles:task.owns_paths, repoFiles:ls.stdout.split("\n").filter(Boolean), readFile }, { projectId:args.projectId, runId, subject:taskId }));
      } catch { return ""; }
    })();
    const pendingReply = (): Record<string,unknown> => ({ runId, taskId, attemptId, writerThreadId:null, state:"queued", stagesPending:true, stages:listStageReceipts(db, runId, taskId),
      note:"pm-read and plan critique are still running; the writer starts by itself once they pass. Poll lane_pilot_wait_writer or end your turn; Lane Pilot sends you the results. Do not send the task again: the same id and contract returns this task." });
    // The pipeline is a workflow run (workflows/lp-task-pipeline.json, executors in dispatch-workflow.ts); there is no other path.
    const runViaEngine = async (): Promise<Record<string,unknown>> => {
      let started: ReturnType<typeof startDispatchRun>;
      try {
        started = startDispatchRun(services.workflowEngine, { ctx, services, threadId:args.threadId, projectId:args.projectId, baseRef:args.baseRef, runId, taskId, attemptId,
          config, runConfig:taskConfig, workspacePath:taskBase, task, plan:canonicalPlan, lintWarnings:[...lint.warnings.map((warning) => warning.message), ...(movedNote ? [movedNote] : [])] });
      } catch (cause) {
        // The engine took the dispatch after the early check and then refused it: the attempt ends blocked, which is a wall entry like any failed attempt.
        throw new Error(`engine_unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return dispatchReply(await started.done) ?? pendingReply();
    };
    liveDispatches.add(attemptId);
    const work = runViaEngine()
      .catch((cause): Record<string,unknown> => failDispatch(runId, taskId, attemptId, canonicalPlan, cause))
      .finally(() => liveDispatches.delete(attemptId));
    // Stages that finish within the budget answer as before; slower ones go on in the background and the PM polls.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early = await Promise.race([work, new Promise<null>((done) => { timer = setTimeout(() => done(null), dispatchAnswerMs()); })]);
    clearTimeout(timer);
    const testHint = await testHintPromise.catch(() => "");
    const replyWithHint = (reply:Record<string,unknown>): Record<string,unknown> => testHint ? { ...reply, testHint } : reply;
    if (early) return replyWithHint(withAdvice(early));
    return replyWithHint(withAdvice(pendingReply()));
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

  /** The task's pipeline is still open and its browser check (qa_cases and qa_url) has no verdict yet. */
  const qaRunsInGraph = (runId:string, taskId:string):boolean => {
    if (!taskQaPlan(taskV2Schema.safeParse(getTask(db, taskId)?.contract).data)) return false;
    if (listStageReceipts(db, runId, taskId).some((row) => row.stageId === "browser-qa" && ["passed", "failed", "blocked", "skipped"].includes(row.state))) return false;
    return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline' AND link_run_id=? AND link_task_id=? AND status IN ('running','waiting')").get(runId, taskId));
  };

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
    let qaInGraph = false;
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
          await new Promise((resolve) => setTimeout(resolve, pollPause(100)));
          continue;
        }
        // A task with qa_cases and qa_url has its browser check run by its own graph right after acceptance: the task is not done before the verdict.
        if ([...latestByTask.values()].some((attempt) => attempt.state === "accepted" && qaRunsInGraph(args.runId, attempt.task_id))) {
          qaInGraph = true;
          await new Promise((resolve) => setTimeout(resolve, pollPause(500)));
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
        // A blocked task says who holds it and when to look again, so the PM can ask the holder.
        const blockedBy = (await Promise.all([...latestByTask.values()].filter((attempt) => attempt.state === "blocked")
          .map(async (attempt) => { const found = await loadBlockedBy(bb.storage.kv, attempt.id); return found ? { taskId:attempt.task_id, ...found } : null; })))
          .filter((row) => row !== null);
        const nudged = await countRunNudges(bb.storage.kv, (listedRun?.attempts ?? []).map((row) => row.id));
        const next = [...latestByTask.values()].filter((attempt) => attempt.state !== "accepted")
          .map((attempt) => ({ taskId:attempt.task_id, state:attempt.state, next:`${nextStep(attempt.state, attempt.reason)}${folderLockNote(attempt)}` }));
        // quality_mode=full: an accepted task that carries qa_cases still owes its browser check. A task with qa_url has it run by its own graph.
        for (const attempt of latestByTask.values()) {
          if (attempt.state !== "accepted") continue;
          const contract = taskV2Schema.safeParse(getTask(db, attempt.task_id)?.contract);
          if (!contract.success || !browserQaRequired(resolveQualityMode(contract.data, settings[QUALITY_MODE_SETTING]), contract.data)) continue;
          const verdict = listStageReceipts(db, args.runId, attempt.task_id).find((row) => row.stageId === "browser-qa");
          if (verdict?.state === "passed") continue;
          if (taskQaPlan(contract.data)) {
            next.push({ taskId:attempt.task_id, state:"accepted", next: verdict && ["failed", "blocked", "skipped"].includes(verdict.state)
              ? `quality_mode=full: the browser check of this task's graph ${verdict.state}${verdict.reason ? ` (${verdict.reason.slice(0, 400)})` : ""}; the task is not done until a check passes: fix what it found and dispatch a follow-up task with the same qa_url and qa_cases`
              : `quality_mode=full: the task's graph ended without a browser verdict (see its lp.browser-qa workflow run); run lane_pilot_helpers {action:"browser_qa"} for this task with qa_url ${contract.data.qa_url}; the task is not done until the check passes` });
            continue;
          }
          next.push({ taskId:attempt.task_id, state:"accepted", next:`quality_mode=full: run lane_pilot_helpers {action:"browser_qa"} for this task with its qa_cases (${contract.data.qa_cases!.join("; ").slice(0, 600)}); the task is not done until the check passes` });
        }
        return { runId:args.runId, state, receipt, stages:listStageReceipts(db, args.runId), nudged, ...(reasons.length ? { reason:reasons.join("; ") } : {}),
          ...(next.length ? { next } : {}),
          ...(blockedBy.length ? { blockedBy } : {}) };
      }
      await new Promise((resolve) => setTimeout(resolve, pollPause(500)));
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
      ...(qaInGraph
        ? { message:"Задача принята, её граф ещё проверяет страницу в браузере (qa_url). Вызови lane_pilot_wait_writer ещё раз с тем же runId." }
        : writerThreadId
        ? { message:"Писатель ещё работает. Вызови lane_pilot_wait_writer ещё раз с тем же runId." }
        : { writerStarted:false, message:"Писатель ещё не создан. Старт не закончен или не прошёл. Вызови lane_pilot_wait_writer ещё раз с тем же runId." }),
    };
  }

  /**
   * Starts again the stages of a dispatch a reload interrupted, for the same task and attempt. A Lane Pilot deploy reloads
   * the plugin, and the dispatch pipeline lives in memory: a reload during pm-read (minutes of a helper turn) ended the
   * dispatch, and start-up recovery blocked the attempt «send the task again» (SelfyStudio 2026-10-08/12/13, each within
   * 40 s of a release). Everything a dispatch needs is stored when its attempt exists: the placed contract, the plan, the
   * run's PM thread and workspace, and the PM's baseRef in the pipeline run's inputs. The helper stages start from
   * nothing (a passed pm-read is kept) under a new pipeline key. `live`: this instance runs the dispatch itself.
   */
  async function resumeDispatch(attemptId:string): Promise<{ resumed:true; live?:true } | { resumed:false; why:string }> {
    if (liveDispatches.has(attemptId)) return { resumed:true, live:true };
    const engine = services.workflowEngine;
    if (!engine) return { resumed:false, why:"the workflow engine is off" };
    const attempt = getAttempt(db, attemptId);
    if (!attempt || attempt.state !== "queued" || attempt.thread_id || attempt.reason !== DISPATCH_STAGES_PENDING) return { resumed:false, why:"the attempt no longer waits for its stages" };
    const key = dispatchRunKey(attemptId);
    const pipelines = db.prepare("SELECT inputs_json FROM lane_pilot_wf_run WHERE idem_key=? OR idem_key LIKE ? ORDER BY created_at")
      .all(key, `${key}:resume-%`) as Array<{ inputs_json:string }>;
    if (!pipelines.length) return { resumed:false, why:"its dispatch left no pipeline record" };
    if (pipelines.length > MAX_DISPATCH_RESUMES) return { resumed:false, why:`reloads interrupted it ${pipelines.length} times` };
    // The base is taken once per task; one already taken means the stages were past it, a moment before the writer.
    if (getTaskGitBase(db, attempt.task_id)) return { resumed:false, why:"its ownership base was already taken" };
    const run = getRun(db, attempt.run_id);
    const stored = getTask(db, attempt.task_id);
    const parsed = stored?.kind === "bb" ? taskV2Schema.safeParse(stored.contract) : null;
    const plan = getTaskPlan(db, attempt.task_id);
    const config = run ? await configForRun(run.project_id, run) : null;
    if (!run?.pm_thread_id || !run.writer_workspace_path || !parsed?.success || !plan || !config) return { resumed:false, why:"its run or task can no longer be read" };
    let inputs: Record<string, unknown> = {};
    try { inputs = JSON.parse(pipelines.at(-1)!.inputs_json || "{}") as Record<string, unknown>; } catch { /* no baseRef */ }
    const task = parsed.data;
    const taskConfig = { ...config, writerWorkspacePath:task.project_cwd };
    await resetHelperStages(db, (threadId) => bb.sdk.threads.stop({ threadId }), { runId:run.id, taskId:attempt.task_id });
    let started: ReturnType<typeof startDispatchRun>;
    try {
      started = startDispatchRun(engine, { ctx, services, threadId:run.pm_thread_id, projectId:run.project_id,
        ...(typeof inputs.baseRef === "string" ? { baseRef:inputs.baseRef } : {}), runId:run.id, taskId:attempt.task_id, attemptId,
        config, runConfig:taskConfig, workspacePath:task.project_cwd, task, plan, lintWarnings:[] }, pipelines.length);
    } catch (cause) {
      return { resumed:false, why:`the workflow engine could not start it: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    liveDispatches.add(attemptId);
    void started.done.then(dispatchReply)
      .catch((cause) => { if (!ctx.isDisposed()) failDispatch(run.id, attempt.task_id, attemptId, plan, cause); })
      .finally(() => liveDispatches.delete(attemptId));
    bb.log.info(`Lane Pilot started the dispatch of ${attempt.task_id} again after a reload (${pipelines.length} of ${MAX_DISPATCH_RESUMES})`);
    return { resumed:true };
  }

  return { readWriterWorkspaceFile, dispatchWriter, waitWriter, resumeDispatch };
}
