/**
 * Pure value definitions for merge intent delivery records.
 */
export const MERGE_INTENT_PREFIX = "merge-intent:";
export const mergeIntentKey = (attemptId: string) => `${MERGE_INTENT_PREFIX}${attemptId}`;

/** The trailer that names an attempt in the commits it makes: two attempts of one task share a title, so the title proves nothing. */
export const attemptTrailer = (attemptId: string) => `Lane-Pilot-Attempt: ${attemptId}`;

/** The message gitIntegrate commits and merges with (500 characters at most): the task's title line and the attempt's trailer. */
export const attemptMergeMessage = (task: { id: string; title: string }, attemptId: string) =>
  `${`${task.id}: ${task.title}`.replace(/\s+/g, " ").slice(0, 400)}\n\n${attemptTrailer(attemptId)}`;

export type MergeIntent = {
  attemptId: string;
  runId: string;
  taskId: string;
  projectId: string;
  hostId: string;
  /** The run's base checkout (main) and the attempt's own worktree. */
  basePath: string;
  worktreePath: string;
  /** The attempt's branch and HEAD, and main's HEAD, when the intent was written; null when the machine did not answer. */
  branch: string | null;
  sha: string | null;
  baseHead: string | null;
  /** The commit message gitIntegrate merges with (`attemptMergeMessage`): the merge commit carries it, trailer included. */
  message: string;
  at: number;
};

export type RunOnHost = (hostId: string, cwd: string, command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type MergeVerdict = { landed: true; how: string; commit: string | null } | { landed: false } | { unknown: true };
