import { countAttempts, getAttempt, getRunSettingsScopes, getTaskGitBase, listAttemptsForTask, listStageReceipts, loadProjectSettings, saveTaskGitBase, setRunState, transitionAttempt } from "../../storage";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { QUALITY_MODE_SETTING, resolveQualityMode } from "../../critique";
import { appendExcludeCommand, persistTaskFolder } from "../../verification";
import { pmReadBrief } from "../writer-brief";
import { LP_TASK_PIPELINE, builtinWorkflow } from "../../workflow";
import type { NodeExecutor, RunSummary, StepContext, WorkflowEngine } from "../../workflow";
import { runPlanCritique, runPmRead, runSpecialistReview } from "../../critique/server";
import { closeWriterStages, recordStage } from "../../runs/server";
import { isMainfixTask } from "../../tasks";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { runOnHost } from "@lane-pilot/host-calls";
import { withUsage } from "../../usage/server";
import { taskUsage } from "./attempt-usage";

/**
 * The built-in workflow `lp-task-pipeline` (workflows/lp-task-pipeline.json) executed by the workflow engine.
 * Each executor wraps a stage function (pm-read, the critiques, the writer loop); this is the only path a dispatch takes, and the
 * equivalence test pins the receipts it leaves.
 */

/** What the executors need from the dispatch that started the run. It lives in memory: a reload ends this pipeline (see `resumePolicy`) and start-up recovery starts it again from the stored task (`resumeDispatch`). */
export type DispatchRuntime = {
  ctx: ServerCore; services: Services;
  threadId: string; projectId: string; baseRef?: string;
  runId: string; taskId: string; attemptId: string;
  config: PrototypeConfig; runConfig: PrototypeConfig; workspacePath: string;
  task: TaskV2; plan: string; lintWarnings: string[];
};

/** Why the task pipeline cannot start on this engine, or null when it can: no engine, no pipeline graph, or a graph the engine refuses. */
export function pipelineUnavailable(engine: WorkflowEngine | undefined): string | null {
  if (!engine) return "the workflow engine is not running";
  const workflow = builtinWorkflow(LP_TASK_PIPELINE);
  if (!workflow) return `built-in workflow ${LP_TASK_PIPELINE} is not loaded`;
  const problems = engine.preflight(workflow);
  return problems.length ? problems.slice(0, 3).join("; ") : null;
}

const WRITER_STAGES = ["writer-agent", "verification", "acceptance-receipt"] as const;
const TERMINAL_ATTEMPT = ["accepted", "blocked", "canceled"];

const need = (ctx: StepContext<DispatchRuntime>): DispatchRuntime => {
  if (!ctx.runtime) throw new Error("the dispatch was interrupted by a plugin reload; send the task again");
  return ctx.runtime;
};
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function skipWriterStages(r: DispatchRuntime, reason: string): void {
  for (const stageId of WRITER_STAGES) recordStage(r.ctx.db, { runId: r.runId, taskId: r.taskId, stageId, state: "skipped", input: r.plan, reason });
}

/**
 * The reply for an attempt that ended while its stages ran, or null while it still waits for them. A cancel closes the
 * attempt and its writer stages; a stage verdict that arrives later must leave both, and the run, as the cancel left them
 * (live 2026-10-09: «illegal stage transition writer-agent: canceled -> skipped» blocked the run of a canceled task).
 */
export function endedAttemptReply(db: ServerCore["db"], runId: string, taskId: string, attemptId: string): Record<string, unknown> | null {
  const attempt = getAttempt(db, attemptId);
  if (attempt?.state === "queued") return null;
  return { runId, taskId, attemptId, state: attempt?.state ?? "canceled", reason: attempt?.reason ?? "attempt ended before its stages finished", stages: listStageReceipts(db, runId, taskId) };
}
const endedReply = (r: DispatchRuntime) => endedAttemptReply(r.ctx.db, r.runId, r.taskId, r.attemptId);

function blockedReply(r: DispatchRuntime, reason: string | undefined): Record<string, unknown> {
  return { runId: r.runId, taskId: r.taskId, attemptId: r.attemptId, state: "blocked", reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) };
}

/** The agent-typed nodes also hand over a line saying what was done: the engine requires a handoff from every agent. */
const handoffOf = (stage: string, state: string, reason?: string) => `${stage} ${state}${reason ? `: ${reason}` : ""}`;

/** The graph step a stage function runs for: its helper threads carry these ids in their metadata. */
const stepRef = (ctx: StepContext<DispatchRuntime>) => ({ runId: ctx.runId, stepKey: ctx.stepKey, nodeId: ctx.nodeId });

