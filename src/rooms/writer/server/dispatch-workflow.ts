import { wfLatestPipelineRunId, wfLiveRunHasStep, wfRunInputsJson } from "@lane-pilot/workflow-engine";
import { contractEditions, countAttempts, getAttempt, getRunSettingsScopes, getTaskGitBase, listAttemptsForTask, listStageReceipts, loadProjectSettings, saveTaskGitBase, setRunState, transitionAttempt } from "../../storage";
import type {StageHelperSettings} from "../../platform/server";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { QUALITY_MODE_SETTING, resolveQualityMode } from "../../contracts/quality-mode";
import { appendExcludeCommand, persistTaskFolder } from "../../verification";
import { hasTaskHome, TASK_HOME_EXCLUDE } from "../../storage";
import { recordPlanCritique, recordPlannerRevision, recordTaskHomeFile, stagePlanText } from "./task-home";
import { pmReadBrief } from "../writer-brief";
import type { NodeExecutor, RunSummary, StepContext, WorkflowEngine } from "../../workflow";
import { provideLpTaskPipeline } from "../../workflow/server";
import { runPlanCritique, runPmRead, runSpecialistReview } from "../../critique/server";
import { closeWriterStages, recordStage } from "../../runs/server";
import { isMainfixTask } from "../../tasks";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ServerCore } from "../../contracts/server";

import { runOnHost } from "@lane-pilot/host-calls";
import { isNotFound, maskCredentials, orMiss, parseJsonOr } from "@lane-pilot/kit";
import { withUsage } from "../../usage/server";
import { taskUsage } from "./attempt-usage";
import { reflexLinesOf, taskFileCards } from "./writer-knowledge";
import { writerDiffRules } from "../../learning";

import type { BaselineApi } from "../../baseline/server/baseline";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStartApi } from "./start";
import {LP_TASK_PIPELINE} from "../../contracts";
import { PM_STOPPED_PLANNER_LOOP, planReviseConfig, runPlanRevise } from "./plan-revise";
import type { RoundFindings } from "./plan-revise";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  stageHelperSettings: StageHelperSettings;
  baseline: BaselineApi;
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  startWriterTask: WriterStartApi["startWriterTask"];
}

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
  const workflow = engine.resolveWorkflow(LP_TASK_PIPELINE);
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

/**
 * Marks skipped a stage that has not run; a verdict it already has stays. MagicSEO replay concert-scheduler (2026-10-31): the plan
 * critique passed, so did the specialist review; the PM changed the plan, its new critique blocked, and skipping the passed review
 * threw «illegal stage transition specialist-review: passed -> skipped» — the run failed instead of blocking.
 */
function skipOpenStage(r: DispatchRuntime, stageId: Parameters<typeof recordStage>[1]["stageId"], reason: string): void {
  const current = listStageReceipts(r.ctx.db, r.runId, r.taskId).find((row) => row.stageId === stageId);
  if (current && current.state !== "pending") return;
  recordStage(r.ctx.db, { runId: r.runId, taskId: r.taskId, stageId, state: "skipped", input: r.plan, reason });
}

