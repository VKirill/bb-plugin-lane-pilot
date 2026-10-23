import type Database from "better-sqlite3";
import { costUsd, priceFor } from "@lane-pilot/models";
import { STAGE_PROOF } from "../../tasks";
import { billedFrom, parseBreakdown } from "../token-math";

/**
 * What an attempt cost and how far it got, per attempt, with an honest «not measured» (P0-2 of the SMA plan).
 * - stages: the stage events inside the attempt's window (the first attempt of a task also holds the helper stages before it), with
 *   the seconds from `running` to the end; null when the stage never reported `running`;
 * - gates: the gate events of that window by status;
 * - tokens and cost: the writer thread's row of `lane_pilot_token_cursor` priced from `packages/models/src/model-prices.ts` (a list
 *   price, also for a subscription). A provider that reports no usage (acp-cursor, opencode) has no row or an all-zero one: that is
 *   `not_measured`, tokens and cost are null, never 0. A thread several attempts share (a sticky writer) is not split: its tokens
 *   sit on the task's last attempt there, the others are `partial`.
 */
export type CostState = "measured" | "partial" | "not_measured";

export type AttemptStage = { stageId: string; state: string; seconds: number | null; proof: string };
export type AttemptMetrics = {
  taskId: string; attemptId: string; attemptNo: number; state: string; createdAt: number;
  seconds: number | null;
  stages: AttemptStage[]; stagesPassed: number; stagesFailed: number;
  gates: { passed: number; rejected: number };
  writer: { threadId: string | null; providerId: string | null; model: string | null };
  tokens: { input: number; output: number; cached: number; total: number } | null;
  costUsd: number | null;
  costState: CostState;
  costNote: string | null;
};
export type AttemptMetricsReport = {
  projectId: string; days: number; since: number;
  summary: {
    attempts: number; measured: number; partial: number; notMeasured: number;
    /** Sum over the measured attempts only; null when none is measured. It is not the cost of the not-measured ones. */
    measuredCostUsd: number | null; measuredTokens: number | null;
    notMeasuredByProvider: Record<string, number>;
    stagesPassed: number; stagesFailed: number;
  };
  attempts: AttemptMetrics[];
};

type AttemptRow = { id: string; run_id: string; task_id: string; attempt_no: number; state: string; thread_id: string | null; created_at: number; updated_at: number };
type StageEventRow = { run_id: string; task_id: string; stage_id: string; state: string; occurred_at: number };
type GateEventRow = { run_id: string; task_id: string; status: string; occurred_at: number };
type CursorRow = { thread_id: string; provider_id: string; last_provider: string; last_model: string; total_json: string };

const TERMINAL = new Set(["passed", "failed", "blocked", "canceled", "skipped"]);
const DAY_MS = 86_400_000;
const proofOf = (stageId: string): string => (STAGE_PROOF as Record<string, { kind: string } | undefined>)[stageId]?.kind ?? "unknown";

/** Stage events of one task, in order, as stage records with the seconds from running to the end. */
function stageRecords(events: readonly StageEventRow[]): AttemptStage[] {
  const running = new Map<string, number>();
  const out: AttemptStage[] = [];
  for (const event of events) {
    if (event.state === "running") { running.set(event.stage_id, event.occurred_at); continue; }
    if (!TERMINAL.has(event.state)) continue;
    const from = running.get(event.stage_id);
    running.delete(event.stage_id);
    out.push({ stageId: event.stage_id, state: event.state, seconds: from === undefined ? null : Math.max(0, Math.round((event.occurred_at - from) / 1000)), proof: proofOf(event.stage_id) });
  }
  return out;
}

