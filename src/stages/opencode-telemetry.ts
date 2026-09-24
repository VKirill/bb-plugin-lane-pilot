import { createHash } from "node:crypto";

export type OpenCodeToolTelemetryEvent = {
  eventId: string;
  timestamp: number | string | null;
  source: string | null;
  tool: string;
  succeeded: boolean;
  chars: number | null;
  duplicate: boolean | null;
  invocation: number | null;
  fingerprint: string | null;
};

export type OpenCodeTelemetryParseResult = {
  logSha256: string;
  lineCount: number;
  malformedLines: number;
  otherEvents: number;
  unmatchedSessions: number;
  unmatchedTasks: number;
  duplicateLines: number;
  events: OpenCodeToolTelemetryEvent[];
};

const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINES = 2048;
const MAX_EVENTS = 512;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** Parse only A's bounded tool.execute.after JSONL shape; never retain args or tool output. */
export function parseOpenCodeToolTelemetry(raw: string, sessionId: string, taskFile: string): OpenCodeTelemetryParseResult {
  if (!sessionId.trim() || sessionId.length > 256) throw new Error("telemetry_session_id_invalid");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(taskFile) || taskFile === "." || taskFile === "..") throw new Error("telemetry_task_file_invalid");
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_LOG_BYTES) throw new Error(`telemetry_log_exceeds_${MAX_LOG_BYTES}_bytes`);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length > MAX_LOG_LINES) throw new Error(`telemetry_log_exceeds_${MAX_LOG_LINES}_lines`);

  const events: OpenCodeToolTelemetryEvent[] = [];
  const eventIds = new Set<string>();
  let malformedLines = 0;
  let otherEvents = 0;
  let unmatchedSessions = 0;
  let unmatchedTasks = 0;
  let duplicateLines = 0;

  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { malformedLines += 1; continue; }
    const item = record(parsed);
    const data = record(item?.data);
    const tool = boundedText(data?.tool, 80);
    if (!item || item.mod !== "budget" || !data || !tool || typeof item.ok !== "boolean") {
      otherEvents += 1;
      continue;
    }
    if (item.session !== sessionId) {
      unmatchedSessions += 1;
      continue;
    }
    if (item.task !== taskFile) {
      unmatchedTasks += 1;
      continue;
    }
    const eventId = hash(line);
    if (eventIds.has(eventId)) { duplicateLines += 1; continue; }
    eventIds.add(eventId);
    if (events.length >= MAX_EVENTS) throw new Error(`telemetry_log_exceeds_${MAX_EVENTS}_matching_events`);
    const timestamp = typeof item.t === "number" && Number.isFinite(item.t) ? item.t
      : typeof item.t === "string" && item.t.length <= 64 ? item.t : null;
    events.push({
      eventId,
      timestamp,
      source: boundedText(item.src, 80),
      tool,
      succeeded: item.ok,
      chars: Number.isInteger(data.chars) && Number(data.chars) >= 0 ? Number(data.chars) : null,
      duplicate: typeof data.dup === "boolean" ? data.dup : null,
      invocation: Number.isInteger(data.n) && Number(data.n) >= 0 ? Number(data.n) : null,
      fingerprint: boundedText(data.fp, 64),
    });
  }

  return { logSha256: hash(raw), lineCount: lines.length, malformedLines, otherEvents,
    unmatchedSessions, unmatchedTasks, duplicateLines, events };
}
