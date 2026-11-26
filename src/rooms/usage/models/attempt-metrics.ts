import { modelTier, WRITER_PROFILES } from "@lane-pilot/models";
import type { ModelTier } from "@lane-pilot/models";
import { STAGE_PROOF } from "@lane-pilot/contracts";
import type { CostState } from "@lane-pilot/contracts";
import { isOpenAttemptState } from "../../contracts";

export type { CostState };

export type AttemptStage = { stageId: string; state: string; seconds: number | null; proof: string };
export type AttemptMetrics = {
  taskId: string; attemptId: string; attemptNo: number; state: string; createdAt: number;
  seconds: number | null;
  /** W31 rank 11: how long the attempt sat in `queued` (summed over re-queues); null while it is still queued. */
  queueWaitMs?: number | null;
  stages: AttemptStage[]; stagesPassed: number; stagesFailed: number;
  gates: { passed: number; rejected: number };
  writer: { threadId: string | null; providerId: string | null; model: string | null; tier: ModelTier | null };
  tokens: { input: number; output: number; cached: number; total: number } | null;
  /** Turns the writer thread made (distinct turn ids the sync counted); 0 while nothing landed. */
  turns?: number;
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
    /** Queue-wait percentiles over the attempts whose queue time is settled. */
    queueWait: { samples: number; p50Ms: number | null; p99Ms: number | null };
    /** First attempts (attempt_no = 1) grouped by writer tier: how many ran and how many were accepted. */
    firstByTier: Record<ModelTier | "unknown", { first: number; accepted: number }>;
    /** Attempts of the window per task accepted in the window (H2: the cost the research measures). */
    attemptsPerAcceptedTask: number | null;
    /** Share of the window's attempts that ever sat parked `waiting_writer:` (a provider hold, journaled queued→queued). */
    heldShare: number | null;
  };
  attempts: AttemptMetrics[];
};

export type AttemptRow = { id: string; run_id: string; task_id: string; attempt_no: number; state: string; thread_id: string | null; created_at: number; updated_at: number };
export type StageEventRow = { run_id: string; task_id: string; stage_id: string; state: string; occurred_at: number };
export type TransitionRow = { attempt_id: string; from_state: string; to_state: string; at: number; reason?: string | null };
export type AttemptCursorRow = { thread_id: string; provider_id: string; last_provider: string; last_model: string; total_json: string };

const TERMINAL = new Set(["passed", "failed", "blocked", "canceled", "skipped"]);
const proofOf = (stageId: string): string => (STAGE_PROOF as Record<string, { kind: string } | undefined>)[stageId]?.kind ?? "unknown";

/** Stage events of one task, in order, as stage records with the seconds from running to the end. */
export function stageRecords(events: readonly StageEventRow[]): AttemptStage[] {
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

/** Total ms an attempt waited in `queued`: the closed segments of its transition journal, from `created_at` to leaving the
 * queue (a re-queue starts a new segment). -1 while the attempt is still queued — the wait is not settled. */
export function queueWaitMs(transitions: readonly TransitionRow[], attempt: { id: string; state: string; created_at: number }): number {
  if (attempt.state === "queued") return -1;
  let enter: number | null = attempt.created_at, wait = 0;
  for (const row of transitions) {
    if (row.to_state === "queued") { enter = row.at; continue; }
    if (row.from_state === "queued" && enter !== null) { wait += Math.max(0, row.at - enter); enter = null; }
  }
  return wait;
}

const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]! : null;

export const queueWaitPercentiles = (waits: readonly number[]): { samples: number; p50Ms: number | null; p99Ms: number | null } =>
  ({ samples: waits.length, p50Ms: percentile(waits, 0.5), p99Ms: percentile(waits, 0.99) });

/**
 * The median of `totals`, or null under `minSamples` samples: an estimate needs enough of its own lane's history to be one.
 * Exported for the money book's silent-spend estimate.
 */
export function medianTokens(totals: readonly number[], minSamples = 5): number | null {
  if (totals.length < minSamples) return null;
  const sorted = [...totals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Tier from the writer profile that picked this provider+model; a model outside the catalog falls back to name matching. */
export function writerTier(providerId: string | null, model: string | null): ModelTier | null {
  const profile = WRITER_PROFILES.find((row) => row.providerId === providerId && row.model === model);
  return profile ? profile.tier : model ? modelTier(model) : null;
}

export function firstByTier(rows: AttemptMetrics[]): AttemptMetricsReport["summary"]["firstByTier"] {
  const out = {} as Record<ModelTier | "unknown", { first: number; accepted: number }>;
  for (const row of rows) if (row.attemptNo === 1) {
    const key = row.writer.tier ?? "unknown";
    const bucket = (out[key] ??= { first: 0, accepted: 0 });
    bucket.first += 1;
    if (row.state === "accepted") bucket.accepted += 1;
  }
  return out;
}

export const attemptEnded = (state: string) => !isOpenAttemptState(state);

/** The report as the lines `bb lane-pilot metrics` prints: a measured share first, then each attempt, «not measured» spelled out. */
export function renderAttemptMetrics(report: AttemptMetricsReport): string {
  const s = report.summary;
  const usd = (value: number | null) => value === null ? "not measured" : `$${value.toFixed(value < 1 ? 3 : 2)}`;
  const lines = [
    `Lane Pilot attempt metrics for ${report.projectId}, last ${report.days} days: ${s.attempts} attempts; cost measured ${s.measured}, partial ${s.partial}, not measured ${s.notMeasured}.`,
    `Measured cost (list price, measured attempts only): ${usd(s.measuredCostUsd)}${s.measuredTokens === null ? "" : `, ${s.measuredTokens} tokens`}.`,
    ...(Object.keys(s.notMeasuredByProvider).length ? [`Not measured by provider: ${Object.entries(s.notMeasuredByProvider).map(([key, n]) => `${key} ${n}`).join(", ")} (these report no token usage; their cost is unknown, not zero).`] : []),
    `Stages: ${s.stagesPassed} passed, ${s.stagesFailed} failed or blocked.`,
    `First attempts by tier: ${Object.entries(s.firstByTier).map(([tier, n]) => `${tier} ${n.accepted}/${n.first} accepted`).join(", ") || "none"}.`,
    `Attempts per accepted task: ${s.attemptsPerAcceptedTask ?? "none accepted"}. Held (waiting_writer) share: ${s.heldShare === null ? "no attempts" : `${Math.round(s.heldShare * 100)}%`} — attempts parked while every writer provider was held.`,
    "",
  ];
  for (const row of report.attempts) {
    const stages = row.stages.map((stage) => `${stage.stageId}:${stage.state}${stage.seconds === null ? "" : `/${stage.seconds}s`}`).join(" ") || "no stage events";
    lines.push(`${new Date(row.createdAt).toISOString().slice(0, 16)}Z ${row.taskId} #${row.attemptNo} ${row.state} ${row.seconds === null ? "" : `${row.seconds}s `}| ${row.writer.providerId ?? "-"}/${row.writer.model ?? "-"} [${row.writer.tier ?? "?"}] | tokens ${row.tokens ? row.tokens.total : "not measured"} | cost ${usd(row.costUsd)} [${row.costState}] | ${stages}${row.costNote ? ` | ${row.costNote}` : ""}`);
  }
  return lines.join("\n");
}