export function registerDispatchExecutors(engine: WorkflowEngine, bb?: BbPluginApi): void {
  /**
   * `stage`: the stage whose helper thread this step runs. Once the stage function returns, the thread its receipt names is read for what it spent
   * and the engine adds that to the run (`lane_pilot_wf_run.tokens_used`), so a budget sees the cost. A receipt the stage did not write now (an
   * earlier run's, found again) is not charged a second time.
   */
  const exec = (key: string, run: (r: DispatchRuntime, ctx: StepContext<DispatchRuntime>) => Promise<Record<string, unknown>>, extra: Partial<NodeExecutor<DispatchRuntime>> = {}, stage?: "pm-read" | "plan-critique" | "specialist-review") =>
    engine.register<DispatchRuntime>(key, { run: async (ctx) => {
      const r = need(ctx);
      const since = Date.now();
      const output = await run(r, ctx);
      const receipt = stage ? listStageReceipts(r.ctx.db, r.runId, r.taskId).find((row) => row.stageId === stage) : undefined;
      return { output, ...(receipt?.threadId && receipt.updatedAt >= since ? await withUsage(r.ctx.bb, receipt.threadId) : {}) };
    }, ...extra });

  exec("lp.pm-read", async (r, ctx) => {
    const pmRead = await runPmRead({ bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, pmThreadId: r.threadId, config: r.runConfig, task: r.task, workflow: stepRef(ctx) });
    return { state: pmRead.state, summary: pmRead.summary, ...(pmRead.reason !== undefined ? { reason: pmRead.reason } : {}), handoff: handoffOf("pm-read", pmRead.state, pmRead.reason) };
  }, {}, "pm-read");

  exec("lp.quality-mode", async (r) => {
    const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
    return { mode: resolveQualityMode(r.task, settings[QUALITY_MODE_SETTING]) };
  }, { reentrant: true });

  exec("lp.plan-critique", async (r, ctx) => {
    // A canceled task starts no new helper: the block branch then answers with the ended attempt.
    if (endedReply(r)) return { allowed: false, reason: "attempt ended before its stages finished", handoff: handoffOf("plan-critique", "skipped", "attempt ended") };
    const critique = await runPlanCritique({ bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId,
      config: r.runConfig, task: r.task, plan: r.plan, pmReadContext: text(ctx.input.with.pmReadContext) || undefined, workflow: stepRef(ctx) });
    return { allowed: critique.allowed, ...(critique.reason !== undefined ? { reason: critique.reason } : {}), handoff: handoffOf("plan-critique", critique.allowed ? "allowed" : "blocked", critique.reason) };
  }, {}, "plan-critique");

  exec("lp.block-plan-critique", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { reply: ended };
    const reason = text(ctx.input.with.reason);
    const { db } = r.ctx;
    recordStage(db, { runId: r.runId, taskId: r.taskId, stageId: "specialist-review", state: "skipped", input: r.plan, reason: "plan-critique did not allow dispatch" });
    skipWriterStages(r, "upstream plan-critique stage did not pass");
    transitionAttempt(db, r.attemptId, "blocked", { reason: reason ?? "plan-critique did not allow dispatch" });
    setRunState(db, r.runId, "blocked");
    return { reply: blockedReply(r, reason) };
  });

  exec("lp.specialist-review", async (r, ctx) => {
    // A canceled task starts no new helper: the block branch then answers with the ended attempt.
    if (endedReply(r)) return { allowed: false, reason: "attempt ended before its stages finished", handoff: handoffOf("specialist-review", "skipped", "attempt ended") };
    const specialist = await runSpecialistReview({ bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, config: r.runConfig, task: r.task, plan: r.plan, workflow: stepRef(ctx) });
    return { allowed: specialist.allowed, ...(specialist.reason !== undefined ? { reason: specialist.reason } : {}), handoff: handoffOf("specialist-review", specialist.allowed ? "allowed" : "blocked", specialist.reason) };
  }, {}, "specialist-review");

  exec("lp.block-specialist", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { reply: ended };
    const reason = text(ctx.input.with.reason);
    const { db } = r.ctx;
    skipWriterStages(r, "specialist review did not allow dispatch");
    transitionAttempt(db, r.attemptId, "blocked", { reason: reason ?? "specialist review did not allow dispatch" });
    setRunState(db, r.runId, "blocked");
    return { reply: blockedReply(r, reason) };
  });

  // A folder without git has no base commit to measure ownership against: the writer's work is the difference of two
  // content snapshots of the folder.
  exec("lp.ownership-base", async (r) => {
    const { db, host } = r.ctx;
    const live = await r.services.isLiveFolder(r.runId, r.config.hostId, r.workspacePath);
    const gitBase = live ? null : await host.call("gitOwnershipBase", {
      requestedHostId: r.config.hostId, projectCwd: r.workspacePath, ...(r.baseRef === undefined ? {} : { baseRef: r.baseRef }),
    }, { hostId: r.config.hostId, timeoutMs: 30_000 });
    if (gitBase && gitBase.status !== "ready" && (r.baseRef !== undefined || gitBase.status !== "not-git")) {
      return { ok: false, live, kind: "unavailable", reason: `git ownership base unavailable: ${gitBase.reason ?? gitBase.status}` };
    }
    // The base is taken once per task and never changes: a pipeline that goes again (the PM updated the task) keeps the one it has.
    if (gitBase?.status === "ready" && !saveTaskGitBase(db, r.taskId, {
      baseRef: gitBase.baseRef, baseSha: gitBase.baseSha, initialHeadSha: gitBase.headSha!, branch: gitBase.branch!, compareCommitted: gitBase.compareCommitted,
    }) && !getTaskGitBase(db, r.taskId)) {
      return { ok: false, live, kind: "persist_failed", reason: "could not persist immutable git ownership base snapshot" };
    }
    return { ok: true, live };
  });

  exec("lp.block-ownership", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { reply: ended };
    const reason = text(ctx.input.with.reason) ?? "";
    const { db } = r.ctx;
    if (ctx.input.with.kind === "persist_failed") {
      recordStage(db, { runId: r.runId, taskId: r.taskId, stageId: "run-gate", state: "blocked", input: r.plan, result: { decision: "ownership_base_persist_failed" }, reason });
      skipWriterStages(r, reason);
    } else {
      recordStage(db, { runId: r.runId, taskId: r.taskId, stageId: "run-gate", state: "blocked", input: r.plan, result: { decision: "ownership_base_unavailable", baseRef: r.baseRef ?? null }, reason });
      skipWriterStages(r, "git ownership base preflight failed");
    }
    transitionAttempt(db, r.attemptId, "blocked", { reason });
    setRunState(db, r.runId, "blocked");
    r.ctx.refreshRun(r.runId);
    return { reply: blockedReply(r, reason) };
  });

  exec("lp.task-folder", async (r, ctx) => {
    const { bb, host } = r.ctx;
    const live = ctx.input.with.live === true;
    try {
      await persistTaskFolder({
        taskId: r.taskId, plan: r.plan,
        // The line goes into the repository's real info/exclude, resolved by git on the workspace's own host —
        // never into a stray `.git` of a subfolder workspace (OVH 2026-10-06). PLAN.md is written regardless.
        exclude: live ? undefined : async (line) => {
          const ran = await runOnHost(host, { hostId: r.config.hostId, cwd: r.workspacePath, command: appendExcludeCommand(line), timeoutSec: 30, timeoutMs: 30_000 });
          if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `git exited ${ran.exitCode}`);
        },
        writeFile: async (rel, content) => {
          await bb.sdk.files.write({ hostId: r.config.hostId, rootPath: r.workspacePath, path: `${r.workspacePath}/${rel}`, content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
        },
      });
    } catch (cause) {
      bb.log.warn(`Lane Pilot could not persist task folder for ${r.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return { ok: true };
  });

  // Step [1] of Matvey's task path as a node of its own: the task's checks on the base before any writer (src/rooms/baseline).
  // The writer loop asks the same preflight again and gets this answer from its record: «already built» closes the attempt accepted
  // without a writer there. A stop never reaches the writer: a stopped record is asked again, so it ends here as start.ts ended it.
  exec("lp.baseline", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { state: "skipped", reply: ended };
    if (ctx.input.with.live === true || isMainfixTask(r.taskId)) return { state: "skipped" };
    const baseline = await r.services.baseline?.preflight({ projectId: r.projectId, runId: r.runId, taskId: r.taskId, attemptId: r.attemptId,
      pmThreadId: r.threadId, config: r.runConfig, task: r.task });
    if (baseline?.stop) return { state: "stopped", reason: baseline.stop };
    if (baseline?.alreadyDone) return { state: "already_built", reason: baseline.alreadyDone };
    return { state: baseline?.record ? "red" : "skipped" };
  });

  exec("lp.block-baseline", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { reply: ended };
    const reason = text(ctx.input.with.reason) ?? "verdict_block: baseline";
    const { db } = r.ctx;
    transitionAttempt(db, r.attemptId, "blocked", { reason });
    closeWriterStages(db, { runId: r.runId, taskId: r.taskId, plan: r.plan, terminal: "failed", attempt: countAttempts(db, r.runId, r.taskId), reason });
    r.ctx.refreshRun(r.runId);
    return { reply: blockedReply(r, reason) };
  });

  engine.register<DispatchRuntime>("lp-task", lpTaskPipelineExecutor(engine, bb));
}

/**
 * The code task of the per-task pipeline: Lane Pilot's own writer loop (start.ts, finish.ts) runs it; this step starts it and then
 * waits for the attempt. A chain's `lp-task` node (workflow-executors.ts) goes through the same executor key and hands a dispatch run's step to this.
 */
export function lpTaskPipelineExecutor(engine: WorkflowEngine, bb?: BbPluginApi): NodeExecutor<DispatchRuntime> {
  return {
    run: async (ctx) => {
      const r = need(ctx);
      const { db } = r.ctx;
      const pmReadContext = text(ctx.input.with.pmReadContext) ?? "";
      // A cancel during the stages ends the queued attempt: the writer must not start for it.
      const ended = endedReply(r);
      if (ended) return { output: { reply: ended } };
      transitionAttempt(db, r.attemptId, "queued");
      r.services.startWriterTask({
        projectId: r.projectId, runId: r.runId, taskId: r.taskId, firstAttemptId: r.attemptId,
        pmThreadId: r.threadId, config: r.runConfig, task: r.task, plan: r.plan, pmReadContext: pmReadContext || undefined,
      });
      // The writer's brief carries the read stage's facts, not its open questions: those are the PM's to settle.
      const openQuestions = pmReadContext ? pmReadBrief(pmReadContext).openQuestions : [];
      const warnings: string[] = [...r.lintWarnings];
      if (ctx.input.with.live === true) warnings.push("mode live-folder: this folder has no git. The writer edits the live files in place; nothing is committed or merged, so there is no ship step. One writer at a time works in the folder, later tasks queue. A task that is not accepted is rolled back from a backup of its owns_paths (~/.lane-pilot/live-backups, kept 7 days); files outside owns_paths are not rolled back.");
      const reply = { runId: r.runId, taskId: r.taskId, attemptId: r.attemptId, writerThreadId: null, state: "queued", stages: listStageReceipts(db, r.runId, r.taskId),
        ...(warnings.length ? { warnings } : {}),
        ...(openQuestions.length ? { pmReadOpenQuestions: openQuestions,
          pmReadNote: "The writer does not see these questions. If one changes what the writer should do, wait for this attempt's receipt and, if it is not accepted, dispatch again with the answer in the plan; otherwise the writer decides from the code." } : {}) };
      return { wait: { kind: "attempt", detail: { runId: r.runId, taskId: r.taskId, attemptId: r.attemptId } }, partial: { reply } };
    },
    /** The step ends when the task's latest attempt does. A retry is a new attempt of the same task, so the latest one counts. */
    poll: async (step, ctx) => {
      const detail = step.await.detail as { runId: string; taskId: string } | undefined;
      if (!detail) return { error: "the waiting step does not say which task it waits for" };
      return pollAttempt(engine, detail.runId, detail.taskId, bb ?? ctx.runtime?.ctx.bb);
    },
  };
}

/**
 * `bb` is the plugin's, bound when the executor is registered, so a step a reload found waiting reads what the task spent exactly as one that never
 * stopped did (before, a reloaded pipeline had no runtime, no `bb`, and the step ended with no usage at all). The task is charged for its own turns
 * only (attempt-usage.ts): a sticky writer's thread carries other tasks' turns too.
 */
async function pollAttempt(engine: WorkflowEngine, runId: string, taskId: string, bb?: BbPluginApi) {
  const db = engine.journal.db;
  const attempts = listAttemptsForTask(db, runId, taskId);
  const listed = attempts.at(-1);
  const latest = listed ? getAttempt(db, listed.id) : null;
  if (!latest || !TERMINAL_ATTEMPT.includes(latest.state)) return null;
  return { output: { reply: { runId, taskId, attemptId: latest.id, state: latest.state, ...(latest.reason ? { reason: latest.reason } : {}) } }, ...(bb ? await taskUsage(bb, db, runId, taskId) : {}) };
}

/** The engine key of an attempt's dispatch run; a restart after a reload is a run of its own (`:resume-N`). */
export const dispatchRunKey = (attemptId: string, resume = 0): string => `lp-task:${attemptId}${resume ? `:resume-${resume}` : ""}`;

/**
 * Starts the dispatch pipeline as a workflow run keyed by the attempt; throws when the engine cannot start it. The PM's
 * baseRef goes into the run's inputs: it is the one dispatch argument nothing else stores, and a restart needs it.
 */
export function startDispatchRun(engine: WorkflowEngine, runtime: DispatchRuntime, resume = 0): { runId: string; done: Promise<RunSummary> } {
  const workflow = builtinWorkflow(LP_TASK_PIPELINE);
  if (!workflow) throw new Error(`built-in workflow ${LP_TASK_PIPELINE} is not loaded`);
  return engine.start({
    workflow, inputs: { taskId: runtime.taskId, attemptId: runtime.attemptId, ...(runtime.baseRef === undefined ? {} : { baseRef: runtime.baseRef }) },
    key: dispatchRunKey(runtime.attemptId, resume), runtime,
    link: { projectId: runtime.projectId, runId: runtime.runId, taskId: runtime.taskId, attemptId: runtime.attemptId },
  });
}

/** What the dispatch tool answers with once the run stops: the reply of the node that ended it. A failed run throws the step's own message. */
export function dispatchReply(summary: RunSummary): Record<string, unknown> | null {
  if (summary.status === "succeeded") return (summary.output?.reply as Record<string, unknown> | undefined) ?? null;
  if (summary.status === "waiting") return (summary.waiting[0]?.partial?.reply as Record<string, unknown> | undefined) ?? null;
  if (summary.status === "failed") throw new Error(summary.error ?? summary.reason ?? "workflow failed");
  return null;
}

/** The newest pipeline run of a task (`lp-task-pipeline`, linked to the Lane Pilot run and the task), or null. */
export function dispatchRunOf(db: ServerCore["db"], runId: string, taskId: string): string | null {
  const row = db.prepare("SELECT id FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline' AND link_run_id=? AND link_task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(runId, taskId) as { id: string } | undefined;
  return row?.id ?? null;
}

export type DispatchRerun =
  | { ok: true; pipelineRunId: string; settled: boolean; critique: { allowed: boolean; reason?: string } | null }
  | { ok: false; reason: string };

/**
 * The PM updated a task that waits for its writer: its pipeline run goes again from `pm-read` with the new contract and plan, by the
 * engine's re-run. The run waits at the `writer` node, so it is canceled first (which ends that wait; the writer queue of the task is
 * not touched and reads the stored task when its turn comes), and `runtime` carries the new task to the steps that go again. Resolves once
 * the run waits for the writer again or ends, or after `waitMs`.
 */
export async function rerunDispatchStages(engine: WorkflowEngine, runtime: DispatchRuntime, waitMs: number): Promise<DispatchRerun> {
  const pipelineRunId = dispatchRunOf(runtime.ctx.db, runtime.runId, runtime.taskId);
  if (!pipelineRunId) return { ok: false, reason: "no_pipeline_run" };
  // The PM's baseRef is kept only in the pipeline run's inputs.
  try {
    const row = runtime.ctx.db.prepare("SELECT inputs_json FROM lane_pilot_wf_run WHERE id=?").get(pipelineRunId) as { inputs_json: string } | undefined;
    const baseRef = (JSON.parse(row?.inputs_json || "{}") as { baseRef?: unknown }).baseRef;
    if (typeof baseRef === "string") runtime.baseRef = baseRef;
  } catch { /* no baseRef */ }
  engine.cancel(pipelineRunId, "the task was updated");
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
  // The drive of the canceled run winds down on its own; the re-run is refused until it has.
  const until = Date.now() + 5_000;
  let again = await engine.rerunNode(pipelineRunId, "pm-read", runtime);
  while (!again.ok && again.reason === "run_active" && Date.now() < until) {
    await pause();
    again = await engine.rerunNode(pipelineRunId, "pm-read", runtime);
  }
  if (!again.ok) return { ok: false, reason: again.reason };
  const deadline = Date.now() + waitMs;
  while (engine.get(pipelineRunId)?.status === "running" && Date.now() < deadline) await pause();
  const status = engine.get(pipelineRunId)?.status;
  const critique = engine.snapshot(pipelineRunId)?.steps.filter((step) => (step.node_id === "plan-critique" || step.node_id === "plan-critique-quick") && step.state === "succeeded").at(-1);
  let verdict: { allowed: boolean; reason?: string } | null = null;
  try {
    const out = JSON.parse(critique?.output_json ?? "null") as { allowed?: unknown; reason?: unknown } | null;
    if (out && typeof out.allowed === "boolean") verdict = { allowed: out.allowed, ...(typeof out.reason === "string" ? { reason: out.reason } : {}) };
  } catch { /* no verdict yet */ }
  return { ok: true, pipelineRunId, settled: status !== "running", critique: verdict };
}
