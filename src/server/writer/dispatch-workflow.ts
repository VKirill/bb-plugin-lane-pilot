import { getAttempt, getRunSettingsScopes, listAttemptsForTask, listStageReceipts, loadProjectSettings, saveTaskGitBase, setRunState, transitionAttempt } from "../../database";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { QUALITY_MODE_SETTING, resolveQualityMode } from "../../stages/quality-mode";
import { appendExcludeCommand, persistTaskFolder } from "../../verification/git-integrate";
import { pmReadBrief } from "../../writer-brief";
import { LP_TASK_PIPELINE, builtinWorkflow } from "../../workflow/builtin";
import type { NodeExecutor, RunSummary, StepContext, WorkflowEngine } from "../../workflow/engine";
import { runPlanCritique, runPmRead, runSpecialistReview } from "../critique-runs";
import { recordStage } from "../stage-records";
import type { ServerCore } from "../core";
import type { Services } from "../services";
import { runOnHost } from "@lane-pilot/host-calls";

/**
 * The built-in workflow `lp-task-pipeline` (workflows/lp-task-pipeline.json) executed by the workflow engine.
 * Each executor wraps the stage function dispatchWriter's `runStages` calls; the blocking branches repeat that closure's
 * glue line by line (the closure stays as the kill-switch path, `LANE_PILOT_WORKFLOW_ENGINE=0`), and the equivalence test
 * compares the receipts of both paths.
 */

/** What the executors need from the dispatch that started the run. It lives in memory: a reload ends this pipeline (see `resumePolicy`). */
export type DispatchRuntime = {
  ctx: ServerCore; services: Services;
  threadId: string; projectId: string; baseRef?: string;
  runId: string; taskId: string; attemptId: string;
  config: PrototypeConfig; runConfig: PrototypeConfig; workspacePath: string;
  task: TaskV2; plan: string; lintWarnings: string[];
};

/** Off only for `0`, `off`, `false`: nothing else, and no setting. Read at call time. */
export const workflowEngineEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !["0", "off", "false"].includes((env.LANE_PILOT_WORKFLOW_ENGINE ?? "").trim().toLowerCase());

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

function blockedReply(r: DispatchRuntime, reason: string | undefined): Record<string, unknown> {
  return { runId: r.runId, taskId: r.taskId, attemptId: r.attemptId, state: "blocked", reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) };
}

/** The agent-typed nodes also hand over a line saying what was done: the engine requires a handoff from every agent. */
const handoffOf = (stage: string, state: string, reason?: string) => `${stage} ${state}${reason ? `: ${reason}` : ""}`;

