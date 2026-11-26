import { LP_EVENTS, isTerminalAttemptState } from "@lane-pilot/contracts";
import { bestEffort, id } from "@lane-pilot/kit";
import type { WriterFallback } from "@lane-pilot/models";
import { failureClass } from "../../../contracts";
import { postOwnerItem } from "../../../owner-waiting";
import { closeWriterStages, recordStage } from "../../../runs/server";
import {
  getAttempt, getReasoningTrace, listStageReceipts, transitionAttempt, createAttempt,
} from "../../../storage";
import { retargetTask } from "../../../tasks";
import type { WorkflowEngine } from "../../../workflow";
import { emergencyFallbackDecision } from "../../models/emergency-writer";
import { releaseAttemptAdmission } from "./attempt-admission";
import { emitAttemptEvent } from "./attempt-events";
import { emitAttemptFinished } from "./attempt-finished";
import { startThreadTurnWatcher } from "./attempt-turn-watch";
import { copyRefusedKeyPrefix } from "../../models/copy-refused-key";
import { buildQueuedReply, type DispatchRuntime } from "./dispatch-runtime";
import { shouldMergeAttemptWorktree } from "./spawn";
import { liveBackupKey } from "./start-live-folder";
import { createWriterSticky } from "./sticky";
import { collectHandoffBrief } from "./writer-handoff";
import { previousAttemptBrief } from "../../models/writer-brief-feedback";
import { stickyTurnPrompt } from "../../models/writer-task";

export type SpawnAttemptResult = {
  ok?: boolean;
  threadId?: string;
  writerThreadId?: string;
  status?: string;
  reason?: string;
  providerId?: string | null;
  model?: string | null;
  reasoningLevel?: string;
  serviceTier?: "default" | "fast" | null;
  selectionSource?: unknown;
  executionPacketSha256?: string;
  dirtBefore?: Array<{ path: string; sha256: string }>;
  workspacePath?: string;
};

export type SpawnServicesShape = {
  spawnWriterAttempt?: (input: unknown) => Promise<SpawnAttemptResult>;
  startWriterTask: (input: Record<string, unknown>) => unknown;
  runBudgetFor?: (runId: string, settings: Record<string, unknown>) => { check(): { ok: boolean; reason?: string } };
  taskWords?: unknown;
  providerBreaker?: unknown;
  ownerPresence?: unknown;
  providerUsage?: unknown;
  money?: unknown;
  providerRetry?: { abandon(threadId: string): Promise<unknown> };
  rollback?: { noteWorktree(input: Record<string, unknown>): Promise<unknown>; noteSaved(attemptId: string, saved: unknown): void; ensureBase?(attemptId: string, hostId: string, path: string): void };
  workspaceDirt?: (config: unknown, path: string, runId: string) => Promise<{ ok: true; snapshots: Array<{ path: string; sha256: string }> } | { ok: false; reason: string }>;
};

