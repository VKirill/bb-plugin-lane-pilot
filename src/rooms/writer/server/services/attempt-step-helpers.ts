import { LP_EVENTS } from "@lane-pilot/contracts";
import { recordStage } from "../../../runs/server";
import {
  countAttempts, getAttempt, getReasoningTrace, getRunSettingsScopes,
  loadProjectSettings, taskBasePath,
} from "../../../storage";
import type { WorkflowEngine } from "../../../workflow";
import { isLiveDecision, LIVE_FOLDER_RECEIPT } from "../../models/live-folder";
import { WRITER_QUESTION_WAIT_MIN_KEY, WRITER_SILENCE_NUDGE_MIN_KEY } from "../../settings";
import { releaseAttemptAdmission } from "./attempt-admission";
import { QUESTION_WAIT_FALLBACK_SEC, WRITER_SILENCE_FALLBACK_SEC } from "../../models/attempt-timeouts";
import { emitAttemptEvent } from "./attempt-events";
import { emitAttemptFinished } from "./attempt-finished";
import type { DispatchRuntime } from "./dispatch-runtime";
import { shouldMergeAttemptWorktree } from "./spawn";
import { liveBackupKey } from "./start-live-folder";

export const silenceSecFor = (r: DispatchRuntime): number => {
  const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
  const min = Number(settings[WRITER_SILENCE_NUDGE_MIN_KEY]);
  return Number.isFinite(min) && min > 0 ? Math.round(min * 60) : WRITER_SILENCE_FALLBACK_SEC;
};

export const questionSecFor = (r: DispatchRuntime): number => {
  const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
  const min = Number(settings[WRITER_QUESTION_WAIT_MIN_KEY]);
  return Number.isFinite(min) && min > 0 ? Math.round(min * 60) : QUESTION_WAIT_FALLBACK_SEC;
};

export function executionSnapshot(r: DispatchRuntime, attemptId: string) {
  const fromRuntime = r.writerSelectionsByAttempt?.[attemptId];
  const trace = !fromRuntime ? getReasoningTrace(r.ctx.db, attemptId) : null;
  const sel = fromRuntime ?? (trace ? {
    providerId: trace.providerId,
    model: trace.model,
    reasoningLevel: trace.effectiveReasoningLevel,
    serviceTier: trace.serviceTier,
    selectionSource: trace.selectionSource,
  } : undefined);
  return sel ? {
    providerId: sel.providerId,
    model: sel.model,
    reasoningLevel: sel.reasoningLevel ?? null,
    serviceTier: sel.serviceTier ?? null,
    selectionSource: sel.selectionSource ?? null,
  } : undefined;
}

export function withAttemptWorkspace(r: DispatchRuntime, attemptId: string, baseResult: Record<string, unknown>): Record<string, unknown> {
  const binding = getAttempt(r.ctx.db, attemptId);
  if (!binding?.workspace_path) return baseResult;
  return {
    ...baseResult,
    workspace: {
      path: binding.workspace_path,
      environmentId: binding.environment_id,
      decision: binding.workspace_decision,
      ...(isLiveDecision(binding.workspace_decision) ? { mode: LIVE_FOLDER_RECEIPT } : {}),
    },
  };
}

export function recordTerminalWriterStages(
  r: DispatchRuntime,
  input: { attemptId: string; writerThreadId: string | null; terminal: "passed" | "failed" | "canceled"; result: Record<string, unknown>; reason?: string | null },
): void {
  const { attemptId, writerThreadId, terminal, result, reason } = input;
  const db = r.ctx.db;
  const execution = executionSnapshot(r, attemptId);
  const packetSha = r.executionPacketShaByAttempt?.[attemptId];
  const attempts = countAttempts(db, r.runId, r.taskId);
  const existing = listStageReceiptsSafe(db, r.runId, r.taskId);
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
    const current = existing.find((row) => row.stageId === stageId);
    if (current?.state === "pending" && terminal !== "canceled") {
      recordStage(db, { runId: r.runId, taskId: r.taskId, stageId, state: "running", input: r.plan });
    }
    const stageResult = stageId === "writer-agent"
      ? {
          ...result,
          ...(packetSha ? { executionPacketSha256: packetSha } : {}),
          ...(r.emergencyFallback ? { emergencyFallback: r.emergencyFallback } : {}),
          execution: execution ?? result,
        }
      : terminal === "passed"
      ? stageId === "verification"
        ? { produced: result.produced, verification: result.verification, runV2: result.runV2 }
        : result
      : null;
    recordStage(db, {
      runId: r.runId,
      taskId: r.taskId,
      stageId,
      state: terminal,
      input: r.plan,
      attempt: attempts,
      providerId: stageId === "writer-agent" ? execution?.providerId : undefined,
      model: stageId === "writer-agent" ? execution?.model : undefined,
      threadId: writerThreadId,
      result: stageResult,
      reason: terminal === "passed" ? undefined : (reason ?? undefined),
    });
  }
}

