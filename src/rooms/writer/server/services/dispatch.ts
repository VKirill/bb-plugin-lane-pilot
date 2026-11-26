import { beginRunAdmission, latestRunForPmThread } from "../../../storage";
import { recordStage, resetHelperStages, setRunHalted } from "../../../runs/server";
import type { VerificationGatePort } from "../../../contracts/integration-gate";
import type { IsTaskSatisfied } from "../../../contracts";
import type { StageHelperSettings, WorkflowEngineApi } from "../../../platform/server";
import { DISPATCH_STAGES_PENDING } from "../../../runs";
import { isTerminalAttemptState, taskV2Schema } from "../../../contracts";
import type { TaskV2 } from "../../../contracts";
import type { CodeCriticDefault } from "../../../contracts/task-enums";
import { saveCriticCodeDefault } from "../repositories/critic-override";
import { wfRunInputsByKey } from "@lane-pilot/workflow-engine";
import { TASK_HOME_EXCLUDE, bbTaskFileIo, getRunObjective, setRunObjective, createAttempt, createTask, freeTaskId, getAttempt, getRun, getRunSettingsScopes, getTask, getTaskPlan, listOpenAttempts, listRunTaskRows, listStageReceipts, listTaskKinds, listUnreportedTaskOutcomes, loadProjectSettings, markTaskOutcomesReported, noteToldPmDirectly, saveTaskPlan, setRunState, transitionAttempt } from "../../../storage";
import { birthGates, isMainfixTask, landingWordAsked, ownerWordsMode, spendReserve, taskStepEvidence, type BirthKind } from "../../../tasks";
import { taskFamily } from "@lane-pilot/contracts";
import { validateTaskV2 } from "../../../tasks";
import { createTaskLinter, lintReply, ownerSaidNo, sha256 } from "../../../tasks/server";
import type { LintFinding } from "../../../tasks/server";
import { bestEffort, id, parseJsonOr, stringAt, valueAt } from "@lane-pilot/kit";
import { dispatchReply, dispatchRunKey, startDispatchRun, pipelineUnavailable, type DispatchRuntime } from "./dispatch-workflow-ops";
import { suggestTests, testHintLine } from "../../../verification";
import { appendExcludeCommand } from "../../../worktree";
import { writeDispatchHome } from "./task-home";
import { canonicalJson, batchAdviceFor, baselineRedGuard, recoveryGuard, topicLoopGuard } from "./dispatch-guards";
import { createPlacementReader, placementDriftReason, placementMatches, type PreparedPlacement } from "./placement";
import { ownerLastWroteAt } from "../../../critique/server";
import { reviveCanceledTask } from "./revive";
import { stampForecastModel } from "../../../forecast";
import type { ServerCore } from "../../../contracts/server";
import { runOnHost } from "@lane-pilot/host-calls";
import type { StabilityPort } from "../../../contracts";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStartApi } from "./start";
import type { WriterStateApi } from "./state";
import type { BaselineApi } from "../../../baseline/server";
import { createDispatchPlacement } from "./dispatch-placement";
import { createWaitWriter } from "./wait-writer";
/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  stageHelperSettings: StageHelperSettings;
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  baseline: BaselineApi;
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  isTaskSatisfied: IsTaskSatisfied;
  runBudgets: WriterStateApi["runBudgets"];
  stability: StabilityPort;
  resolveIntegrationGate: VerificationGatePort;
  startWriterTask: WriterStartApi["startWriterTask"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

/** How long a dispatch waits for its stages before it answers «queued» and lets them go on in the background. */
const dispatchAnswerMs = () => {
  const set = Number(process.env.LANE_PILOT_DISPATCH_ANSWER_MS);
  return process.env.LANE_PILOT_DISPATCH_ANSWER_MS && Number.isFinite(set) && set >= 0 ? set : 15_000;
};

/** How often a dispatch starts again after reloads before its attempt is blocked and the PM sends the task again. */
export const MAX_DISPATCH_RESUMES = 2;


export function createWriterDispatch(ctx: ServerCore, services: Services) {
  const { bb, configForRun, db, ensureRunScopes, host } = ctx;
  const lintTask = createTaskLinter(ctx, services);
  /** Attempts whose pm-read / plan critique this instance is running now: start-up recovery leaves them alone. */
  const liveDispatches = new Set<string>();

  /** A dispatch whose stages threw: the attempt is blocked and its writer stages fail. */
  const { failDispatch, readWriterWorkspaceFile, findLiveDuplicate, findContentDuplicate, runningFamilyMember, placeTask } = createDispatchPlacement({ ctx, db, services });
  const { waitWriter } = createWaitWriter({ ctx, db, services });
  async function dispatchWriter(args:{threadId:string; projectId:string; task?:TaskV2; plan?:string; baseRef?:string; objective?:string; requireObjective?:boolean; criticCodeDefault?:CodeCriticDefault; birth?:BirthKind}, preplaced?:PreparedPlacement): Promise<Record<string,unknown>> {
    const preparingRun = latestRunForPmThread(db, args.threadId);
    if (!preparingRun) throw new Error("PM thread has no Lane Pilot run");
    const releaseAdmission = beginRunAdmission(db, preparingRun.id);
    try {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm") throw new Error("caller is not a Lane Pilot PM thread");
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) throw new Error("PM thread has no lanePilotRunId");
    if (runId !== preparingRun.id) throw new Error("PM run changed during admission; retry from the current binding");
    // Settings of the section this run works in, read by every stage below.
    await ensureRunScopes(runId);
    const run = getRun(db, runId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId) throw new Error("run does not belong to this PM thread and project");
    // Only an actual new dispatch resumes an owner-stopped run; workspace reads never do.
    await setRunHalted(bb.storage.kv as never, runId, false);
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
    if (!args.task) throw new Error("dispatch_writer needs a task contract (a task-v2 JSON); there is no default task");
    const taskId = freeTaskId(db, args.task.id);
    const prepared = { ...args.task, id:taskId };
    let canonicalPlan = args.plan ?? prepared.objective;
    if (canonicalPlan.trim().length === 0) throw new Error("canonical plan must be non-empty");
    const valid = validateTaskV2(prepared);
    if (!valid.ok) throw new Error(`task-v2 invalid: ${valid.errors.join("; ")}`);
    if (preplaced && !placementMatches(preplaced,{ runId,hostId:config.hostId,runFolder:workspacePath,taskId,task:valid.task,plan:canonicalPlan })) return { runId, state:"rejected", reason:placementDriftReason, unapplied:[{ key:"task.project_cwd", reason:placementDriftReason }] };
    const placed = preplaced?.placement ?? await placeTask(runId, config.hostId, workspacePath, valid.task, canonicalPlan);
    if ("rejected" in placed) return { runId, state:"rejected", reason:placed.rejected, unapplied:[{ key:"task.project_cwd", reason:placed.rejected }] };
    // The forecast belongs to the PM that made it (SMA k_lib_modelver): the run's own pm model is stamped, whatever the PM sent.
    const task = stampForecastModel(placed.task, config.pmProviderId && config.pmModel ? `${config.pmProviderId}/${config.pmModel}` : null);
    canonicalPlan = placed.plan;
    // The checkout this task works in: the run's folder, or the git repository inside it the task moved into.
    const taskBase = task.project_cwd;
    const taskConfig = { ...runConfig, writerWorkspacePath:taskBase };
    const movedNote = placed.movedInto ? `mode repository: every path of this task is inside the git repository ${placed.movedInto}, so the task works there: its paths are now relative to ${taskBase}, the writer gets its own worktree of that repository, and accepted work is merged into its main as a commit (not the live folder).` : null;
    // The PM sending the same task again (its call ended «terminated» while the stages went on) gets the task it already has.
    const scopeNote = placed.repoScope ? `repo_scope: this task of the section ${placed.repoScope.section}/ also changes files outside it${placed.repoScope.outside.length ? ` (${placed.repoScope.outside.join(", ")})` : ""}, in the same repository, so it works at the repository root ${placed.repoScope.root}: its paths are now relative to the root, checks still run in the section's folder, and plan critique and code critic are strict for it. Tell the owner which files outside the section it touches.` : null;
    const duplicate = args.task ? findLiveDuplicate(runId, args.task.id, task, canonicalPlan) : null;
    if (duplicate) return duplicate;
    const contentDuplicate = args.task ? findContentDuplicate(runId, args.task.id, task, canonicalPlan) : null;
    if (contentDuplicate) return contentDuplicate;
    // The same task sent again after its queued attempt was canceled (a replan) is that task and attempt, not a new one.
    const revived = args.task && !isMainfixTask(args.task.id) ? reviveCanceledTask({ ctx, services, live:liveDispatches,
      sameWork:(storedId, contract) => canonicalJson(contract) === canonicalJson({ ...task, id:storedId }) && sha256(getTaskPlan(db, storedId) ?? "") === sha256(canonicalPlan),
      startRevived:(rev) => {
        if (!pipelineUnavailable(services.workflowEngine)) {
          startDispatchRun(services.workflowEngine, { ctx, services, threadId:args.threadId, projectId:args.projectId, baseRef:args.baseRef, runId,
            taskId:rev.taskId, attemptId:rev.attemptId, config, runConfig:taskConfig, workspacePath:taskBase, task:rev.task, plan:rev.plan,
            lintWarnings:[...(movedNote ? [movedNote] : []), ...(scopeNote ? [scopeNote] : [])] }, Date.now());
        } else {
          services.startWriterTask({ projectId:args.projectId, runId, taskId:rev.taskId, firstAttemptId:rev.attemptId, pmThreadId:args.threadId, config:taskConfig, task:rev.task, plan:rev.plan });
        }
      } },
    { projectId:args.projectId, runId, requestedId:args.task.id, pmThreadId:args.threadId, config:taskConfig, task, plan:canonicalPlan }) : null;
    if (revived) return revived;
    // A task is one writer session: sending another member of its family (`<id>.N`) while one runs would start a second
    // writer on the same work.
    const inProgress = args.task && !isMainfixTask(args.task.id) ? await runningFamilyMember(args.projectId, args.task.id) : null;
    if (inProgress) {
      const hint = `${inProgress.taskId} of the same task is running: use lane_pilot_update_task / lane_pilot_answer_writer; redispatch only to change the contract, and cancel it first with lane_pilot_cancel_task`;
      return { ok:false, error:{ code:"task_in_progress", retryable:false, sideEffects:"none", hint }, runningTaskId:inProgress.taskId, hint };
    }
    // Nothing of the family is sent again while a member's recovery is unfinished (SMA ac_recovery).
    const recovering = args.task && !isMainfixTask(args.task.id) ? recoveryGuard(db, runId, args.task.id) : null;
    if (recovering) return { ok:false, error:{ code:"recovery_unfinished", retryable:false, sideEffects:"none", hint:recovering }, hint:recovering };
    // A red baseline asks a person (SMA ac_baseline_red): while the owner's item is open the family is not sent again. The
    // item exists only on owner.words=on; on the default the PM narrows the check or widens owns_paths and sends again.
    const baseRed = args.task && !isMainfixTask(args.task.id)
      ? baselineRedGuard(db, runId, args.task.id, ownerWordsMode(loadProjectSettings(db, args.projectId, getRunSettingsScopes(db, runId))) === "on") : null;
    if (baseRed) return { ok:false, error:{ code:"baseline_red", retryable:false, sideEffects:"none", hint:baseRed }, hint:baseRed };
    // Work already decided (SMA cg_claim_refusal): the owner said no to this family — the row is closed before a writer,
    // a critic or a check of it is paid for. A new yes (lane_pilot_queue word) opens it again.
    if (args.task && !isMainfixTask(args.task.id)) {
      const saidNo = landingWordAsked(loadProjectSettings(db, args.projectId, getRunSettingsScopes(db, runId)), task.risk, taskStepEvidence(task))
        ? await ownerSaidNo(bb.storage.kv as never, runId, taskFamily(args.task.id)) : null;
      if (saidNo !== null) {
        const hint = `the owner said no to ${taskFamily(args.task.id)}: ${saidNo}. Record a new yes with lane_pilot_queue {action:"word", taskId:"${args.task.id}", decision:"yes", text} before sending the work again`;
        return { ok:false, error:{ code:"owner_said_no", retryable:false, sideEffects:"none", hint }, hint };
      }
    }
    // A fourth try on a topic the run's earlier tasks already worked on (the same file patched, the same test red again) is not sent:
    // the machine puts the whole picture to its hunters and the backlog first (Vampirism Fire 2026-10: nine runner patches, one flaky test through eight tasks).
    // The topic then stays closed to the PM's tasks, a workflow's tasks and the mainfixes alike: one budget per incident whoever sends the task.
    // The birth kind chooses the gates: the topic-loop guard protects against the PM's repeated tries, not the machine's own issues.
    const redoneBirth = args.birth === "redo" ? (listRunTaskRows(db, runId).find((row) => row.id === taskFamily(task.id))?.birth ?? null) : null;
    const looped = args.task && birthGates(args.birth ?? "pm", redoneBirth).topicLoop ? await topicLoopGuard(db, runId, task, { projectId:args.projectId, pmThreadId:args.threadId, ownerSpokeAt:await ownerLastWroteAt({ bb, threadId:args.threadId }) }) : null;
    if (looped) return { ok:false, error:{ code:"topic_loop", retryable:false, sideEffects:"none", hint:looped }, hint:looped };
    // Contract lint: every contract mistake a helper or writer would only trip over later goes back to the PM now,
    // in one message with the fix, before a task or an attempt exists.
    const lint = await lintTask(args.projectId, runId, task, taskBase, config.hostId, args.birth);
    // The queue the task joins, said once in the answer: which open tasks hold it and on what, and how to cut the batch if three own one path.
    const batchAdvice = batchAdviceFor(db, args.projectId, runId, task);
    const withAdvice = (reply:Record<string,unknown>): Record<string,unknown> => {
      return batchAdvice.length && reply.state === "queued" ? { ...reply, batchAdvice } : reply;
    };
    // The run's objective (the Tasks board groups by it) comes with the PM's first dispatch; Lane Pilot's own dispatches (mainfix, workflows) need none.
    const noObjective:LintFinding[] = args.requireObjective && !getRunObjective(db, runId)
      ? [{ code:"objective_missing", message:"objective is missing: this run has none yet; add objective to this first dispatch, one phrase in the language the owner writes in saying what the whole batch is for (later dispatches may leave it out)" }] : [];
    if (lint.errors.length || noObjective.length) return lintReply(runId, [...lint.errors, ...noObjective]);
    // Spend reserve: the run's token budget must still hold this task's appetite after the appetites of its open tasks.
    const budgetNow = services.runBudgets.get(runId)?.snapshot();
    // A run priced in tokens (run.max_tokens) admits no task whose price is unknown: the spend reserve could not hold it.
    if (budgetNow?.limits.maxTokens && !task.appetite?.tokens) {
      return lintReply(runId, [{ code:"price_unknown", message:"the run has run.max_tokens, so every task names its price: set appetite.tokens (a forecast of the tokens it will spend), then send it again" }]);
    }
    if (budgetNow?.limits.maxTokens && task.appetite?.tokens) {
      const openAppetites = listOpenAttempts(db).filter((row) => row.run_id === runId).map((row) => Number((getTask(db, row.task_id)?.contract as { appetite?: { tokens?: number } } | undefined)?.appetite?.tokens ?? 0));
      const reserve = spendReserve({ budgetTokens:budgetNow.limits.maxTokens, spentTokens:budgetNow.tokens, openAppetites, appetite:task.appetite.tokens });
      if (!reserve.ok) return lintReply(runId, [{ code:"spend_reserve", message:`spend reserve: ${reserve.why}; lower the appetite, wait for an open task, or raise the run's budget` }]);
    }
    // The pipeline runs only on the workflow engine: when the engine cannot take it, nothing is created and the PM is told so. The warning is a wall entry (the journal reads the plugin log).
    const unavailable = pipelineUnavailable(services.workflowEngine);
    if (unavailable) {
      bb.log.warn(`Lane Pilot dispatch of ${taskId} refused: engine_unavailable: ${unavailable}`);
      const hint = `the task pipeline runs on the workflow engine and it cannot start now (${unavailable}); nothing was created. Send the task again in a minute; if it repeats, tell the owner.`;
      return { ok:false, error:{ code:"engine_unavailable", retryable:true, sideEffects:"none", hint }, hint };
    }
    // The task's one home (docs/task-folder.md): its contract, the plan TEXT and a snapshot of the shared plan files the plan names, under
    // <task base>/.agents/tasks/<id>/. A failed write creates no task: the PM is told and sends it again.
    try {
      if (!await bestEffort(ctx.log, "task home live folder probe", services.isLiveFolder(runId, config.hostId, taskBase), false)) {
        await bestEffort(ctx.log, "task home exclude line", runOnHost(host, { hostId:config.hostId, cwd:taskBase, command:appendExcludeCommand(TASK_HOME_EXCLUDE), timeoutSec:30, timeoutMs:30_000 }), null);
      }
      await writeDispatchHome(db, bbTaskFileIo(bb as never, config.hostId, taskBase), { taskId, projectId:args.projectId, runId, basePath:taskBase, hostId:config.hostId, task, plan:canonicalPlan });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      bb.log.warn(`Lane Pilot dispatch of ${taskId} refused: task_home_write_failed: ${detail}`);
      const hint = `the task's home .agents/tasks/${taskId}/ could not be written in ${taskBase} (${detail}); nothing was dispatched. Send the task again; if it repeats, tell the owner.`;
      return { ok:false, error:{ code:"task_home_write_failed", retryable:true, sideEffects:"none", hint }, hint };
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
      noteToldPmDirectly(db, args.threadId, taskId);
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
        // No repo, no ls-files: a live folder gets no git call at all (the probe's answer is cached).
        if (await bestEffort(ctx.log, "writer live folder probe", services.isLiveFolder(runId, config.hostId, taskBase), false)) return "";
        const ls = await bestEffort(ctx.log, "writer git ls-files probe", runOnHost(host, { hostId:config.hostId, cwd:task.project_cwd, command:"git ls-files", timeoutSec:20, timeoutMs:25_000 }), null);
        if (!ls || ls.exitCode !== 0 || typeof ls.stdout !== "string") return "";
        const readFile = async (path:string): Promise<string | null> => {
          const file = await bestEffort(ctx.log, "writer test-hint file read", host.call("readBoundedFile", { requestedHostId:config.hostId, projectCwd:task.project_cwd, relativePath:path, offset:0, maxLines:80 }, { hostId:config.hostId, timeoutMs:10_000 }), null);
          return typeof file?.content === "string" ? file.content : null;
        };
        return testHintLine(await suggestTests({ changedFiles:task.owns_paths, repoFiles:ls.stdout.split("\n").filter(Boolean), readFile }));
      } catch (cause) { ctx.log(`writer ${taskId}: test hint skipped: ${cause instanceof Error ? cause.message : String(cause)}`); return ""; }
    })();
    const pendingReply = (): Record<string,unknown> => ({ runId, taskId, attemptId, writerThreadId:null, state:"queued", stagesPending:true, stages:listStageReceipts(db, runId, taskId),
      note:"pm-read and plan critique are still running; the writer starts by itself once they pass. Poll lane_pilot_wait_writer or end your turn; Lane Pilot sends you the results. Do not send the task again: the same id and contract returns this task." });
    const runtime: DispatchRuntime = { ctx, services, threadId:args.threadId, projectId:args.projectId, baseRef:args.baseRef, runId, taskId, attemptId,
      config, runConfig:taskConfig, workspacePath:taskBase, task, plan:canonicalPlan, lintWarnings:[...lint.warnings.map((warning) => warning.message), ...(movedNote ? [movedNote] : []), ...(scopeNote ? [scopeNote] : [])] };
    // The pipeline is a workflow run (workflows/lp-task-pipeline.json, executors in dispatch-workflow.ts); there is no other path.
    const runViaEngine = async (): Promise<Record<string,unknown>> => {
      let started: ReturnType<typeof startDispatchRun>;
      try {
        started = startDispatchRun(services.workflowEngine, runtime);
      } catch (cause) {
        // The engine took the dispatch after the early check and then refused it: the attempt ends blocked, which is a wall entry like any failed attempt.
        throw new Error(`engine_unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return dispatchReply(await started.done, runtime) ?? pendingReply();
    };
    liveDispatches.add(attemptId);
    const work = runViaEngine()
      .catch((cause): Record<string,unknown> => failDispatch(runId, taskId, attemptId, canonicalPlan, cause))
      .finally(() => liveDispatches.delete(attemptId));
    // Stages that finish within the budget answer as before; slower ones go on in the background and the PM polls.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early = await Promise.race([work, new Promise<null>((done) => { timer = setTimeout(() => done(null), dispatchAnswerMs()); })]);
    clearTimeout(timer);
    const testHint = await bestEffort(ctx.log, "writer test hint", testHintPromise, "");
    const replyWithHint = (reply:Record<string,unknown>): Record<string,unknown> => testHint ? { ...reply, testHint } : reply;
    if (early) {
      if (isTerminalAttemptState(String(early.state ?? ""))) {
        noteToldPmDirectly(db, args.threadId, taskId);
        const unreported = listUnreportedTaskOutcomes(db, 0).filter((o) => o.pmThreadId === args.threadId && o.taskId === taskId);
        if (unreported.length > 0) markTaskOutcomesReported(db, unreported, Date.now());
      }
      return replyWithHint(withAdvice(early));
    }
    return replyWithHint(withAdvice(pendingReply()));
    } finally { releaseAdmission(); }
  }

  /** Each task of the run touched in the last 3 hours, by its latest attempt, so blocked tasks surface while others still run. */
  async function resumeDispatch(attemptId:string): Promise<{ resumed:true; live?:true } | { resumed:false; why:string }> {
    if (liveDispatches.has(attemptId)) return { resumed:true, live:true };
    const engine = services.workflowEngine;
    if (!engine) return { resumed:false, why:"the workflow engine is off" };
    const attempt = getAttempt(db, attemptId);
    if (!attempt || attempt.state !== "queued" || attempt.thread_id || attempt.reason !== DISPATCH_STAGES_PENDING) return { resumed:false, why:"the attempt no longer waits for its stages" };
    const key = dispatchRunKey(attemptId);
    const pipelines = wfRunInputsByKey(db, key, `${key}:resume-%`).map((inputs_json) => ({ inputs_json }));
    if (!pipelines.length) return { resumed:false, why:"its dispatch left no pipeline record" };
    if (pipelines.length > MAX_DISPATCH_RESUMES) return { resumed:false, why:`reloads interrupted it ${pipelines.length} times` };
    // Ownership capture precedes baseline: a reload can still interrupt dispatch after it. The pipeline keeps the immutable base.
    const run = getRun(db, attempt.run_id);
    const stored = getTask(db, attempt.task_id);
    const parsed = stored?.kind === "bb" ? taskV2Schema.safeParse(stored.contract) : null;
    const plan = getTaskPlan(db, attempt.task_id);
    const config = run ? await configForRun(run.project_id, run) : null;
    if (!run?.pm_thread_id || !run.writer_workspace_path || !parsed?.success || !plan || !config) return { resumed:false, why:"its run or task can no longer be read" };
    let inputs: Record<string, unknown> = {};
    inputs = parseJsonOr(pipelines.at(-1)!.inputs_json || "{}", {}) as Record<string, unknown>;
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

  return { readWriterWorkspaceFile, dispatchWriter, preparePlacement:createPlacementReader(db, placeTask), waitWriter, resumeDispatch };
}

export type WriterDispatchApi = ReturnType<typeof createWriterDispatch>;