export async function tryStickyContinuation(input: {
  r: DispatchRuntime;
  engine: WorkflowEngine;
  rtServices: SpawnServicesShape;
  attemptId: string;
  prevFailedFull: NonNullable<ReturnType<typeof getAttempt>>;
  isLive: boolean;
  silenceSec: number;
  now: number;
}): Promise<Record<string, unknown> | null> {
  const { r, engine, rtServices, attemptId, prevFailedFull, isLive, silenceSec, now } = input;
  if (!prevFailedFull.thread_id || (prevFailedFull.state !== "validation_failed" && prevFailedFull.state !== "empty_output")
    || typeof (r.ctx.bb.sdk.threads as { send?: unknown }).send !== "function"
    || typeof rtServices.workspaceDirt !== "function" || !rtServices.rollback) {
    return null;
  }
  const sticky = createWriterSticky(r.ctx, { rollback: rtServices.rollback as never, workspaceDirt: rtServices.workspaceDirt as never });
  const redo = await sticky.retryWriter(prevFailedFull.id, r.runId);
  if (!redo) return null;
  const bound = retargetTask(r.task, redo.workspacePath);
  const prevBrief = previousAttemptBrief({ status: prevFailedFull.state, reason: prevFailedFull.reason ?? undefined, produced: [] }, r.task, prevFailedFull.dirt_before ?? [], isLive);
  const makePrompt = (conflicts: string[]) => stickyTurnPrompt({ kind: redo.kind, task: bound, previousAttempt: prevBrief, conflicts, liveFolder: isLive });
  const keepDirt = isLive ? (r.liveBaselineDirt ?? prevFailedFull.dirt_before ?? []) : (prevFailedFull.dirt_before ?? []);
  const turn = await sticky.continueInThread({
    runId: r.runId, taskId: r.taskId, attemptId, config: r.runConfig, writer: redo,
    kind: redo.kind, dirtBefore: keepDirt as never, prompt: makePrompt,
  });
  if (!turn.ok) return null;
  if (isLive) {
    const prevBackup = ((await r.ctx.bb.storage?.kv?.get(liveBackupKey(prevFailedFull.id)).catch(() => null)) as string | null)
      ?? r.liveBackupByAttempt?.[prevFailedFull.id] ?? prevFailedFull.id;
    if (!r.liveBackupByAttempt) r.liveBackupByAttempt = {};
    r.liveBackupByAttempt[attemptId] = prevBackup;
    await bestEffort(r.ctx.log, "writer live backup carry", r.ctx.bb.storage?.kv?.set(liveBackupKey(attemptId), prevBackup as never) as Promise<unknown>, undefined);
  }
  if (!r.dirtBeforeByAttempt) r.dirtBeforeByAttempt = {};
  r.dirtBeforeByAttempt[attemptId] = isLive && r.liveBaselineDirt ? r.liveBaselineDirt : turn.dirtBefore;
  if (!r.activeTasksByAttempt) r.activeTasksByAttempt = {};
  r.activeTasksByAttempt[attemptId] = bound;
  const trace = getReasoningTrace(r.ctx.db, attemptId);
  const sel = trace ? {
    providerId: trace.providerId, model: trace.model, reasoningLevel: trace.effectiveReasoningLevel,
    serviceTier: trace.serviceTier, selectionSource: trace.selectionSource,
  } : undefined;
  if (sel) {
    if (!r.writerSelectionsByAttempt) r.writerSelectionsByAttempt = {};
    r.writerSelectionsByAttempt[attemptId] = sel;
  }
  recordStage(r.ctx.db, {
    runId: r.runId, taskId: r.taskId, stageId: "writer-agent", state: "running", input: r.plan,
    providerId: sel?.providerId, model: sel?.model, threadId: redo.threadId,
    result: { status: "running", attemptId, writerThreadId: redo.threadId, ...(sel ? { execution: sel } : {}) },
  });
  r.queuedReply = buildQueuedReply(r, redo.threadId);
  startThreadTurnWatcher({
    bb: r.ctx.bb, db: r.ctx.db, engine, attemptId, taskId: r.taskId, projectId: r.projectId,
    writerThreadId: redo.threadId, isDisposed: () => r.ctx.isDisposed?.() ?? false,
  });
  return {
    status: "running", attemptId, writerThreadId: redo.threadId, silenceSec, until: now + silenceSec * 1_000,
    reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "running", writerThreadId: redo.threadId, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
  };
}

