import type Database from "better-sqlite3";
import { costUsd, priceFor } from "@lane-pilot/models";
import {
  attemptContractRowsSince,
  listProjectAttemptsSince,
  listProjectGateEventsSince,
  listProjectStageEventsSince,
  listProjectTransitionsSince,
  listRunQueueAttempts,
  listRunTransitions,
  stageReceiptProviderModel,
} from "../../../storage";
import { billedFrom, parseBreakdown } from "../../models/token-math";
import { DAY_MS } from "../../models/token-usage";
import {
  attemptEnded,
  firstByTier,
  queueWaitMs,
  queueWaitPercentiles,
  stageRecords,
  writerTier,
  type AttemptMetrics,
  type AttemptMetricsReport,
  type AttemptRow,
  type CostState,
  type TransitionRow,
} from "../../models/attempt-metrics";
import { loadCursorsByThreadIds, tokenCursorRow } from "../repositories/token-usage-repository";

/** Queue waits of one run's attempts, settled only — the run card's p50/p99. */
export function runQueueWaits(db: Database.Database, runId: string): number[] {
  const attempts = listRunQueueAttempts(db, runId);
  const transitions = listRunTransitions(db, runId);
  const byAttempt = new Map<string, TransitionRow[]>();
  for (const row of transitions) byAttempt.set(row.attempt_id, [...(byAttempt.get(row.attempt_id) ?? []), row]);
  return attempts.map((attempt) => queueWaitMs(byAttempt.get(attempt.id) ?? [], attempt)).filter((ms) => ms >= 0).sort((a, b) => a - b);
}

/**
 * What an attempt cost and how far it got, per attempt, with an honest «not measured» (P0-2 of the SMA plan).
 * `taskId` narrows the report to one task (the acceptance card); the window and the numbers are the same as for the project.
 */