function skipWriterStages(r: DispatchRuntime, reason: string): void {
  for (const stageId of WRITER_STAGES) skipOpenStage(r, stageId, reason);
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

/** What the planner loop of this pipeline run did so far (SMA n1269): the outputs of its finished plan-critique and plan-revise steps, in order. */
export type PlannerLoopState = { critiques: Array<{ allowed?: boolean; reason?: string; findings?: unknown[]; round?: number }>; revises: Array<{ revised?: boolean; reason?: string; plannerThreadId?: string; fromSha?: string; planSha?: string; edition?: number }> };
export function plannerLoopState(engine: Pick<WorkflowEngine, "snapshot"> | undefined, pipelineRunId: string): PlannerLoopState {
  const steps = (engine?.snapshot?.(pipelineRunId)?.steps ?? []).filter((step) => step.scope === "" && step.state === "succeeded");
  const outputs = (node: string) => steps.filter((step) => step.node_id === node).map((step) => parseJsonOr(step.output_json ?? "null", null) as Record<string, unknown> | null).filter((row): row is Record<string, unknown> => !!row);
  return { critiques: outputs("plan-critique") as PlannerLoopState["critiques"], revises: outputs("plan-revise") as PlannerLoopState["revises"] };
}
/** The findings of every critic round of the loop, the latest last. */
const roundsOf = (loop: PlannerLoopState): RoundFindings[] => loop.critiques.filter((row) => row.allowed === false)
  .map((row, index) => ({ round: index + 1, ...(row.reason ? { reason: row.reason } : {}), findings: Array.isArray(row.findings) ? row.findings : [] }));

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
    // The plan comes from the task home's PLAN.md by the manifest (docs/task-folder.md), not from what the dispatch held in memory.
    const plan = await stagePlanText(r.ctx, r.taskId, "pm-read", r.plan);
    const pmRead = await runPmRead({ stageHelperSettings: r.services.stageHelperSettings, bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, pmThreadId: r.threadId, config: r.runConfig, task: r.task, plan, workflow: stepRef(ctx) });
    return { state: pmRead.state, summary: pmRead.summary, ...(pmRead.reason !== undefined ? { reason: pmRead.reason } : {}), handoff: handoffOf("pm-read", pmRead.state, pmRead.reason) };
  }, {}, "pm-read");

  exec("lp.quality-mode", async (r) => {
    const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
    return { mode: resolveQualityMode(r.task, settings[QUALITY_MODE_SETTING]) };
  }, { reentrant: true });

  exec("lp.plan-critique", async (r, ctx) => {
    // A canceled task starts no new helper: the block branch then answers with the ended attempt.
    if (endedReply(r)) return { allowed: false, revisable: false, reason: "attempt ended before its stages finished", handoff: handoffOf("plan-critique", "skipped", "attempt ended") };
    // The critic of every round reads PLAN.md through the task's manifest (docs/task-folder.md): after a planner round that is the revised edition.
    const plan = await stagePlanText(r.ctx, r.taskId, "plan-critique", r.plan);
    const critique = await runPlanCritique({ stageHelperSettings: r.services.stageHelperSettings, bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId,
      config: r.runConfig, task: r.task, plan, pmReadContext: text(ctx.input.with.pmReadContext) || undefined, workflow: stepRef(ctx) });
    // The verdict as critique/plan.r<K>.json in the task home; a failed record never changes the verdict.
    await recordPlanCritique(r.ctx, { taskId: r.taskId, runId: r.runId, allowed: critique.allowed, reason: critique.reason, wfStepKey: ctx.stepKey })
      .catch((cause: unknown) => r.ctx.bb.log.warn(`Lane Pilot: the plan critique of ${r.taskId} was not recorded in its home: ${cause instanceof Error ? cause.message : String(cause)}`));
    // The planner revises a returned plan when the project says so (plan_critique.revise_by planner), the refusal is one a rewrite of the plan can
    // fix (a rework, or a structural finding in the plan itself), its rounds are not spent, and the PM has not taken the plan over.
    const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
    const loop = plannerLoopState(engine, ctx.runId);
    const config = planReviseConfig(settings);
    const revisions = loop.revises.filter((row) => row.revised === true).length;
    const pmTookOver = contractEditions(r.ctx.db, r.taskId).some((row) => row.reason === PM_STOPPED_PLANNER_LOOP);
    const revisable = !critique.allowed && critique.revisable === true && config.by === "planner" && revisions < config.maxRounds && !pmTookOver && !endedReply(r);
    return { allowed: critique.allowed, revisable, round: loop.critiques.length + 1, findings: critique.findings ?? [], ...(critique.reason !== undefined ? { reason: critique.reason } : {}),
      handoff: handoffOf("plan-critique", critique.allowed ? "allowed" : revisable ? "returned to the planner" : "blocked", critique.reason) };
  }, {}, "plan-critique");

  // One planner round (SMA n1269, n1267, n22): the planner rewrites the plan the critic returned, in its own session from the second round on; the
  // revision is a new contract edition and the critic judges it again in a fresh session. What the planner cannot fix goes to the PM.
  engine.register<DispatchRuntime>("lp.plan-revise", { run: async (ctx) => {
    const r = need(ctx);
    const loop = plannerLoopState(engine, ctx.runId);
    const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
    const config = planReviseConfig(settings);
    const round = loop.revises.filter((row) => row.revised === true).length + 1;
    const tried = new Set(loop.revises.flatMap((row) => [row.fromSha, row.planSha]).filter((sha): sha is string => typeof sha === "string"));
    const plannerThreadId = [...loop.revises].reverse().find((row) => typeof row.plannerThreadId === "string")?.plannerThreadId ?? null;
    const base = { round, max: config.maxRounds };
    if (endedReply(r)) return { output: { revised: false, reason: "attempt ended before its stages finished", ...base, handoff: handoffOf("plan-revise", "skipped", "attempt ended") } };
    let outcome: Awaited<ReturnType<typeof runPlanRevise>>;
    try {
      outcome = await runPlanRevise({ bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, config: r.runConfig, task: r.task, plan: await stagePlanText(r.ctx, r.taskId, "plan-revise", r.plan), settings,
        round, max: config.maxRounds, findings: roundsOf(loop), plannerThreadId, tried, signal: ctx.signal, workflow: stepRef(ctx) });
    } catch (cause) {
      const reason = `planner_failed:${cause instanceof Error ? cause.message : String(cause)}`;
      return { output: { revised: false, reason, ...base, handoff: handoffOf("plan-revise", "failed", reason) } };
    }
    if (outcome.revised && outcome.plan && outcome.task) {
      r.plan = outcome.plan; r.task = outcome.task;
      // The revision is the task home's new PLAN.md and contract edition (supersedes chain): the next critic reads it through the manifest.
      const homeFailed = await recordPlannerRevision(r.ctx, { taskId: r.taskId, task: outcome.task, plan: outcome.plan });
      if (homeFailed) outcome = { ...outcome, revised: false, reason: homeFailed };
    }
    const output = { revised: outcome.revised, ...base, fromSha: outcome.fromSha, ...(outcome.planSha ? { planSha: outcome.planSha } : {}), ...(outcome.edition !== undefined ? { edition: outcome.edition } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.plannerThreadId ? { plannerThreadId: outcome.plannerThreadId } : {}),
      handoff: handoffOf("plan-revise", outcome.revised ? `revised (edition ${outcome.edition})` : "not revised", outcome.reason) };
    return { output, ...(outcome.plannerThreadId ? await withUsage(r.ctx.bb, outcome.plannerThreadId) : {}) };
  } });

  exec("lp.block-plan-critique", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { reply: ended };
    const { db } = r.ctx;
    // After the planner loop ran, the PM gets the findings of every round and why the loop ended (SMA n1269: the rounds are spent, then the PM).
    const loop = plannerLoopState(engine, ctx.runId);
    const revisions = loop.revises.filter((row) => row.revised === true).length;
    const config = planReviseConfig(loadProjectSettings(db, r.projectId, getRunSettingsScopes(db, r.runId)));
    const lastRevise = loop.revises.at(-1);
    const stopped = lastRevise && lastRevise.revised !== true ? lastRevise.reason ?? "planner_not_revised" : revisions >= config.maxRounds && revisions > 0 ? "rounds_exhausted" : null;
    // From plan-revise the edge carries the planner's reason; the critic's own reason is that of the last critique.
    const critiqueReason = (loop.revises.length ? loop.critiques.at(-1)?.reason : undefined) ?? text(ctx.input.with.reason);
    const reason = loop.revises.length && stopped
      ? `${stopped === "rounds_exhausted" ? `planner_rounds_exhausted:${revisions}/${config.maxRounds}` : `planner_stopped:${stopped.split(":")[0]}`}: ${critiqueReason ?? "plan-critique did not allow dispatch"}`
      : critiqueReason;
    skipOpenStage(r, "specialist-review", "plan-critique did not allow dispatch");
    skipWriterStages(r, "upstream plan-critique stage did not pass");
    transitionAttempt(db, r.attemptId, "blocked", { reason: reason ?? "plan-critique did not allow dispatch" });
    setRunState(db, r.runId, "blocked");
    const plannerLoop = loop.revises.length ? {
      revisions, maxRounds: config.maxRounds, stopped,
      rounds: roundsOf(loop),
      note: stopped === "rounds_exhausted"
        ? `The planner used its ${revisions} revision round${revisions === 1 ? "" : "s"} and the critic still returns the plan: the findings of every round are in rounds. Fix the plan or the contract in place with lane_pilot_update_task.`
        : stopped ? `The planner stopped (${stopped}): the findings of every round are in rounds. Fix the plan or the contract in place with lane_pilot_update_task.`
        : "The critic's last verdict is not one the planner may fix by rewriting the plan: the findings of every round are in rounds. Fix the plan or the contract in place with lane_pilot_update_task.",
    } : undefined;
    return { reply: { ...blockedReply(r, reason), ...(plannerLoop ? { plannerLoop } : {}) } };
  });

  exec("lp.specialist-review", async (r, ctx) => {
    // A canceled task starts no new helper: the block branch then answers with the ended attempt.
    if (endedReply(r)) return { allowed: false, reason: "attempt ended before its stages finished", handoff: handoffOf("specialist-review", "skipped", "attempt ended") };
    const specialist = await runSpecialistReview({ stageHelperSettings: r.services.stageHelperSettings, bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, config: r.runConfig, task: r.task, plan: r.plan, workflow: stepRef(ctx) });
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
    const reflexes = reflexLinesOf(writerDiffRules(r.ctx.db as never, r.projectId));
    const filecards = await taskFileCards(r.ctx.db as never, r.projectId, r.task).catch(() => undefined);
    // The line goes into the repository's real info/exclude, resolved by git on the workspace's own host — never into a stray `.git` of a
    // subfolder workspace (OVH 2026-10-06). A failed exclude skips only its line.
    const exclude = live ? undefined : async (line: string) => {
      const ran = await runOnHost(host, { hostId: r.config.hostId, cwd: r.workspacePath, command: appendExcludeCommand(line), timeoutSec: 30, timeoutMs: 30_000 });
      if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `git exited ${ran.exitCode}`);
    };
    // A task with a home (docs/task-folder.md) gets its guard notes there, through the manifest. A failed write stops the pipeline: a writer
    // without its folder must not start (it used to be only logged, and the brief then had no plan at all).
    if (hasTaskHome(r.ctx.db, r.taskId)) {
      await exclude?.(TASK_HOME_EXCLUDE).catch((cause: unknown) => bb.log.warn(`Lane Pilot skipped the task-home exclude line: ${cause instanceof Error ? cause.message : String(cause)}`));
      const producer = { node: "task-folder", graph: "lp-task-pipeline", stage_id: "task-folder", wf_step_key: ctx.stepKey };
      const lines = reflexes.filter((line) => /WHEN\s+.+?\s*(?:→|->)\s*.+/.test(line));
      if (lines.length) await recordTaskHomeFile(r.ctx, { taskId: r.taskId, kind: "reflexes", name: "REFLEXES.md", content: `# Reflexes\n\n${lines.join("\n")}\n`, producer, readers: ["guard"] });
      const cards = (filecards ?? []).map((line) => maskCredentials(line.slice(0, 260)).text).filter(Boolean).slice(0, 40);
      if (cards.length) await recordTaskHomeFile(r.ctx, { taskId: r.taskId, kind: "filecards", name: "FILECARDS.md", content: `# File notes\n\n${cards.join("\n")}\n`, producer, readers: ["guard"] });
      return { ok: true };
    }
    // A task dispatched before the switch keeps its old folder to the end (no mixing inside one task); a failed write stops it too.
    try {
      await persistTaskFolder({
        taskId: r.taskId, plan: r.plan,
        // The project's accepted WHEN → act rules reach the writer's guard as REFLEXES.md (SMA k_hs_reflex).
        reflexes, filecards, exclude,
        exists: async (rel) => (await orMiss(Promise.resolve().then(() => bb.sdk.files.read({ hostId: r.config.hostId, rootPath: r.workspacePath, path: `${r.workspacePath}/${rel}` })), null, isNotFound)) !== null,
        writeFile: async (rel, content) => {
          await bb.sdk.files.write({ hostId: r.config.hostId, rootPath: r.workspacePath, path: `${r.workspacePath}/${rel}`, content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
        },
      });
    } catch (cause) {
      throw new Error(`Lane Pilot could not persist the task folder of ${r.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
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

  const pipelineExecutor = lpTaskPipelineExecutor(engine, bb);
  // The chain executor of the same key, when it is already on the engine, multiplexes to this pipeline by the runtime's
  // attemptId — registering over it would route a chain's code tasks here with the wrong runtime (server.ts order).
  if (!engine.hasExecutor("lp-task")) engine.register<DispatchRuntime>("lp-task", pipelineExecutor);
  provideLpTaskPipeline(engine, pipelineExecutor);
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
  const workflow = engine.resolveWorkflow(LP_TASK_PIPELINE);
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
  return wfLatestPipelineRunId(db, runId, taskId);
}

/**
 * The task's pipeline run is inside the planner loop now: a plan-revise step exists and the run has not ended. A PM update is taken then (it stops
 * the loop: lane_pilot_update_task records PM_STOPPED_PLANNER_LOOP), while an update during the first pm-read and critique is refused as before.
 */
export function plannerLoopActive(db: ServerCore["db"], runId: string, taskId: string): boolean {
  const pipelineRunId = dispatchRunOf(db, runId, taskId);
  if (!pipelineRunId) return false;
  return wfLiveRunHasStep(db, pipelineRunId, "plan-revise");
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
    const baseRef = (parseJsonOr(wfRunInputsJson(runtime.ctx.db, pipelineRunId) || "{}", {}) as { baseRef?: unknown }).baseRef;
    if (typeof baseRef === "string") runtime.baseRef = baseRef;
  } catch (cause) { runtime.ctx.log(`workflow ${pipelineRunId}: no baseRef: ${cause instanceof Error ? cause.message : String(cause)}`); }
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
  const out = parseJsonOr(critique?.output_json ?? "null", null) as { allowed?: unknown; reason?: unknown } | null;
  if (out && typeof out.allowed === "boolean") verdict = { allowed: out.allowed, ...(typeof out.reason === "string" ? { reason: out.reason } : {}) };
  return { ok: true, pipelineRunId, settled: status !== "running", critique: verdict };
}