export async function tryEmergencyFallbackSpawn(input: {
  r: DispatchRuntime;
  rtServices: SpawnServicesShape;
  attemptId: string;
  attempt: ReturnType<typeof getAttempt>;
  priorAttempts: ReturnType<typeof import("../../../storage").listAttemptsForTask>;
  prevFailedFull: ReturnType<typeof getAttempt> | null;
  isLive: boolean;
  pmReadContext: string;
  prev: string;
  fallbackList: Array<WriterFallback & { pm: boolean }>;
}): Promise<{ attemptId: string; spawned: SpawnAttemptResult | null; attemptedEmergency: { providerId: string; model: string; trigger: string } | null }> {
  const { r, rtServices, attempt, priorAttempts, prevFailedFull, isLive, pmReadContext, prev, fallbackList } = input;
  let { attemptId } = input;
  let spawned: SpawnAttemptResult | null = null;
  let attemptedEmergency: { providerId: string; model: string; trigger: string } | null = null;
  const prevFail = r.primaryFailure ?? { status: "provider_error", reason: attempt?.reason ?? undefined, attemptId };
  const decision = emergencyFallbackDecision({
    state: String(prevFail.status ?? "provider_error"),
    reason: typeof prevFail.reason === "string" ? prevFail.reason : null,
    failureCode: typeof prevFail.failureCode === "string" ? prevFail.failureCode : null,
  });
  if (!decision.run) return { attemptId, spawned, attemptedEmergency };
  if (typeof rtServices.providerRetry?.abandon === "function") {
    for (const row of priorAttempts) {
      if (row.thread_id && row.state !== "accepted") {
        await rtServices.providerRetry.abandon(row.thread_id).catch(() => undefined);
      }
    }
  }
  const continuation = prevFailedFull?.thread_id && prevFailedFull.workspace_path && !isLive
    ? {
        workspacePath: prevFailedFull.workspace_path,
        environmentId: prevFailedFull.environment_id,
        dirtBefore: prevFailedFull.dirt_before,
        fromThreadId: prevFailedFull.thread_id,
        brief: await collectHandoffBrief({
          bb: r.ctx.bb, host: r.ctx.host, hostId: r.runConfig.hostId,
          threadId: prevFailedFull.thread_id, workspacePath: prevFailedFull.workspace_path,
          stopReason: `${String(prevFail.status ?? "provider_error")}${typeof prevFail.reason === "string" && prevFail.reason ? `: ${prevFail.reason}` : ""}`,
        }),
      }
    : undefined;
  for (let fbIdx = 0; fbIdx < fallbackList.length; fbIdx++) {
    const fb = fallbackList[fbIdx]!;
    if (fbIdx > 0 && spawned && !spawned.ok && spawned.status !== "canceled") {
      const prevCur = getAttempt(r.ctx.db, attemptId);
      if (prevCur && !isTerminalAttemptState(prevCur.state)) {
        transitionAttempt(r.ctx.db, attemptId, "blocked", { reason: `emergency_fallback_failed:${spawned.reason ?? "spawn_rejected"}` });
      }
      attemptId = id("att");
      createAttempt(r.ctx.db, { id: attemptId, runId: r.runId, taskId: r.taskId });
      r.attemptId = attemptId;
    }
    attemptedEmergency = { providerId: fb.providerId, model: fb.model, trigger: decision.reason };
    spawned = await rtServices.spawnWriterAttempt!({
      projectId: r.projectId, runId: r.runId, taskId: r.taskId, attemptId,
      config: r.runConfig, task: r.task, plan: r.plan, pmThreadId: r.threadId, pmReadContext,
      emergency: { providerId: fb.providerId, model: fb.model, reason: decision.reason, ...(fb.pm ? {} : { reasoningLevel: fb.reasoningLevel }) },
      ...(continuation ? { continuation } : {}),
      ...(prev ? { previousAttempt: prev } : {}),
    });
    if (spawned.ok || spawned.status === "canceled") break;
  }
  return { attemptId, spawned, attemptedEmergency };
}

