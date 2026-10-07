import { listCheckDurations, type LanePilotDatabase } from "./database";

/** The ceiling of a timeout that history alone raises; a configured timeout above it is kept as it is. */
export const CHECK_TIMEOUT_CAP_SEC = 1800;
/** Runs needed before history says anything: one slow cold run must not set the limit. */
export const CHECK_HISTORY_MIN_RUNS = 3;
export const CHECK_HISTORY_RUNS = 20;

/** Nearest-rank 95th percentile; 0 for no values. */
export function p95(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/** max(configured, p95 of the last runs x 2), the history part capped. Fewer than CHECK_HISTORY_MIN_RUNS runs: the configured value. */
export function historyTimeoutSec(configuredSec: number, durationsMs: readonly number[], capSec = CHECK_TIMEOUT_CAP_SEC): number {
  if (durationsMs.length < CHECK_HISTORY_MIN_RUNS) return configuredSec;
  return Math.max(configuredSec, Math.min(capSec, Math.ceil((p95(durationsMs) * 2) / 1000)));
}

export function checkTimeoutSec(db: LanePilotDatabase, projectId: string, command: string, configuredSec: number): number {
  return historyTimeoutSec(configuredSec, listCheckDurations(db, projectId, command, CHECK_HISTORY_RUNS));
}