export function attemptMetrics(db: Database.Database, input: { projectId: string; days: number; now?: number; taskId?: string }): AttemptMetricsReport {
  const now = input.now ?? Date.now();
  const since = now - input.days * DAY_MS;
  const attempts = listProjectAttemptsSince(db, { projectId: input.projectId, sinceMs: since, taskId: input.taskId });
  // Helper stages run before the first attempt of a task exists: read events from a day earlier.
  const stageEvents = listProjectStageEventsSince(db, { projectId: input.projectId, sinceMs: since - DAY_MS, taskId: input.taskId });
  const gateEvents = listProjectGateEventsSince(db, { projectId: input.projectId, sinceMs: since - DAY_MS, taskId: input.taskId });
  const transitions = listProjectTransitionsSince(db, { projectId: input.projectId, sinceMs: since, taskId: input.taskId });
  const transitionsByAttempt = new Map<string, TransitionRow[]>();
  for (const row of transitions) transitionsByAttempt.set(row.attempt_id, [...(transitionsByAttempt.get(row.attempt_id) ?? []), row]);
  const threadIds = [...new Set(attempts.flatMap((row) => row.thread_id ? [row.thread_id] : []))];
  const cursors = loadCursorsByThreadIds(db, threadIds);
  const writerReceipt = { get: (runId: string, taskId: string) => stageReceiptProviderModel(db, runId, taskId, "writer-agent") };

  const byTask = new Map<string, AttemptRow[]>();
  for (const row of attempts) byTask.set(`${row.run_id}\u0000${row.task_id}`, [...(byTask.get(`${row.run_id}\u0000${row.task_id}`) ?? []), row]);
  // The task's last attempt on each thread carries the thread's tokens.
  const lastOnThread = new Map<string, string>();
  for (const row of attempts) if (row.thread_id) lastOnThread.set(row.thread_id, row.id);

  const rows: AttemptMetrics[] = [];
  for (const list of byTask.values()) {
    list.forEach((attempt, index) => {
      const from = index === 0 ? -Infinity : attempt.created_at;
      const to = list[index + 1]?.created_at ?? Infinity;
      const inWindow = <T extends { run_id: string; task_id: string; occurred_at: number }>(event: T) =>
        event.run_id === attempt.run_id && event.task_id === attempt.task_id && event.occurred_at >= from && event.occurred_at < to;
      const stages = stageRecords(stageEvents.filter(inWindow));
      const gates = gateEvents.filter(inWindow);
      const receipt = writerReceipt.get(attempt.run_id, attempt.task_id) as { provider_id: string | null; model: string | null } | undefined;
      const cursor = attempt.thread_id ? cursors.get(attempt.thread_id) : undefined;
      const providerId = (cursor?.last_provider || cursor?.provider_id || receipt?.provider_id || null) ?? null;
      const model = (cursor?.last_model || receipt?.model || null) ?? null;
      const billed = cursor ? billedFrom(parseBreakdown(cursor.total_json)) : null;
      const turns = cursor ? ((JSON.parse(cursor.total_json || "{}") as { turns?: number }).turns) ?? 0 : 0;
      const reported = billed !== null && (billed.total > 0 || billed.output > 0);
      let costState: CostState = "not_measured", costNote: string | null = null;
      let tokens: AttemptMetrics["tokens"] = null, cost: number | null = null;
      if (!attempt.thread_id) {
        costNote = "no writer thread was started";
      } else if (!reported) {
        costNote = cursor ? `${providerId ?? "the provider"} reports no token usage` : "no usage row for the thread (the provider reports none, or the sync has not seen it)";
      } else if (lastOnThread.get(attempt.thread_id) !== attempt.id) {
        costState = "partial";
        costNote = "the writer thread is shared with a later attempt of the task; its tokens are counted there";
      } else {
        tokens = { input: billed.input, output: billed.output, cached: billed.cached, total: billed.total };
        cost = model ? costUsd(model, billed) : null;
        if (cost === null) { costState = "partial"; costNote = model && !priceFor(model) ? `model ${model} is not in the price table` : "no model recorded"; }
        else costState = "measured";
      }
      rows.push({
        taskId: attempt.task_id, attemptId: attempt.id, attemptNo: attempt.attempt_no, state: attempt.state, createdAt: attempt.created_at,
        seconds: attemptEnded(attempt.state) ? Math.max(0, Math.round((attempt.updated_at - attempt.created_at) / 1000)) : null,
        queueWaitMs: (() => { const ms = queueWaitMs(transitionsByAttempt.get(attempt.id) ?? [], attempt); return ms >= 0 ? ms : null; })(),
        stages, stagesPassed: stages.filter((row) => row.state === "passed").length,
        stagesFailed: stages.filter((row) => row.state === "failed" || row.state === "blocked").length,
        gates: { passed: gates.filter((row) => row.status === "passed").length, rejected: gates.filter((row) => row.status === "rejected" || row.status === "failed").length },
        writer: { threadId: attempt.thread_id, providerId, model, tier: writerTier(providerId, model) },
        tokens, turns, costUsd: cost, costState, costNote,
      });
    });
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  const measured = rows.filter((row) => row.costState === "measured");
  // H2: attempts parked while every writer provider was held journal the wait as queued→queued rows with
  // `waiting_writer:` reasons; an attempt with at least one counts as held.
  const heldAttempts = rows.filter((row) =>
    (transitionsByAttempt.get(row.attemptId) ?? []).some((row2) => row2.reason?.startsWith("waiting_writer:"))).length;
  const acceptedTasks = new Set(rows.filter((row) => row.state === "accepted").map((row) => `${row.taskId}`)).size;
  const notMeasuredByProvider: Record<string, number> = {};
  for (const row of rows) if (row.costState === "not_measured") {
    const key = row.writer.threadId ? row.writer.providerId ?? "no usage row" : "no writer thread";
    notMeasuredByProvider[key] = (notMeasuredByProvider[key] ?? 0) + 1;
  }
  return {
    projectId: input.projectId, days: input.days, since,
    summary: {
      attempts: rows.length, measured: measured.length, partial: rows.filter((row) => row.costState === "partial").length,
      notMeasured: rows.filter((row) => row.costState === "not_measured").length,
      measuredCostUsd: measured.length ? measured.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) : null,
      measuredTokens: measured.length ? measured.reduce((sum, row) => sum + (row.tokens?.total ?? 0), 0) : null,
      notMeasuredByProvider,
      stagesPassed: rows.reduce((sum, row) => sum + row.stagesPassed, 0), stagesFailed: rows.reduce((sum, row) => sum + row.stagesFailed, 0),
      queueWait: queueWaitPercentiles(rows.flatMap((row) => row.queueWaitMs == null ? [] : [row.queueWaitMs]).sort((a, b) => a - b)),
      firstByTier: firstByTier(rows),
      attemptsPerAcceptedTask: acceptedTasks ? Math.round(rows.length / acceptedTasks * 100) / 100 : null,
      heldShare: rows.length ? Math.round(heldAttempts / rows.length * 1000) / 1000 : null,
    },
    attempts: rows,
  };
}

