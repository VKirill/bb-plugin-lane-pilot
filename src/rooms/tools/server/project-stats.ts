import { coverageGaps, listPhases, listParts } from "../../phase";
import { getAttemptChange } from "../../rollback";
import { listAcceptedAttemptsSince } from "../../storage";
import { attemptMetrics } from "../../usage/server";
import type Database from "better-sqlite3";

/**
 * /sma-stats (SMA k_c_stats): one report for the project — phases, plans, requirements, git metrics and a
 * timeline — on top of the attempt-metrics summary. Every part reads the hub's own tables, nothing new.
 */
export function projectStats(db: Database.Database, projectId: string, days = 30, now = Date.now()) {
  const since = now - days * 86_400_000;
  const phases = listPhases(db as never, { projectId, limit: 100 }).map((phase) => ({
    id: phase.id, title: phase.title, stage: phase.stage, state: phase.state, runId: phase.runId ?? null,
  }));
  const phaseRecords = listPhases(db as never, { projectId, limit: 100 });
  let pieces = 0, accepted = 0, withdrawn = 0;
  let covered = 0, total = 0;
  for (const phase of phaseRecords) {
    const items = (phase.record as { plan?: { items?: Array<{ state?: string }> } }).plan?.items ?? [];
    pieces += items.length;
    accepted += items.filter((item) => item.state === "accepted" || item.state === "done").length;
    withdrawn += items.filter((item) => item.state === "withdrawn" || item.state === "dropped").length;
    const requirements = ((phase.record as { context?: { requirements?: string[] } }).context?.requirements) ?? [];
    const gaps = coverageGaps(phase.record as never).length;
    total += requirements.length;
    covered += Math.max(0, requirements.length - gaps);
  }
  const timeline: Array<{ at: number; what: string }> = [];
  for (const phase of phaseRecords) for (const part of listParts(db as never, phase.id)) timeline.push({ at: part.at, what: `book part: ${part.text.slice(0, 60)}` });
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
    phases,
    plans: { pieces, accepted, withdrawn },
    requirements: { covered, total },
    git: { commits, files },
    timeline,
    attempts: attemptMetrics(db, { projectId, days, now }),
  };
}
