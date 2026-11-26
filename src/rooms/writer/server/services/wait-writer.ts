import { WRITER_QA_STOP_AFTER_KEY } from "../../settings";
import type { openDatabase } from "../../../storage";
import { loadBlockedBy } from "../../../runs/server";
import { beginWriterWait } from "../../../platform/server";
import { isLiveDecision } from "../../models/live-folder";
import { taskV2Schema } from "../../../contracts";
import { QUALITY_MODE_SETTING, browserQaRequired, resolveQualityMode, qaRoute, qaStopAfter, taskQaPlan } from "../../../contracts/quality-mode";
import { wfLivePipelineRun } from "@lane-pilot/workflow-engine";
import { getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getRunWriterHost, getTask, listAttemptsUpdatedSince, listOpenAttempts, listRunsWithAttempts, listRunTaskRows, listStageReceipts, listTaskTerminalStates, loadProjectSettings, taskBasePath, transitionAttempt } from "../../../storage";
import { liveFolderLockNote, nextStep } from "../../../contracts/failure-class";
import { taskFamily } from "@lane-pilot/contracts";
import { bestEffort, pollPause, stringAt, valueAt } from "@lane-pilot/kit";
import { gateResolverFor, gateRunVerdict } from "../../../verification/server";
import { latestGateRunForTask } from "../../../storage";
import { parseIntegrationGateSettings } from "../../../contracts/integration-gate";
import { countRunNudges } from "./writer-silence";
import type { ServerCore } from "../../../contracts/server";
import type { Services } from "./dispatch";