/**
 * Attempts since `sinceMs` whose writer thread reported no token usage (the vendor is silent): provider, model and the
 * task's appetite in tokens, so the money book can price them as estimates (SMA «Estimate when the vendor is silent»).
 */
export function unmeasuredAttempts(db: Database.Database, input: { sinceMs: number }): Array<{ taskId: string; attemptId: string; threadId: string; providerId: string | null; model: string | null; appetiteTokens: number | null }> {
  const attempts = attemptContractRowsSince(db, input.sinceMs);
  const out: Array<{ taskId: string; attemptId: string; threadId: string; providerId: string | null; model: string | null; appetiteTokens: number | null }> = [];
  for (const row of attempts) {
    const cursor = tokenCursorRow(db, row.thread_id);
    const billed = cursor ? billedFrom(parseBreakdown(cursor.total_json)) : null;
    if (billed !== null && (billed.total > 0 || billed.output > 0)) continue;
    const receipt = stageReceiptProviderModel(db, row.run_id, row.task_id, "writer-agent") as { provider_id?: string | null; model?: string | null } | undefined;
    let appetiteTokens: number | null = null;
    try {
      const contract = JSON.parse(row.contract_json) as { appetite?: { tokens?: unknown } };
      appetiteTokens = typeof contract.appetite?.tokens === "number" && contract.appetite.tokens > 0 ? contract.appetite.tokens : null;
    } catch { /* a contract that does not parse has no appetite */ }
    out.push({
      taskId: row.task_id, attemptId: row.attempt_id, threadId: row.thread_id,
      providerId: (cursor?.last_provider || cursor?.provider_id || receipt?.provider_id) ?? null,
      model: (cursor?.last_model || receipt?.model) ?? null,
      appetiteTokens,
    });
  }
  return out;
}

/**
 * Token totals of the finished attempts since `sinceMs` that did report usage, per provider+model, newest first (SMA
 * «Estimate when the vendor is silent»: the silent attempt's estimate is the median of the last 20 of its own lane).
 */
export function measuredAttemptTokens(db: Database.Database, input: { sinceMs: number; limit?: number }): Map<string, number[]> {
  const byLane = new Map<string, Array<{ createdAt: number; total: number }>>();
  for (const row of attemptContractRowsSince(db, input.sinceMs)) {
    const cursor = tokenCursorRow(db, row.thread_id);
    const billed = cursor ? billedFrom(parseBreakdown(cursor.total_json)) : null;
    if (billed === null || !(billed.total > 0)) continue;
    const receipt = stageReceiptProviderModel(db, row.run_id, row.task_id, "writer-agent") as { provider_id?: string | null; model?: string | null } | undefined;
    const providerId = (cursor?.last_provider || cursor?.provider_id || receipt?.provider_id) ?? null;
    const model = (cursor?.last_model || receipt?.model) ?? null;
    const key = `${providerId ?? ""}${model ?? ""}`;
    byLane.set(key, [...(byLane.get(key) ?? []), { createdAt: row.created_at, total: billed.total }]);
  }
  const limit = input.limit ?? 20;
  return new Map([...byLane].map(([key, rows]) => [key, rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((row) => row.total)]));
}
