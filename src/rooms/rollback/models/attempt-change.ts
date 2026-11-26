import { TASK_SIZE_MIN_SAMPLE, type TaskSizeMedian } from "../../tasks";

/** One file an attempt changed: A added, M modified, D deleted, T type changed. */
export type ChangedFile = { path: string; status: string };

/** What an attempt's worktree held when a stop was confirmed or the worktree was returned. `read:"failed"` marks a read that could not happen: the effect is uncertain, not empty. */
export type WorktreeRecord = { head: string | null; dirty: number; ahead: number; savedAs: string | null; at: number; read?: "failed"; readError?: string };

/** The landing suite result stored on the change row (SMA k_lib_landing): green/red of the checks on the merged head, or why none ran. */
export type LandingSuite = {
  /** `running` is a claim: one pass has taken the row and is running the checks; a second pass skips it until the claim is older than LANDING_CLAIM_STALE_MS. */
  suite: "green" | "red" | "none" | "error" | "running";
  head: string | null;
  at: number;
  red?: string[];
  reason?: string;
  /** How many times the run was lost to the machine (host error, offline host, failed worktree, a stale claim); the third `error` is final. */
  tries?: number;
  /** The project's own suite (verification.project_suite, a command), run in the same throwaway worktree after the task's checks. `not named`: the project has none, none is guessed; `error`: the machine could not run it, not a red. */
  projectSuite?: { command: string | null; state: "green" | "red" | "not named" | "error"; exitCode?: number };
};

/** The most runs a landing gets when the machine, not the code, fails them; after that the verdict stays `error`. */
export const LANDING_SUITE_TRIES = 3;
/** A `running` claim older than this was left by a pass that died; the row is free again. */
export const LANDING_CLAIM_STALE_MS = 45 * 60_000;

export type AttemptChange = {
  attemptId: string;
  runId: string;
  taskId: string;
  baseSha: string | null;
  mergeParent: string | null;
  mergeCommit: string | null;
  outcome: string | null;
  changed: ChangedFile[];
  worktree: WorktreeRecord | null;
  recordedAt: number;
  updatedAt: number;
  checksGreen: number | null;
  /** The post-merge suite verdict (SMA k_lib_landing): the task's own checks run on the merged head by the background sweep. */
  suite: LandingSuite | null;
};

export type AttemptChangePatch = {
  baseSha?: string | null | undefined;
  mergeParent?: string | null | undefined;
  mergeCommit?: string | null | undefined;
  outcome?: string | undefined;
  changed?: ChangedFile[] | undefined;
  worktree?: WorktreeRecord | undefined;
  checksGreen?: number | undefined;
};

export type LandingPending = {
  attemptId: string;
  runId: string;
  taskId: string;
  mergeCommit: string | null;
  tries: number;
  /** The suite_json as read (null: never claimed): the claim compares against it, so only one pass wins a row. */
  raw: string | null;
};

/**
 * The landing record (SMA k_lib_landing) of an attempt whose merge landed green: the commit, the count of green checks and
 * the files it carried, read from the attempt's change row — no receipt, so the task's receipts stay as they were.
 */
export function landingOf(change: AttemptChange | null | undefined): { commit: string; checksGreen: number | null; files: number; line: string } | null {
  if (!change || change.outcome !== "merged" || !change.mergeCommit) return null;
  const files = change.changed.length;
  return {
    commit: change.mergeCommit,
    checksGreen: change.checksGreen,
    files,
    line: `landed ${change.mergeCommit.slice(0, 12)} · ${change.checksGreen ?? "?"} checks green · ${files} files`,
  };
}

/**
 * The effect state of an attempt's change (SMA ac_effects): intended while only the base is on record, observed once git
 * was read (a merge or the worktree state), uncertain when the read failed (the reason kept, `changed` unknown — never
 * read as «no effect»), compensated when the work was reverted.
 */
export type EffectState = "intended" | "observed" | "uncertain" | "compensated";

export function effectState(change: Pick<AttemptChange, "baseSha" | "mergeCommit" | "outcome" | "changed" | "worktree"> | null | undefined): EffectState {
  if (!change) return "intended";
  if (change.outcome === "reverted") return "compensated";
  if (change.worktree?.read === "failed") return "uncertain";
  if (change.mergeCommit || change.worktree || change.outcome === "merged") return "observed";
  return "intended";
}

export type RecoveryState = "clear" | "reconciling" | "rollback_failed" | "needs_decision";

const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

/** Computes median accepted-task size from accepted attempt-change rows; returns null below TASK_SIZE_MIN_SAMPLE. */
export function computeMedianTaskSize(rows: ReadonlyArray<{ created: number | null; finished: number; changed: string; attempts: number }>): TaskSizeMedian | null {
  if (rows.length < TASK_SIZE_MIN_SAMPLE) return null;
  const files: number[] = [];
  const minutes: number[] = [];
  const attempts: number[] = [];
  for (const row of rows) {
    const changed = parseJson<Array<{ path: string }>>(row.changed, []);
    files.push(changed.length);
    attempts.push(Math.max(1, row.attempts));
    if (row.created != null) minutes.push(Math.max(0, Math.round((row.finished - row.created) / 60_000)));
  }
  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
  };
  return { files: median(files), lines: 0, minutes: minutes.length ? median(minutes) : 0, attempts: median(attempts), n: rows.length };
}