/** `taskId` narrows the report to one task (the acceptance card); the window and the numbers are the same as for the project. */
export function attemptMetrics(db: Database.Database, input: { projectId: string; days: number; now?: number; taskId?: string }): AttemptMetricsReport {
  const now = input.now ?? Date.now();
  const since = now - input.days * DAY_MS;
  const attempts = db.prepare(`SELECT a.id, a.run_id, a.task_id, a.attempt_no, a.state, a.thread_id, a.created_at, a.updated_at
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id = a.run_id
    WHERE r.project_id = ? AND a.created_at >= ? ${input.taskId ? "AND a.task_id = ?" : ""} ORDER BY a.run_id, a.task_id, a.created_at, a.attempt_no`).all(input.projectId, since, ...(input.taskId ? [input.taskId] : [])) as AttemptRow[];
  // Helper stages run before the first attempt of a task exists: read events from a day earlier.
  const stageEvents = db.prepare(`SELECT run_id, task_id, stage_id, state, occurred_at FROM lane_pilot_stage_event
    WHERE project_id = ? AND occurred_at >= ? ${input.taskId ? "AND task_id = ?" : ""} ORDER BY id`).all(input.projectId, since - DAY_MS, ...(input.taskId ? [input.taskId] : [])) as StageEventRow[];
  const gateEvents = db.prepare(`SELECT run_id, task_id, status, occurred_at FROM lane_pilot_gate_event
    WHERE project_id = ? AND occurred_at >= ? ${input.taskId ? "AND task_id = ?" : ""} ORDER BY id`).all(input.projectId, since - DAY_MS, ...(input.taskId ? [input.taskId] : [])) as GateEventRow[];
  const threadIds = [...new Set(attempts.flatMap((row) => row.thread_id ? [row.thread_id] : []))];
  const cursors = new Map<string, CursorRow>();
  const cursorQuery = db.prepare("SELECT thread_id, provider_id, last_provider, last_model, total_json FROM lane_pilot_token_cursor WHERE thread_id = ?");
  for (const id of threadIds) {
    const row = cursorQuery.get(id) as CursorRow | undefined;
    if (row) cursors.set(id, row);
  }
  const writerReceipt = db.prepare("SELECT provider_id, model FROM lane_pilot_stage_receipt WHERE run_id = ? AND task_id = ? AND stage_id = 'writer-agent'");

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
        seconds: TERMINAL_ATTEMPT.has(attempt.state) ? Math.max(0, Math.round((attempt.updated_at - attempt.created_at) / 1000)) : null,
        stages, stagesPassed: stages.filter((row) => row.state === "passed").length,
        stagesFailed: stages.filter((row) => row.state === "failed" || row.state === "blocked").length,
        gates: { passed: gates.filter((row) => row.status === "passed").length, rejected: gates.filter((row) => row.status === "rejected" || row.status === "failed").length },
        writer: { threadId: attempt.thread_id, providerId, model },
        tokens, costUsd: cost, costState, costNote,
      });
    });
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  const measured = rows.filter((row) => row.costState === "measured");
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
    },
    attempts: rows,
  };
}

const TERMINAL_ATTEMPT = new Set(["accepted", "blocked", "canceled", "validation_failed", "empty_output", "provider_error", "spawn_rejected"]);

/** The report as the lines `bb lane-pilot metrics` prints: a measured share first, then each attempt, «not measured» spelled out. */
export function renderAttemptMetrics(report: AttemptMetricsReport): string {
  const s = report.summary;
  const usd = (value: number | null) => value === null ? "not measured" : `$${value.toFixed(value < 1 ? 3 : 2)}`;
  const lines = [
    `Lane Pilot attempt metrics for ${report.projectId}, last ${report.days} days: ${s.attempts} attempts; cost measured ${s.measured}, partial ${s.partial}, not measured ${s.notMeasured}.`,
    `Measured cost (list price, measured attempts only): ${usd(s.measuredCostUsd)}${s.measuredTokens === null ? "" : `, ${s.measuredTokens} tokens`}.`,
    ...(Object.keys(s.notMeasuredByProvider).length ? [`Not measured by provider: ${Object.entries(s.notMeasuredByProvider).map(([key, n]) => `${key} ${n}`).join(", ")} (these report no token usage; their cost is unknown, not zero).`] : []),
    `Stages: ${s.stagesPassed} passed, ${s.stagesFailed} failed or blocked.`,
    "",
  ];
  for (const row of report.attempts) {
    const stages = row.stages.map((stage) => `${stage.stageId}:${stage.state}${stage.seconds === null ? "" : `/${stage.seconds}s`}`).join(" ") || "no stage events";
    lines.push(`${new Date(row.createdAt).toISOString().slice(0, 16)}Z ${row.taskId} #${row.attemptNo} ${row.state} ${row.seconds === null ? "" : `${row.seconds}s `}| ${row.writer.providerId ?? "-"}/${row.writer.model ?? "-"} | tokens ${row.tokens ? row.tokens.total : "not measured"} | cost ${usd(row.costUsd)} [${row.costState}] | ${stages}${row.costNote ? ` | ${row.costNote}` : ""}`);
  }
  return lines.join("\n");
}

