import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The newest bytes of the OpenCode log that are read: a session's errors sit at its end, and the log grows to tens of MB. */
export const OPENCODE_LOG_TAIL_BYTES = 2 * 1024 * 1024;
/** A limit line this long before the writer's last event still counts: the session's first error follows that event at once. */
const SINCE_SLACK_MS = 60_000;
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

/** A provider limit a session's log line names: the model that hit it, and its reset time (epoch ms) when the line gives one. */
export type OpenCodeLimit = { status: "limit"; providerId: string | null; model: string | null; resetAt: number | null; reason: string };
export type OpenCodeLimitResult = OpenCodeLimit | { status: "none"; providerId: null; model: null; resetAt: null; reason: null };

const LIMIT_LINE = /\[429\]|\b429\b|quota|rate[ -]?limit|usage limit|insufficient credits|credit balance|RESOURCE_EXHAUSTED|too many requests|Unavailable \(reset after/i;
const LIMIT_MESSAGE = /\bmessage\\?"\s*:\s*\\?"([^"\\]{1,160})/;
const RESET_STAMP = /quotaResetTimeStamp\\?"\s*:\s*\\?"([^"\\\s]+)/;
const RESET_AFTER = /(?:reset after |[Rr]esets in )((?:\d+(?:\.\d+)?[hms] ?)+)/;
const MODEL_IN_ERROR = /\[([^\]\s]+\/[^\]\s]+)\]/;
const TIMESTAMP = /^timestamp=(\S+)/;

function lineTime(line: string): number | null {
  const stamp = TIMESTAMP.exec(line)?.[1];
  const parsed = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** `2h 40m 47s`, `4h43m12s`, `1m 30s` as milliseconds. */
function durationMs(text: string): number {
  return [...text.matchAll(/(\d+(?:\.\d+)?)([hms])/g)].reduce((total, match) => total + Number(match[1]) * UNIT_MS[match[2]!]!, 0);
}

/** The limit one log line names, or null when it names none. Its model is the one that hit the limit, not the writer's. */
export function limitOfLine(line: string): Omit<OpenCodeLimit, "status"> | null {
  const matched = LIMIT_LINE.exec(line);
  if (!matched) return null;
  const stamp = Date.parse(RESET_STAMP.exec(line)?.[1] ?? "");
  const after = RESET_AFTER.exec(line)?.[1];
  const base = lineTime(line);
  const resetAt = Number.isFinite(stamp) ? stamp : after && base !== null ? base + durationMs(after) : null;
  return {
    providerId: /\bproviderID=(\S+)/.exec(line)?.[1] ?? null,
    model: MODEL_IN_ERROR.exec(line)?.[1] ?? /\bmodelID=(\S+)/.exec(line)?.[1] ?? null,
    resetAt,
    reason: LIMIT_MESSAGE.exec(line)?.[1] ?? matched[0],
  };
}

/** A log line of this session: OpenCode writes `session.id=` on its stream errors and `session=` on its telemetry. */
const ownsSession = (line: string, sessionId: string): boolean =>
  line.split(" ").some((token) => token === `session.id=${sessionId}` || token === `session=${sessionId}`);

/**
 * The provider limit a session's ERROR lines name since `sinceMs`, newest first. Another session's lines, and errors that
 * name no limit, classify as none: a silent writer whose provider is fine is nudged as before.
 */
export function classifyOpenCodeLimit(log: string, sessionId: string, sinceMs: number): OpenCodeLimitResult {
  const lines = log.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!/\blevel=ERROR\b/.test(line) || !ownsSession(line, sessionId)) continue;
    const time = lineTime(line);
    if (time !== null && time < sinceMs - SINCE_SLACK_MS) continue;
    const limit = limitOfLine(line);
    if (limit) return { status: "limit", ...limit };
  }
  return { status: "none", providerId: null, model: null, resetAt: null, reason: null };
}

/** OpenCode's log file: under `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. */
export function openCodeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "opencode") : join(homedir(), ".local", "share", "opencode");
  return join(base, "log", "opencode.log");
}

/** The newest bytes of the log, read asynchronously; a cut first line is dropped, only whole lines are classified. */
async function readLogTail(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, OPENCODE_LOG_TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, size - length);
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

/** The host's answer for one writer session: a provider limit, or none. A missing or unreadable log throws to the caller. */
export async function probeOpenCodeLimit(input: { sessionId: string; sinceMs: number; logPath?: string }): Promise<OpenCodeLimitResult> {
  return classifyOpenCodeLimit(await readLogTail(input.logPath ?? openCodeLogPath()), input.sessionId, input.sinceMs);
}
