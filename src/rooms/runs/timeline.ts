import type { LanePilotDatabase } from "../storage";
import { contractEditions, taskTimelineRow, attemptTimelineRows, attemptTransitionsForTask, stageEventsForTimeline, gateEventsForTask, stageReceiptsForTimeline } from "../storage";

/**
 * One task's record in time order, from the tables that write it while it runs (the owner's post-mortem of the cab-unslop run,
 * 2026-10-31: «is there a deterministic log of a task, where is it written»). Nothing here is computed after the fact:
 * - lane_pilot_task: the contract's arrival (its birth: pm, workflow, mainfix) and the PM's closing words;
 * - lane_pilot_attempt and lane_pilot_attempt_transition: every attempt and every move of its state with the reason, refused moves too;
 * - lane_pilot_stage_event: every change of a stage (pm-read, plan-critique, writer-agent, verification, code-critique, plan-fact …), append-only;
 * - lane_pilot_gate_event: the gates (owns-paths, verification, validate, accept) and their outcome;
 * - lane_pilot_baseline: the checks run on the untouched base before the writer, the verdict and what followed.
 * The current receipts (lane_pilot_stage_receipt) keep the last reason of each stage; the server log
 * (~/.bb/plugins/lane-pilot/logs/plugin.log) keeps what the server said meanwhile: waits, parks, writer picks.
 */
export type TimelineEntry = { at:number; kind:"task"|"baseline"|"attempt"|"move"|"stage"|"gate"|"edition"; attemptId:string|null; text:string };

export type TaskTimeline = {
  taskId:string; runId:string|null; birth:string|null; closedWords:string|null;
  entries:TimelineEntry[];
  receipts:Array<{ stageId:string; state:string; attempt:number; reason:string|null; updatedAt:number }>;
};

const KIND_ORDER:Record<TimelineEntry["kind"], number> = { task:0, baseline:1, attempt:2, move:3, stage:4, gate:5, edition:6 };

export function taskTimeline(db:LanePilotDatabase, taskId:string, runId?:string,
  readBaselines:(db:LanePilotDatabase, runId:string, taskId:string)=>Array<{ at:number; attempt_id:string|null; verdict:string; action:string; summary:string }> = () => []):TaskTimeline {
  const task = (runId
    ? taskTimelineRow(db, taskId, runId)
    : taskTimelineRow(db, taskId)
  ) as { run_id:string; birth:string|null; created_at:number; closed_words:string|null } | undefined;
  if (!task) return { taskId, runId:null, birth:null, closedWords:null, entries:[], receipts:[] };
  const run = task.run_id;
  const entries:TimelineEntry[] = [{ at:task.created_at, kind:"task", attemptId:null, text:`task arrived (${task.birth ?? "pm"})` }];
  const attempts = attemptTimelineRows(db, run, taskId) as
    Array<{ id:string; attempt_no:number; created_at:number }>;
  const numberOf = new Map(attempts.map((row) => [row.id, row.attempt_no]));
  for (const row of attempts) entries.push({ at:row.created_at, kind:"attempt", attemptId:row.id, text:`attempt ${row.attempt_no} created` });
  const moves = attemptTransitionsForTask(db, run, taskId) as
    Array<{ attempt_id:string; from_state:string; to_state:string; reason:string|null; refused:number; at:number }>;
  for (const row of moves) {
    entries.push({ at:row.at, kind:"move", attemptId:row.attempt_id,
      text:`attempt ${numberOf.get(row.attempt_id) ?? "?"}: ${row.from_state} → ${row.to_state}${row.refused ? " (refused)" : ""}${row.reason ? `: ${row.reason}` : ""}` });
  }
  const stages = stageEventsForTimeline(db, run, taskId) as
    Array<{ stage_id:string; state:string; attempt:number; occurred_at:number }>;
  for (const row of stages) entries.push({ at:row.occurred_at, kind:"stage", attemptId:null, text:`stage ${row.stage_id} ${row.state}${row.attempt ? ` (attempt ${row.attempt})` : ""}` });
  const gates = gateEventsForTask(db, run, taskId) as
    Array<{ gate:string; status:string; attempt:number; occurred_at:number }>;
  for (const row of gates) entries.push({ at:row.occurred_at, kind:"gate", attemptId:null, text:`gate ${row.gate} ${row.status}${row.attempt ? ` (attempt ${row.attempt})` : ""}` });
  const baselines = readBaselines(db, run, taskId);
  for (const row of baselines) entries.push({ at:row.at, kind:"baseline", attemptId:row.attempt_id, text:`baseline ${row.verdict} → ${row.action}: ${row.summary}` });
  for (const row of contractEditions(db, taskId)) entries.push({ at:row.at, kind:"edition", attemptId:null, text:`contract edition ${row.edition}${row.reason ? ` (${row.reason})` : ""} · sha ${row.sha256.slice(0, 12)}` });
  entries.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const receipts = (stageReceiptsForTimeline(db, run, taskId) as
    Array<{ stage_id:string; state:string; attempt:number; reason:string|null; updated_at:number }>)
    .map((row) => ({ stageId:row.stage_id, state:row.state, attempt:row.attempt, reason:row.reason, updatedAt:row.updated_at }));
  return { taskId, runId:run, birth:task.birth, closedWords:task.closed_words, entries, receipts };
}

const clock = (at:number) => new Date(at).toISOString().replace("T", " ").slice(0, 19);

/** The timeline as text: one line per entry, UTC, then the stages' current receipts and where the server log is. */
export function renderTimeline(timeline:TaskTimeline):string {
  if (!timeline.runId) return `no task ${timeline.taskId} on record`;
  const lines = [`task ${timeline.taskId} · run ${timeline.runId} · times UTC`];
  for (const entry of timeline.entries) lines.push(`${clock(entry.at)}  ${entry.kind.padEnd(8)} ${entry.text}`);
  if (timeline.closedWords) lines.push(`closing words: ${timeline.closedWords}`);
  if (timeline.receipts.length) {
    lines.push("", "stages now:");
    for (const row of timeline.receipts) lines.push(`  ${row.stageId.padEnd(18)} ${row.state}${row.attempt ? ` (attempt ${row.attempt})` : ""}${row.reason ? `: ${row.reason}` : ""}`);
  }
  lines.push("", `server log: ~/.bb/plugins/lane-pilot/logs/plugin.log (grep ${timeline.taskId}: waits, parks, writer picks)`);
  return lines.join("\n");
}