export function createWaitWriter({ ctx, db: _db, services }: { ctx: ServerCore; db: ReturnType<typeof openDatabase>; services: Services }) {
  void _db;
  const { bb, db, getThreadBounded, refreshRun } = ctx;
  function recentTaskSummary(runId:string) {
    const since = Date.now() - 3 * 3600_000;
    const rows = listAttemptsUpdatedSince(db, runId, since);
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
    return wfLivePipelineRun(db, runId, taskId);
  };

    /** The integration gate's verdict for an accepted task's merge: pending keeps the wait like QA until main's check finishes. */
  async function taskGateVerdict(runId:string, projectId:string, taskId:string): Promise<{ line:string; pending:boolean; failed:boolean }> {
    const row = latestGateRunForTask(db, projectId, taskId);
    if (row) return gateRunVerdict(row);
    const hostId = getRunWriterHost(db, runId);
    const basePath = taskBasePath(db, runId, taskId);
    if (!hostId || !basePath) return { line:"none configured", pending:false, failed:false };
    const gate = await bestEffort(ctx.log, "writer integration gate", gateResolverFor(ctx)({ runId, hostId, basePath,
      gate:parseIntegrationGateSettings(loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId))) }), null);
    return gate ? { line:"running", pending:true, failed:false } : { line:"none configured", pending:false, failed:false };
  }

  async function waitWriter(args:{threadId:string; projectId:string; runId:string; timeoutSec:number}): Promise<Record<string, unknown>> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:args.threadId });
    if (valueAt(metadata, "role") !== "pm" || stringAt(metadata, "lanePilotRunId") !== args.runId) {
      throw new Error("runId does not belong to this Lane Pilot PM thread");
    }
    const run = getRun(db, args.runId);
    if (!run || run.project_id !== args.projectId || run.pm_thread_id !== args.threadId) {
      throw new Error("run does not belong to this PM thread and project");
    }
    const endWait = beginWriterWait(args.threadId);
    try {
    const deadline = Date.now() + Math.min(240, Math.max(1, args.timeoutSec)) * 1000;
    let qaInGraph = false;
    let gateLines: Array<{ taskId:string; gate:string }> = [];
    let gatePending = false;
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
        if (wfLivePipelineRun(db, args.runId, attempt.task_id)) continue;
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
      const states = listTaskTerminalStates(db, args.runId);
      const PIPELINE_RETRYABLE = new Set(["provider_error", "validation_failed", "empty_output", "timeout", "spawn_rejected"]);
      const livePipelinePending = [...latestByTask.values()].some((attempt) =>
        PIPELINE_RETRYABLE.has(attempt.state) && wfLivePipelineRun(db, args.runId, attempt.task_id));
      const state = !livePipelinePending && states.length && states.every((item) => !["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(item))
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
        // «accepted» is the merge, not main's check: an accepted task whose integration gate is still out keeps the
        // wait like QA does (Astra F1). The verdict the PM reads comes with the answer: green on <sha> / red / not run / none.
        gateLines = [];
        gatePending = false;
        for (const attempt of latestByTask.values()) {
          if (attempt.state !== "accepted") continue;
          const verdict = await taskGateVerdict(args.runId, args.projectId, attempt.task_id);
          gateLines.push({ taskId:attempt.task_id, gate:verdict.line });
          if (verdict.pending) gatePending = true;
        }
        if (gatePending) {
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
            // writer.qa_stop_after 0 or off: the advice is what it always was, a follow-up. Otherwise (unset: 2; SMA k_wqa_route) the family's receipts route it.
            const stopAfter = qaStopAfter(settings[WRITER_QA_STOP_AFTER_KEY]);
            const failedVerdict = Boolean(verdict && ["failed", "blocked", "skipped"].includes(verdict.state));
            const family = stopAfter === null ? [] : listRunTaskRows(db, args.runId).filter((row) => taskFamily(row.id) === taskFamily(attempt.task_id));
            const qaReceipts = family.flatMap((row) => listStageReceipts(db, args.runId, row.id).filter((receipt) => receipt.stageId === "browser-qa"));
            const route = stopAfter !== null && verdict && failedVerdict ? qaRoute(qaReceipts, stopAfter) : null;
            const why = verdict?.reason ? ` (${verdict.reason.slice(0, 400)})` : "";
            next.push({ taskId:attempt.task_id, state:"accepted", next: !verdict || !failedVerdict
              ? `quality_mode=full: the task's graph ended without a browser verdict (see its lp.browser-qa workflow run); run lane_pilot_helpers {action:"browser_qa"} for this task with qa_url ${contract.data.qa_url}; the task is not done until the check passes`
              : route === "stop"
                ? `quality_mode=full: the browser check of this task's family failed ${qaReceipts.filter((receipt) => receipt.state === "failed").length} times${why}; writer.qa_stop_after=${stopAfter} is reached: stop and report to the owner — no further follow-up is offered`
                : route === "not_returnable"
                  ? `quality_mode=full: the browser check of this task's graph is ${verdict.state}${why}; the problem is the environment, not the code: repair it and re-run the check, do not dispatch a builder task`
                  : `quality_mode=full: the browser check of this task's graph ${verdict.state}${why}; the task is not done until a check passes: fix what it found and dispatch a follow-up task with the same qa_url and qa_cases` });
            continue;
          }
          next.push({ taskId:attempt.task_id, state:"accepted", next:`quality_mode=full: run lane_pilot_helpers {action:"browser_qa"} for this task with its qa_cases (${contract.data.qa_cases!.join("; ").slice(0, 600)}); the task is not done until the check passes` });
        }
        return { runId:args.runId, state, receipt, stages:listStageReceipts(db, args.runId), nudged, ...(reasons.length ? { reason:reasons.join("; ") } : {}),
          ...(next.length ? { next } : {}),
          ...(gateLines.length ? { gate:gateLines } : {}),
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
      ...(gatePending
        ? { gate:gateLines, message:"Задачи приняты, но проверка после слияния (integration gate) ещё идёт. Вызови lane_pilot_wait_writer ещё раз с тем же runId." }
        : qaInGraph
        ? { message:"Задача принята, её граф ещё проверяет страницу в браузере (qa_url). Вызови lane_pilot_wait_writer ещё раз с тем же runId." }
        : writerThreadId
        ? { message:"Писатель ещё работает. Вызови lane_pilot_wait_writer ещё раз с тем же runId." }
        : { writerStarted:false, message:"Писатель ещё не создан. Старт не закончен или не прошёл. Вызови lane_pilot_wait_writer ещё раз с тем же runId." }),
    };
    } finally { endWait(); }
  }

  /** Restarts dispatch stages interrupted by a plugin reload for the same task and attempt. */
  return { waitWriter };
}