export function registerDispatchExecutors(engine: WorkflowEngine): void {
  const exec = (key: string, run: (r: DispatchRuntime, ctx: StepContext<DispatchRuntime>) => Promise<Record<string, unknown>>, extra: Partial<NodeExecutor<DispatchRuntime>> = {}) =>
    engine.register<DispatchRuntime>(key, { run: async (ctx) => ({ output: await run(need(ctx), ctx) }), ...extra });

  exec("lp.pm-read", async (r) => {
    const pmRead = await runPmRead({ bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, pmThreadId: r.threadId, config: r.runConfig, task: r.task });
    return { state: pmRead.state, summary: pmRead.summary, ...(pmRead.reason !== undefined ? { reason: pmRead.reason } : {}), handoff: handoffOf("pm-read", pmRead.state, pmRead.reason) };
  });

  exec("lp.block-pm-read", async (r, ctx) => {
    const reason = `pm_read_failed:${text(ctx.input.with.reason) ?? "unknown"}`;
    const { db } = r.ctx;
    recordStage(db, { runId: r.runId, taskId: r.taskId, stageId: "plan-critique", state: "skipped", input: r.plan, reason: "PM read stage failed" });
    recordStage(db, { runId: r.runId, taskId: r.taskId, stageId: "specialist-review", state: "skipped", input: r.plan, reason: "PM read stage failed" });
    skipWriterStages(r, "PM read stage failed");
    transitionAttempt(db, r.attemptId, "blocked", { reason });
    setRunState(db, r.runId, "blocked");
    r.ctx.refreshRun(r.runId);
    return { reply: blockedReply(r, reason) };
  });

  exec("lp.quality-mode", async (r) => {
    const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
    return { mode: resolveQualityMode(r.task, settings[QUALITY_MODE_SETTING]) };
  }, { reentrant: true });

  exec("lp.plan-critique", async (r, ctx) => {
    const critique = await runPlanCritique({ bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId,
      config: r.runConfig, task: r.task, plan: r.plan, pmReadContext: text(ctx.input.with.pmReadContext) || undefined });
    return { allowed: critique.allowed, ...(critique.reason !== undefined ? { reason: critique.reason } : {}), handoff: handoffOf("plan-critique", critique.allowed ? "allowed" : "blocked", critique.reason) };
  });

  exec("lp.block-plan-critique", async (r, ctx) => {
    const reason = text(ctx.input.with.reason);
    const { db } = r.ctx;
    recordStage(db, { runId: r.runId, taskId: r.taskId, stageId: "specialist-review", state: "skipped", input: r.plan, reason: "plan-critique did not allow dispatch" });
    skipWriterStages(r, "upstream plan-critique stage did not pass");
    transitionAttempt(db, r.attemptId, "blocked", { reason: reason ?? "plan-critique did not allow dispatch" });
    setRunState(db, r.runId, "blocked");
    return { reply: blockedReply(r, reason) };
  });

  exec("lp.specialist-review", async (r) => {
    const specialist = await runSpecialistReview({ bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, config: r.runConfig, task: r.task, plan: r.plan });
    return { allowed: specialist.allowed, ...(specialist.reason !== undefined ? { reason: specialist.reason } : {}), handoff: handoffOf("specialist-review", specialist.allowed ? "allowed" : "blocked", specialist.reason) };
  });

  exec("lp.block-specialist", async (r, ctx) => {
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
    if (gitBase?.status === "ready" && !saveTaskGitBase(db, r.taskId, {
      baseRef: gitBase.baseRef, baseSha: gitBase.baseSha, initialHeadSha: gitBase.headSha!, branch: gitBase.branch!, compareCommitted: gitBase.compareCommitted,
    })) {
      return { ok: false, live, kind: "persist_failed", reason: "could not persist immutable git ownership base snapshot" };
    }
    return { ok: true, live };
  });

  exec("lp.block-ownership", async (r, ctx) => {
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

  engine.register<DispatchRuntime>("lp-task", lpTaskPipelineExecutor(engine));
}

/**
 * The code task of the per-task pipeline: Lane Pilot's own writer loop (start.ts, finish.ts) runs it; this step starts it and then
 * waits for the attempt. A chain's `lp-task` node (workflow-executors.ts) goes through the same executor key and hands a dispatch run's step to this.
 */
export function lpTaskPipelineExecutor(engine: WorkflowEngine): NodeExecutor<DispatchRuntime> {
  return {
    run: async (ctx) => {
      const r = need(ctx);
      const { db } = r.ctx;
      const pmReadContext = text(ctx.input.with.pmReadContext) ?? "";
      // A cancel during the stages ends the queued attempt: the writer must not start for it.
      const waiting = getAttempt(db, r.attemptId);
      if (waiting?.state !== "queued") {
        return { output: { reply: { runId: r.runId, taskId: r.taskId, attemptId: r.attemptId, state: waiting?.state ?? "canceled", reason: waiting?.reason ?? "attempt ended before its stages finished", stages: listStageReceipts(db, r.runId, r.taskId) } } };
      }
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
    poll: async (step) => {
      const detail = step.await.detail as { runId: string; taskId: string } | undefined;
      if (!detail) return { error: "the waiting step does not say which task it waits for" };
      return pollAttempt(engine, detail.runId, detail.taskId);
    },
  };
}

function pollAttempt(engine: WorkflowEngine, runId: string, taskId: string) {
  const db = engine.journal.db;
  const listed = listAttemptsForTask(db, runId, taskId).at(-1);
  const latest = listed ? getAttempt(db, listed.id) : null;
  if (!latest || !TERMINAL_ATTEMPT.includes(latest.state)) return null;
  return { output: { reply: { runId, taskId, attemptId: latest.id, state: latest.state, ...(latest.reason ? { reason: latest.reason } : {}) } } };
}

/** Starts the dispatch pipeline as a workflow run keyed by the attempt; throws when the engine cannot start it. */
export function startDispatchRun(engine: WorkflowEngine, runtime: DispatchRuntime): { runId: string; done: Promise<RunSummary> } {
  const workflow = builtinWorkflow(LP_TASK_PIPELINE);
  if (!workflow) throw new Error(`built-in workflow ${LP_TASK_PIPELINE} is not loaded`);
  return engine.start({
    workflow, inputs: { taskId: runtime.taskId, attemptId: runtime.attemptId }, key: `lp-task:${runtime.attemptId}`, runtime,
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