export async function handleSpawnRejected(input: {
  r: DispatchRuntime;
  engine: WorkflowEngine;
  rtServices: SpawnServicesShape;
  attemptId: string;
  attemptCount: number;
  spawned: SpawnAttemptResult;
  attemptedEmergency: { providerId: string; model: string; trigger: string } | null;
  now: number;
}): Promise<Record<string, unknown>> {
  const { r, engine, rtServices, attemptId, attemptCount, spawned, attemptedEmergency, now } = input;
  await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
  const rawReason = spawned.reason ?? spawned.status ?? "spawn_rejected";
  const reason = attemptedEmergency ? `emergency_fallback_failed:${rawReason}` : rawReason;
  const currentAfter = getAttempt(r.ctx.db, attemptId);
  if (spawned.status === "canceled" || currentAfter?.state === "canceled") {
    closeWriterStages(r.ctx.db, { runId: r.runId, taskId: r.taskId, plan: r.plan, terminal: "canceled", attempt: attemptCount, reason });
    r.ctx.refreshRun?.(r.runId);
    await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId, taskId: r.taskId, state: "canceled", reason }, projectId: r.projectId });
    return { status: "already_settled", attemptId, attemptState: "canceled", retryable: false, reason, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "canceled", retryable: false, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
  }
  if (attemptedEmergency) {
    r.emergencyFallback = {
      state: "failed", reason: rawReason, trigger: attemptedEmergency.trigger, attemptId,
      providerId: attemptedEmergency.providerId, model: attemptedEmergency.model,
    };
  }
  const nonRetryableSpawn = Boolean(attemptedEmergency)
    || rawReason.startsWith("attempt_worktree_")
    || rawReason.startsWith("execution_packet_failed:")
    || rawReason.startsWith("retry_safety:")
    || spawned.status === "blocked"
    || failureClass(spawned.status ?? "spawn_rejected", rawReason) === "budget";
  if (nonRetryableSpawn) {
    if (currentAfter && currentAfter.state === "spawn_rejected") {
      transitionAttempt(r.ctx.db, attemptId, "blocked", { reason });
    } else if (currentAfter && !isTerminalAttemptState(currentAfter.state)) {
      transitionAttempt(r.ctx.db, attemptId, "blocked", { reason });
    }
    if (rawReason.startsWith("attempt_worktree_")) {
      const detail = rawReason.replace(/^attempt_worktree_(failed|baseline_failed|not_clean|provision_[a-z_]+):?/, "") || rawReason;
      const refusedKey = `${copyRefusedKeyPrefix(r.runId, r.taskId)}${attemptId}`;
      try {
        postOwnerItem(r.ctx.db, {
          key: refusedKey,
          source: "writer",
          kind: "copy_refused",
          reason: "blocked",
          projectId: r.projectId,
          wake: false,
          what: "Не удалось подготовить рабочую копию для задачи",
          why: `${rawReason.slice(0, 200)} (${detail.slice(0, 120)})`,
          evidence: [{ kind: "run", ref: r.runId }, { kind: "task", ref: r.taskId }, { kind: "attempt", ref: attemptId }],
        }, now);
      } catch { /* ignore */ }
    }
    const base = r.task.project_cwd;
    if (currentAfter?.workspace_path && currentAfter.environment_id === null && base && shouldMergeAttemptWorktree(currentAfter.workspace_path, base)) {
      await rtServices.rollback?.noteWorktree({ attemptId, hostId: r.config.hostId, basePath: base, worktreePath: currentAfter.workspace_path, outcome: "failed:blocked" }).catch(() => undefined);
      const removed = await r.ctx.host?.call("gitRemoveWorktree", { requestedHostId: r.config.hostId, basePath: base, worktreePath: currentAfter.workspace_path, release: true }, { hostId: r.config.hostId, timeoutMs: 300_000 }).catch(() => null);
      if (removed) rtServices.rollback?.noteSaved(attemptId, removed.saved);
    }
    const blockResult = { status: "blocked", reason, attemptId, ...(r.emergencyFallback ? { emergencyFallback: r.emergencyFallback } : {}) };
    closeWriterStages(r.ctx.db, { runId: r.runId, taskId: r.taskId, plan: r.plan, terminal: "failed", attempt: attemptCount, reason, result: blockResult });
    await emitAttemptFinished(r.ctx, { scope: "attempt", projectId: r.projectId, runId: r.runId, taskId: r.taskId, attemptId, pmThreadId: r.threadId, writerThreadId: null, task: r.task, config: r.runConfig, status: "blocked", reason, result: blockResult }).catch(() => undefined);
    await emitAttemptFinished(r.ctx, { scope: "task", projectId: r.projectId, runId: r.runId, taskId: r.taskId, attemptId, pmThreadId: r.threadId, writerThreadId: null, task: r.task, config: r.runConfig, status: "blocked", reason, result: blockResult }).catch(() => undefined);
    r.ctx.refreshRun?.(r.runId);
    await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId, taskId: r.taskId, state: "blocked", reason }, projectId: r.projectId });
    return { status: "already_settled", attemptId, attemptState: "blocked", retryable: false, reason, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: false, reason, ...(r.emergencyFallback ? { emergencyFallback: r.emergencyFallback } : {}), stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
  }
  await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId, taskId: r.taskId, state: spawned.status ?? "spawn_rejected", reason }, projectId: r.projectId });
  return { status: "provider_error", attemptId, retryable: true, reason, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: spawned.status ?? "spawn_rejected", retryable: true, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } };
}
