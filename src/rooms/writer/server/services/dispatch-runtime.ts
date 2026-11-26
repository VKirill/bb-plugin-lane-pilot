import { TERMINAL_ATTEMPT_STATES } from "../../../contracts";
import type { PrototypeConfig, TaskV2 } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import type { BaselineApi } from "../../../baseline/server";
import type { StageHelperSettings } from "../../../platform/server";
import { recordStage } from "../../../runs/server";
import { getAttempt, listStageReceipts } from "../../../storage";
import type { RunSummary } from "../../../workflow";
import { pmReadBrief } from "../../models/writer-brief";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStartApi } from "./start";

/** The fields of the services bag the task pipeline reads, typed by the rooms that own them. */
export interface DispatchServices {
  stageHelperSettings: StageHelperSettings;
  baseline: BaselineApi;
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  startWriterTask: WriterStartApi["startWriterTask"];
}

/** What the executors need from the dispatch that started the run. It lives in memory: a reload ends this pipeline (see `resumePolicy`) and start-up recovery starts it again from the stored task (`resumeDispatch`). */
export type DispatchRuntime = {
  ctx: ServerCore;
  services: DispatchServices;
  threadId: string;
  projectId: string;
  baseRef?: string;
  runId: string;
  taskId: string;
  attemptId: string;
  config: PrototypeConfig;
  runConfig: PrototypeConfig;
  workspacePath: string;
  task: TaskV2;
  plan: string;
  lintWarnings: string[];
  live?: boolean;
  pmReadContext?: string;
  queuedReply?: Record<string, unknown>;
  dirtBeforeByAttempt?: Record<string, Array<{ path: string; sha256: string }>>;
  liveBaselineDirt?: Array<{ path: string; sha256: string }>;
  liveBackupByAttempt?: Record<string, string>;
  activeTasksByAttempt?: Record<string, TaskV2>;
  activeConfigsByAttempt?: Record<string, PrototypeConfig>;
  executionPacketShaByAttempt?: Record<string, string>;
  writerSelectionsByAttempt?: Record<string, {
    providerId: string;
    model: string;
    reasoningLevel?: string;
    serviceTier?: string | null;
    selectionSource?: unknown;
  }>;
  previousTurn?: { failure: string; diff: string | null; streamError: boolean } | null;
  providerErrorRetries?: number;
  primaryFailure?: { status?: string; reason?: string; attemptId?: string; failureCode?: unknown } | null;
  emergencyFallback?: {
    state?: string;
    reason: string;
    trigger?: string;
    primaryAttemptId?: string;
    attemptId?: string;
    providerId: string;
    model: string;
  } | null;
};

export const WRITER_WAIT_NODES = new Set(["admission-wait", "writer", "wait-turn", "wait-answer", "merge-wait", "stop-exit-wait", "stop-handback-wait"]);

/**
 * Marks skipped a stage that has not run; a verdict it already has stays. MagicSEO replay concert-scheduler (2026-10-31): the plan
 * critique passed, so did the specialist review; the PM changed the plan, its new critique blocked, and skipping the passed review
 * threw «illegal stage transition specialist-review: passed -> skipped» — the run failed instead of blocking.
 */
export function skipOpenStage(r: DispatchRuntime, stageId: Parameters<typeof recordStage>[1]["stageId"], reason: string): void {
  const current = listStageReceipts(r.ctx.db, r.runId, r.taskId).find((row) => row.stageId === stageId);
  if (current && current.state !== "pending") return;
  recordStage(r.ctx.db, { runId: r.runId, taskId: r.taskId, stageId, state: "skipped", input: r.plan, reason });
}

export function skipWriterStages(r: DispatchRuntime, reason: string): void {
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

export function blockedReply(r: DispatchRuntime, reason: string | undefined): Record<string, unknown> {
  return { runId: r.runId, taskId: r.taskId, attemptId: r.attemptId, state: "blocked", reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) };
}

/** Builds the immediate queued dispatch reply once the pipeline has passed the pre-writer stage barrier. */
export function buildQueuedReply(r: DispatchRuntime, writerThreadId: string | null = null): Record<string, unknown> {
  const openQuestions = r.pmReadContext ? pmReadBrief(r.pmReadContext).openQuestions : [];
  const warnings: string[] = [...r.lintWarnings];
  if (r.live) warnings.push("mode live-folder: this folder has no git. The writer edits the live files in place; nothing is committed or merged, so there is no ship step. One writer at a time works in the folder, later tasks queue. A task that is not accepted is rolled back from a backup of its owns_paths (~/.lane-pilot/live-backups, kept 7 days); files outside owns_paths are not rolled back.");
  return {
    runId: r.runId,
    taskId: r.taskId,
    attemptId: r.attemptId,
    writerThreadId,
    state: "queued",
    stages: listStageReceipts(r.ctx.db, r.runId, r.taskId),
    ...(warnings.length ? { warnings } : {}),
    ...(openQuestions.length ? {
      pmReadOpenQuestions: openQuestions,
      pmReadNote: "The writer does not see these questions. If one changes what the writer should do, wait for this attempt's receipt and, if it is not accepted, dispatch again with the answer in the plan; otherwise the writer decides from the code.",
    } : {}),
  };
}

/** What the dispatch tool answers with once the run stops: the reply of the node that ended it. A failed run throws the step's own message. */
export function dispatchReply(summary: RunSummary, runtime?: DispatchRuntime): Record<string, unknown> | null {
  if (summary.status === "succeeded") return (summary.output?.reply as Record<string, unknown> | undefined) ?? null;
  if (summary.status === "waiting") {
    const partial = summary.waiting[0]?.partial?.reply as Record<string, unknown> | undefined;
    if (partial) return partial;
    const waitNode = summary.waiting[0]?.nodeId;
    if (runtime && waitNode && WRITER_WAIT_NODES.has(waitNode)) {
      return runtime.queuedReply ?? buildQueuedReply(runtime, getAttempt(runtime.ctx.db, runtime.attemptId)?.thread_id ?? null);
    }
    return null;
  }
  if (summary.status === "failed") throw new Error(summary.error ?? summary.reason ?? "workflow failed");
  return null;
}

export const WRITER_STAGES = ["writer-agent", "verification", "acceptance-receipt"] as const;
export const TERMINAL_ATTEMPT: readonly string[] = TERMINAL_ATTEMPT_STATES;

export function reopenWriterStages(db: ServerCore["db"], runId: string, taskId: string, plan: string): void {
  const rows = listStageReceipts(db, runId, taskId);
  for (const stageId of WRITER_STAGES) {
    const current = rows.find((row) => row.stageId === stageId);
    if (!current || ["failed", "blocked", "skipped"].includes(current.state)) {
      recordStage(db, { runId, taskId, stageId, state: "pending", input: plan, reopen: true, replaceOnNewInput: true });
    }
  }
}
