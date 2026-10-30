import { listCheckDurations, listCheckRuns, type CheckRef, type LanePilotDatabase } from "../storage";
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

export function checkTimeoutSec(db: LanePilotDatabase, projectId: string, check: CheckRef, configuredSec: number): number {
  const base = historyTimeoutSec(configuredSec, listCheckDurations(db, projectId, check, CHECK_HISTORY_RUNS));
  // Rank-12 escalation: a check that timed out gets its next run at timeout x1.5 per consecutive 124, capped.
  const streak = consecutiveTimeouts(listCheckRuns(db, projectId, check, 10));
  if (!streak) return base;
  return Math.min(CHECK_TIMEOUT_CAP_SEC, Math.ceil(base * Math.pow(1.5, streak)));
}

/** Fail-first score for checks.fail_fast: (p_fail + eps) / (mean green seconds + delta), descending.
 * A check that has never failed still sorts ahead of a slow one; no history puts it at the median-cost front. */
export function failFastScore(runs: readonly { durationMs: number; exitCode: number }[]): number {
  if (!runs.length) return 0.5;
  const fails = runs.filter((run) => run.exitCode !== 0).length;
  const greens = runs.filter((run) => run.exitCode === 0).map((run) => run.durationMs);
  const meanSec = greens.length ? greens.reduce((a, b) => a + b, 0) / greens.length / 1000 : 60;
  return (fails / runs.length + 0.25) / (meanSec + 1);
}

/** Ordered copy of the check list for checks.fail_fast: highest expected fail-cost first, stable on ties.
 * Entries keep their original index so the caller can put results back into contract order. */
export function orderChecksForFailFast<T extends { command: string; cwd: string }>(db: LanePilotDatabase, projectId: string, checks: readonly T[], root: string): Array<{ check: T; index: number }> {
  return checks
    .map((check, index) => ({ check, index, score: failFastScore(listCheckRuns(db, projectId, { command: check.command, cwd: check.cwd, root })) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/** Consecutive trailing timeouts of this check in one project (newest first): each 124 raises the next run x1.5. */
export function consecutiveTimeouts(runs: readonly { durationMs: number; exitCode: number }[]): number {
  let count = 0;
  for (const run of runs) { if (run.exitCode !== 124) break; count++; }
  return count;
}
