import { coverageGaps } from "../../phase/stages";
import { listPhases, listParts } from "../../phase";
import { listRunTaskRows, listStageReceipts } from "../../storage";
import { attemptMetrics } from "./attempt-metrics";
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
  let commits = 0, files = 0, lines = 0;
  const runs = (db.prepare("SELECT id FROM lane_pilot_run WHERE project_id=? AND created_at>=?").all(projectId, since) as Array<{ id: string }>).map((row) => row.id);
  for (const runId of runs) {
    for (const task of listRunTaskRows(db as never, runId)) {
      const attempt = (db.prepare("SELECT id FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND state='accepted' ORDER BY attempt_no DESC LIMIT 1").get(runId, task.id) as { id: string } | undefined);
      if (!attempt) continue;
      const merge = (db.prepare("SELECT detail_json FROM lane_pilot_task_receipt WHERE task_id=? AND kind='merge' ORDER BY id DESC LIMIT 1").get(task.id) as { detail_json: string } | undefined);
      if (!merge) continue;
      commits += 1;
      try {
        const detail = JSON.parse(merge.detail_json) as { changed?: Array<{ path?: string; insertions?: number; deletions?: number }> };
        files += detail.changed?.length ?? 0;
        lines += (detail.changed ?? []).reduce((sum, row) => sum + (row.insertions ?? 0) + (row.deletions ?? 0), 0);
      } catch { /* an unreadable detail loses the counts, not the commit */ }
      const created = (db.prepare("SELECT created_at FROM lane_pilot_attempt WHERE id=?").get(attempt.id) as { created_at: number } | undefined)?.created_at;
      if (created) timeline.push({ at: created, what: `accepted: ${task.id}` });
    }
  }
  timeline.sort((a, b) => a.at - b.at);
  return {
    projectId, days,
    phases,
    plans: { pieces, accepted, withdrawn },
    requirements: { covered, total },
    git: { commits, files, lines },
    timeline,
    attempts: attemptMetrics(db, { projectId, days, now }),
  };
}
