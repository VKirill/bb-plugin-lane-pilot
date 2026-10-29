import { finishRunRow, listRuns, type BenchDb } from "./store";

/** Why a series must wait: the host is under the free-space floor. The `deferred:` prefix is what the night retries; the rest matches the old stop text. */
export function diskDeferral(freeGb: number | null, minFreeGb: number, hostId: string): string | null {
  if (freeGb === null || freeGb >= minFreeGb) return null;
  return `deferred: host ${hostId} has ${freeGb} GB free, below ${minFreeGb}`;
}

/** A stored stop that is a full disk, including rows written before the `deferred:` prefix. */
export function isDiskDeferral(reason: string | null): boolean {
  return !!reason && (reason.startsWith("deferred:") || /GB free, below/.test(reason));
}

export type ArmRunView = { state: string; stopReason: string | null };

/**
 * What the night may do with one arm. `deferred` and `absent` are tried again. A disk stop is not `done`:
 * three nights stayed unfinished because `stopped_budget` was read as a finished measurement.
 */
export function benchArmStatus(runs: readonly ArmRunView[]): "done" | "running" | "deferred" | "unavailable" | "absent" {
  if (!runs.length) return "absent";
  if (runs.some((row) => row.state === "running")) return "running";
  if (runs.some((row) => isDiskDeferral(row.stopReason))) return "deferred";
  if (runs.every((row) => row.state === "done" || row.state === "stopped_budget")) return "done";
  return "unavailable";
}

/**
 * Closes a series still `running` after its hour cap. The column CHECK has no other word, so the row becomes `failed`
 * with a stuck reason. `exceptArm` is the arm about to start: closing it here would reopen it on resume.
 * ponytail: the default cap is 6 h, the same number as DEFAULT_BUDGET_HOURS; a row's own budgetHours wins. Upgrade: one shared constant if the two ever diverge.
 */
export function sweepStuckRuns(db: BenchDb, now = Date.now(), opts: { defaultHours?: number; exceptArm?: string } = {}): Array<{ id: string; arm: string; stopReason: string }> {
  const hoursDefault = opts.defaultHours ?? 6;
  const closed: Array<{ id: string; arm: string; stopReason: string }> = [];
  for (const run of listRuns(db)) {
    if (run.state !== "running") continue;
    if (opts.exceptArm && run.arm === opts.exceptArm) continue;
    const hours = run.budgetHours ?? hoursDefault;
    if (now - run.startedAt <= hours * 3_600_000) continue;
    const reason = `stuck: running past its ${hours} h cap since ${new Date(run.startedAt).toISOString()}`;
    finishRunRow(db, run.id, "failed", reason, now);
    closed.push({ id: run.id, arm: run.arm, stopReason: reason });
  }
  return closed;
}
