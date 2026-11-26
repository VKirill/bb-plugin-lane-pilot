import {
  attemptTimelineRows,
  attemptTransitionsForTask,
  contractEditions,
  gateEventsForTask,
  stageEventsForTimeline,
  stageReceiptsForTimeline,
  taskTimelineRow,
  type LanePilotDatabase,
} from "../../../storage";
import { renderTimeline, type TaskTimeline, type TimelineEntry } from "../../models/timeline";

export { renderTimeline };
export type { TaskTimeline, TimelineEntry };

const KIND_ORDER: Record<TimelineEntry["kind"], number> = { task: 0, baseline: 1, attempt: 2, move: 3, stage: 4, gate: 5, edition: 6 };

export function taskTimeline(
  db: LanePilotDatabase,
  taskId: string,
  runId?: string,
  readBaselines: (db: LanePilotDatabase, runId: string, taskId: string) => Array<{ at: number; attempt_id: string | null; verdict: string; action: string; summary: string }> = () => [],
): TaskTimeline {
  const task = (runId
    ? taskTimelineRow(db, taskId, runId)
    : taskTimelineRow(db, taskId)
  ) as { run_id: string; birth: string | null; created_at: number; closed_words: string | null } | undefined;
  if (!task) return { taskId, runId: null, birth: null, closedWords: null, entries: [], receipts: [] };
  const run = task.run_id;
  const entries: TimelineEntry[] = [{ at: task.created_at, kind: "task", attemptId: null, text: `task arrived (${task.birth ?? "pm"})` }];
  const attempts = attemptTimelineRows(db, run, taskId) as
    Array<{ id: string; attempt_no: number; created_at: number }>;
  const numberOf = new Map(attempts.map((row) => [row.id, row.attempt_no]));
  for (const row of attempts) entries.push({ at: row.created_at, kind: "attempt", attemptId: row.id, text: `attempt ${row.attempt_no} created` });
  const moves = attemptTransitionsForTask(db, run, taskId) as
    Array<{ attempt_id: string; from_state: string; to_state: string; reason: string | null; refused: number; at: number }>;
  for (const row of moves) {
    entries.push({ at: row.at, kind: "move", attemptId: row.attempt_id,
      text: `attempt ${numberOf.get(row.attempt_id) ?? "?"}: ${row.from_state} → ${row.to_state}${row.refused ? " (refused)" : ""}${row.reason ? `: ${row.reason}` : ""}` });
  }
  const stages = stageEventsForTimeline(db, run, taskId) as
    Array<{ stage_id: string; state: string; attempt: number; occurred_at: number }>;
  for (const row of stages) entries.push({ at: row.occurred_at, kind: "stage", attemptId: null, text: `stage ${row.stage_id} ${row.state}${row.attempt ? ` (attempt ${row.attempt})` : ""}` });
  const gates = gateEventsForTask(db, run, taskId) as
    Array<{ gate: string; status: string; attempt: number; occurred_at: number }>;
  for (const row of gates) entries.push({ at: row.occurred_at, kind: "gate", attemptId: null, text: `gate ${row.gate} ${row.status}${row.attempt ? ` (attempt ${row.attempt})` : ""}` });
  const baselines = readBaselines(db, run, taskId);
  for (const row of baselines) entries.push({ at: row.at, kind: "baseline", attemptId: row.attempt_id, text: `baseline ${row.verdict} → ${row.action}: ${row.summary}` });
  for (const row of contractEditions(db, taskId)) entries.push({ at: row.at, kind: "edition", attemptId: null, text: `contract edition ${row.edition}${row.reason ? ` (${row.reason})` : ""} · sha ${row.sha256.slice(0, 12)}` });
  entries.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const receipts = (stageReceiptsForTimeline(db, run, taskId) as
    Array<{ stage_id: string; state: string; attempt: number; reason: string | null; updated_at: number }>)
    .map((row) => ({ stageId: row.stage_id, state: row.state, attempt: row.attempt, reason: row.reason, updatedAt: row.updated_at }));
  return { taskId, runId: run, birth: task.birth, closedWords: task.closed_words, entries, receipts };
}
