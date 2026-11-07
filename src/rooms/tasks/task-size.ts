/**
 * Task-size metric (#29 check): what an accepted task of this project actually costs — files changed, diff lines,
 * wall minutes, attempts. Kept on the acceptance receipt (finish.ts stores it in the gate evaluation) and read here
 * for the median the plan warnings compare new work against: a plan that slices work far below the project's median
 * accepted task is the over-decomposition the owner calls a defect.
 */

export type TaskSize = { files: number; lines: number; minutes: number; attempts: number };
export type TaskSizeMedian = TaskSize & { n: number };

export const TASK_SIZE_MIN_SAMPLE = 5;


/** The receipt line of one accepted task. Diff lines come from the caller's `git diff --shortstat` (best effort: 0). */
export function taskSizeOf(input: { files: number; lines?: number | null; createdAt?: number | null; finishedAt: number; attempts: number }): TaskSize {
  return {
    files: input.files,
    lines: Math.max(0, Math.round(input.lines ?? 0)),
    minutes: input.createdAt != null ? Math.max(0, Math.round((input.finishedAt - input.createdAt) / 60_000)) : 0,
    attempts: Math.max(1, input.attempts),
  };
}

/** One short phrase for warnings: "~8 files, ~90 min, ~2 attempts over N accepted tasks". */
export function taskSizeText(size: TaskSizeMedian): string {
  return `~${size.files} files, ~${size.minutes} min, ~${size.attempts} attempt${size.attempts === 1 ? "" : "s"} (median of ${size.n} accepted)`;
}
