import { listCheckDurations, type LanePilotDatabase } from "../storage";
import { CHECK_HISTORY_MIN_RUNS, p95 } from "../tasks";

export { CHECK_HISTORY_MIN_RUNS, p95 };

/** The ceiling of a timeout that history alone raises; a configured timeout above it is kept as it is. */
export const CHECK_TIMEOUT_CAP_SEC = 1800;
export const CHECK_HISTORY_RUNS = 20;

/** max(configured, p95 of the last runs x 2), the history part capped. Fewer than CHECK_HISTORY_MIN_RUNS runs: the configured value. */
export function historyTimeoutSec(configuredSec: number, durationsMs: readonly number[], capSec = CHECK_TIMEOUT_CAP_SEC): number {
  if (durationsMs.length < CHECK_HISTORY_MIN_RUNS) return configuredSec;
  return Math.max(configuredSec, Math.min(capSec, Math.ceil((p95(durationsMs) * 2) / 1000)));
}

export function checkTimeoutSec(db: LanePilotDatabase, projectId: string, command: string, configuredSec: number): number {
  return historyTimeoutSec(configuredSec, listCheckDurations(db, projectId, command, CHECK_HISTORY_RUNS));
}
