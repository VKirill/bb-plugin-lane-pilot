/**
 * Task-size metric (#29 check): what an accepted task of this project actually costs — files changed, diff lines,
 * wall minutes, attempts. Kept on the acceptance receipt (finish.ts stores it in the gate evaluation) and read here
 * for the median the plan warnings compare new work against: a plan that slices work far below the project's median
 * accepted task is the over-decomposition the owner calls a defect.
 */
export type TaskSize = { files: number; lines: number; minutes: number; attempts: number };
export type TaskSizeMedian = TaskSize & { n: number };

export const TASK_SIZE_MIN_SAMPLE = 5;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
};

type SizeDb = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };

/**
 * The median accepted-task size of the project, from `lane_pilot_attempt` joins `lane_pilot_attempt_change`
 * (accepted attempts only, finished last). Null under TASK_SIZE_MIN_SAMPLE: too few accepted tasks to judge a grain.
 */
export function medianTaskSize(db: SizeDb, projectId: string): TaskSizeMedian | null {
  const rows = db.prepare(
    `SELECT a.created_at AS created, a.updated_at AS finished, c.changed_json AS changed,
       (SELECT count(*) FROM lane_pilot_attempt x WHERE x.task_id=a.task_id) AS attempts
     FROM lane_pilot_attempt a JOIN lane_pilot_attempt_change c ON c.attempt_id=a.id
     JOIN lane_pilot_run r ON r.id=a.run_id
     WHERE a.state='accepted' AND r.project_id=? ORDER BY a.updated_at DESC LIMIT 200`,
  ).all(projectId) as Array<{ created: number | null; finished: number; changed: string; attempts: number }>;
  if (rows.length < TASK_SIZE_MIN_SAMPLE) return null;
  const files: number[] = [], minutes: number[] = [], attempts: number[] = [];
  for (const row of rows) {
    let changed: Array<{ path: string }> = [];
    try { changed = JSON.parse(row.changed) as Array<{ path: string }>; } catch { /* counted as zero */ }
    files.push(changed.length);
    attempts.push(Math.max(1, row.attempts));
    if (row.created != null) minutes.push(Math.max(0, Math.round((row.finished - row.created) / 60_000)));
  }
  return { files: median(files), lines: 0, minutes: minutes.length ? median(minutes) : 0, attempts: median(attempts), n: rows.length };
}

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
