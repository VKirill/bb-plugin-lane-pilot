/**
 * The plugin log as a source of the journal. The watcher's own log filter (self-repair's `logIncidents`) keeps lines that say «failed» and
 * would not have caught the relay 409 storm of 2026-10-19 («could not tell thr_… its task results: HTTP 409: Thread is archived», 10 925 warnings
 * in one night): the manual audit found it by grouping the log's warnings by message shape. The journal does the same: every warn or error
 * line is a line of the log, grouped later by its signature (ids, numbers and paths blanked).
 */
export type LogLine = { message: string; at: number; projectId: string; level: string };

/** Lines the plugin writes about things that are not its fault: the self-repair watcher's own lines, a writer's or a spawn's ordinary failure, traces. */
const NOT_OURS = /^self-repair|^wall|writer attempt \S+ failed|writer spawn for \S+ failed|native-trace|reasoning trace|waits for|ended early, starting one more session|browser check \S+ adopted after a reload/i;

/**
 * A warning counts as a failure line when it says so. The plugin logs ordinary status at warn level too («relay: fired 1, settled 0», «told thr_… 2
 * task result(s)», «integration-gate: running …», «writer … continues in thread …»); those are not walls. An error-level line always counts.
 */
const FAILURE_WORDS = /fail|error|could not|cannot|can't|unable|refus|reject|time[d ]?out|HTTP [45]\d\d|not connected|offline|exhaust|unavailable|invalid|stale|ENOSPC|no space|gb free|crash|abort|unhandled|uncaught|lost\b|archived/i;

export function wallLogLines(text: string, since: number, until: number): LogLine[] {
  const out: LogLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let row: { ts?: unknown; level?: unknown; message?: unknown };
    try { row = JSON.parse(line) as typeof row; } catch { continue; }
    if (typeof row.ts !== "number" || row.ts < since || row.ts >= until || typeof row.message !== "string") continue;
    const level = typeof row.level === "string" ? row.level : "";
    if (level !== "warn" && level !== "error") continue;
    if (NOT_OURS.test(row.message) || (level === "warn" && !FAILURE_WORDS.test(row.message))) continue;
    out.push({ message: row.message, at: row.ts, projectId: /\bproj_[a-z0-9]+/i.exec(row.message)?.[0] ?? "-", level });
  }
  return out;
}
