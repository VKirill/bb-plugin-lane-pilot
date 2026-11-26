import { getAttemptChange } from "../../../rollback/server";
import { listAcceptedAttemptsSince } from "../../../storage";
import { attemptMetrics } from "../../../usage/server";
import type Database from "better-sqlite3";

/**
 * /sma-stats (SMA k_c_stats): one report for the project — git metrics, a timeline and the attempt metrics.
 */
export function projectStats(db: Database.Database, projectId: string, days = 30, now = Date.now()) {
  const since = now - days * 86_400_000;
  const timeline: Array<{ at: number; what: string }> = [];
  // Git metrics come from the change ledger of each accepted attempt (what its merge changed); a task with no merge on record counts nothing.
  let commits = 0, files = 0;
  for (const accepted of listAcceptedAttemptsSince(db as never, projectId, since)) {
    const change = getAttemptChange(db as never, accepted.attemptId);
    if (!change?.mergeCommit) continue;
    commits += 1;
    files += change.changed.length;
    timeline.push({ at: accepted.createdAt, what: `accepted: ${accepted.taskId}` });
  }
  timeline.sort((a, b) => a.at - b.at);
  return {
    projectId, days,
    phases: [] as Array<{ id: string; title: string; stage: string; state: string; runId: string | null }>,
    plans: { pieces: 0, accepted: 0, withdrawn: 0 },
    requirements: { covered: 0, total: 0 },
    git: { commits, files },
    timeline,
    attempts: attemptMetrics(db, { projectId, days, now }),
  };
}
