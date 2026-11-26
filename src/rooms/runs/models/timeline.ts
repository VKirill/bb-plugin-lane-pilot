export type TimelineEntry = { at: number; kind: "task" | "baseline" | "attempt" | "move" | "stage" | "gate" | "edition"; attemptId: string | null; text: string };

export type TaskTimeline = {
  taskId: string; runId: string | null; birth: string | null; closedWords: string | null;
  entries: TimelineEntry[];
  receipts: Array<{ stageId: string; state: string; attempt: number; reason: string | null; updatedAt: number }>;
};

const clock = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 19);

/** The timeline as text: one line per entry, UTC, then the stages' current receipts and where the server log is. */
export function renderTimeline(timeline: TaskTimeline): string {
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