import { listStageReceipts } from "../../../storage";
function listStageReceiptsSafe(db: DispatchRuntime["ctx"]["db"], runId: string, taskId: string) {
  return listStageReceipts(db, runId, taskId);
}

export async function cleanupAttemptWorkspace(r: DispatchRuntime, attemptId: string, terminalState: string): Promise<void> {
  const attempt = getAttempt(r.ctx.db, attemptId);
  const rtServices = r.services as unknown as {
    restoreLiveFolder?: (input: { hostId: string; folder: string; backupId: string; task: { owns_paths: string[]; never_touch: string[] } }) => Promise<unknown>;
    rollback?: { noteWorktree(input: Record<string, unknown>): Promise<unknown>; noteSaved(attemptId: string, saved: unknown): void };
  };
  const base = taskBasePath(r.ctx.db, r.runId, r.taskId) ?? r.workspacePath;
  if (attempt && isLiveDecision(attempt.workspace_decision) && typeof rtServices.restoreLiveFolder === "function") {
    const folder = attempt.workspace_path ?? base;
    const backupId = ((await r.ctx.bb.storage?.kv?.get(liveBackupKey(attemptId)).catch(() => null)) as string | null)
      ?? r.liveBackupByAttempt?.[attemptId] ?? attemptId;
    if (r.liveBackupByAttempt) delete r.liveBackupByAttempt[attemptId];
    if (folder) {
      await rtServices.restoreLiveFolder({ hostId: r.config.hostId, folder, backupId, task: r.task }).catch(() => undefined);
    }
    return;
  }
  if (attempt?.workspace_path && attempt.environment_id === null && base && shouldMergeAttemptWorktree(attempt.workspace_path, base)) {
    await rtServices.rollback?.noteWorktree({ attemptId, hostId: r.config.hostId, basePath: base, worktreePath: attempt.workspace_path, outcome: `failed:${terminalState}` }).catch(() => undefined);
    const removed = await r.ctx.host?.call("gitRemoveWorktree", { requestedHostId: r.config.hostId, basePath: base, worktreePath: attempt.workspace_path, release: true }, { hostId: r.config.hostId, timeoutMs: 300_000 }).catch(() => null);
    if (removed) rtServices.rollback?.noteSaved(attemptId, removed.saved);
  }
}

export async function finalizeTerminalFailure(
  r: DispatchRuntime,
  engine: WorkflowEngine,
  input: {
    attemptId: string;
    writerThreadId: string | null;
    state: "blocked" | "validation_failed" | "canceled";
    reason: string;
    retryable: boolean;
    result: Record<string, unknown>;
  },
): Promise<void> {
  const { attemptId, writerThreadId, state, reason, retryable, result } = input;
  const rtServices = r.services as unknown as {
    providerRetry?: { abandon(threadId: string): Promise<unknown> };
  };
  const enrichedResult = withAttemptWorkspace(r, attemptId, result);
  if (!retryable) {
    await cleanupAttemptWorkspace(r, attemptId, state);
    if (writerThreadId && typeof rtServices.providerRetry?.abandon === "function") {
      await rtServices.providerRetry.abandon(writerThreadId).catch(() => undefined);
    }
  }
  const activeTask = r.activeTasksByAttempt?.[attemptId] ?? r.task;
  const activeConfig = r.activeConfigsByAttempt?.[attemptId] ?? r.runConfig;
  const sel = executionSnapshot(r, attemptId);
  await emitAttemptFinished(r.ctx, {
    scope: "attempt",
    projectId: r.projectId,
    runId: r.runId,
    taskId: r.taskId,
    attemptId,
    pmThreadId: r.threadId,
    writerThreadId,
    task: activeTask,
    config: activeConfig,
    status: state,
    reason,
    result: enrichedResult,
  }).catch(() => undefined);
  if (!retryable) {
    recordTerminalWriterStages(r, {
      attemptId,
      writerThreadId,
      terminal: state === "canceled" ? "canceled" : "failed",
      result: enrichedResult,
      reason,
    });
    r.ctx.refreshRun?.(r.runId);
    await emitAttemptFinished(r.ctx, {
      scope: "task",
      projectId: r.projectId,
      runId: r.runId,
      taskId: r.taskId,
      attemptId,
      pmThreadId: r.threadId,
      writerThreadId,
      task: activeTask,
      config: activeConfig,
      writerSelection: sel ? { providerId: sel.providerId, model: sel.model } : undefined,
      status: state,
      reason,
      result: enrichedResult,
    }).catch(() => undefined);
  } else {
    r.ctx.refreshRun?.(r.runId);
  }
  await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
  await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId, taskId: r.taskId, state, reason }, projectId: r.projectId, now: engine.now() });
}
