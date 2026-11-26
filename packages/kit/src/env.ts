export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LOG_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

let entryHostId: string | undefined;
let entryHostIdSet = false;
let entryLogLevel: LogLevel | undefined;
let entryDebugFix: boolean | undefined;

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = "debug"): LogLevel {
  const normalized = raw?.trim().toLowerCase();
  return normalized && normalized in LOG_RANK ? (normalized as LogLevel) : fallback;
}

/**
 * Reads `BB_HOST_ID` and `LOG_LEVEL` once at the plugin entry point and caches them.
 * Logs `DEBUG debugEnabled=...` once at start when a logger is supplied.
 */
export function initRuntimeEnv(options?: {
  hostId?: string | undefined;
  logLevel?: string | undefined;
  debugFix?: unknown;
  log?: (message: string) => void;
}): { hostId: string | undefined; logLevel: LogLevel; debugEnabled: boolean } {
  const rawHost = (options && "hostId" in options ? options.hostId : process.env.BB_HOST_ID)?.trim();
  entryHostId = rawHost || undefined;
  entryHostIdSet = true;
  const rawLevel = options && "logLevel" in options ? options.logLevel : process.env.LOG_LEVEL;
  entryLogLevel = parseLogLevel(rawLevel, "debug");
  entryDebugFix = Boolean(options && "debugFix" in options ? options.debugFix : process.env.DEBUG_FIX);
  const debugEnabled = shouldLogLevel("debug");
  options?.log?.(`DEBUG debugEnabled=${debugEnabled} logLevel=${entryLogLevel}`);
  return { hostId: entryHostId, logLevel: entryLogLevel, debugEnabled };
}

export function currentHostId(): string | undefined;
export function currentHostId(fallback: string): string;
export function currentHostId(fallback?: string): string | undefined {
  const value = entryHostIdSet ? entryHostId : process.env.BB_HOST_ID?.trim() || undefined;
  return value ?? fallback;
}

export function currentLogLevel(fallback: LogLevel = "debug"): LogLevel {
  if (entryLogLevel !== undefined) return entryLogLevel;
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL;
  return parseLogLevel(raw, fallback);
}

export function shouldLogLevel(level: LogLevel, overrideLevel?: LogLevel): boolean {
  if (level === "silent") return false;
  const effective = overrideLevel ?? currentLogLevel("debug");
  return LOG_RANK[level] >= LOG_RANK[effective];
}

export function isDebugFixEnabled(): boolean {
  if (entryDebugFix) return true;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return Boolean(env?.DEBUG_FIX) || currentLogLevel("debug") === "debug";
}
