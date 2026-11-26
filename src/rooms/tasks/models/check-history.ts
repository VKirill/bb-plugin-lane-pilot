// The pure half of a check's timing history: the contract lint (tasks) and the writer's check timeout (writer) read it alike.

/** Runs needed before history says anything: one slow cold run must not set the limit. */
export const CHECK_HISTORY_MIN_RUNS = 3;

/** Nearest-rank 95th percentile; 0 for no values. */
export function p95(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}
