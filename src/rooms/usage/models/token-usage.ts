import type { TokenBreakdown } from "./token-math";

export const TOKEN_USAGE_SCHEDULE = "token-usage-sync";
export const TOKEN_USAGE_LAST_SYNC_KEY = "token-usage:last-sync-at";
export const TOKEN_USAGE_DIAGNOSTICS_KEY = "token-usage:diagnostics";
export const TOKEN_USAGE_CURSOR_RESET_KEY = "token-usage:reset-cursors-0.1.152";
export const TOKEN_USAGE_CACHE_SPLIT_RESET_KEY = "token-usage:reset-cursors-0.1.159";
export const THREAD_PAGE = 200;
export const DAY_MS = 86_400_000;

export type TokenUsageRange = "7d" | "14d" | "30d" | "month";
export type TokenUsageQuery = {
  range: TokenUsageRange;
  month?: string;
  projectId?: string;
  now?: number;
};
export type TokenUsageMismatch = { threadId: string; projectId: string; chosen: string; actual: string; tokens: number; at: number };
export type TokenUsageDiagnostics = {
  threadsSeen: number;
  threadsWithUsage: number;
  threadsFailed: number;
  lastError: string | null;
  /** Turns booked under another model than the chosen one (newest 50): «выбрана opus, ход шёл на sonnet». */
  mismatches?: TokenUsageMismatch[];
};
export type TokenUsageResult = {
  /** The model mismatches the last sync saw (SMA m_cf_book_usage): the person is told the turn ran elsewhere. */
  mismatches: TokenUsageMismatch[];
  byModel: Array<{ providerId: string; model: string; input: number; output: number; cached: number; total: number; costUsd: number | null }>;
  series: Array<{ day: string; models: Array<{ providerId: string; model: string; total: number }> }>;
  byProject: Array<{ projectId: string; projectName: string; total: number; share: number; topModel: string; costUsd: number | null }>;
  months: string[];
  lastSyncAt: number | null;
  noDataProviders: string[];
  diagnostics: TokenUsageDiagnostics;
  costUsd: number | null;
};

export type ListedThread = { id: string; projectId: string; providerId: string };
export type CursorRow = {
  last_seq: number;
  last_json: string;
  total_json: string;
  last_model: string;
  last_provider: string;
  last_turn_id: string;
};
export type DailyTokenAdd = {
  day: string;
  projectId: string;
  providerId: string;
  model: string;
  delta: TokenBreakdown;
};
export type DailyTokenRow = {
  day: string;
  project_id: string;
  provider_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  uncached_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};
export type ThreadFoldResult = { failed: boolean; error: string | null; tokensAdded: number; mismatches: TokenUsageMismatch[] };
export type TokenUsageRebuildReset = { backups: string[]; backupsKept: string[]; cursorsCleared: number; dailyRowsCleared: number };

export const EMPTY_DIAGNOSTICS: TokenUsageDiagnostics = {
  threadsSeen: 0, threadsWithUsage: 0, threadsFailed: 0, lastError: null,
};

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function normalizeModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

export function rangeBounds(input: TokenUsageQuery, now = Date.now()): { from: string; to: string } {
  const today = utcDay(now);
  if (input.range === "month") {
    const month = input.month && /^\d{4}-\d{2}$/.test(input.month) ? input.month : today.slice(0, 7);
    const year = Number(month.slice(0, 4));
    const monthIndex = Number(month.slice(5, 7));
    return { from: `${month}-01`, to: new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10) };
  }
  const days = input.range === "7d" ? 7 : input.range === "14d" ? 14 : 30;
  return { from: utcDay(now - (days - 1) * DAY_MS), to: today };
}

export function parseDiagnostics(raw: unknown): TokenUsageDiagnostics {
  if (!raw || typeof raw !== "object") return { ...EMPTY_DIAGNOSTICS };
  const n = (key: string) => {
    const value = Reflect.get(raw, key);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  };
  const lastError = Reflect.get(raw, "lastError");
  // The mismatches the last sync saw (SMA m_cf_book_usage) are kept as stored: the stored diagnostics used to be read back without them, so the person never saw one.
  const stored = Reflect.get(raw, "mismatches");
  const mismatches = (Array.isArray(stored) ? stored : []).filter((row): row is TokenUsageMismatch => !!row && typeof row === "object" && typeof row.chosen === "string" && typeof row.actual === "string" && typeof row.tokens === "number");
  return {
    threadsSeen: n("threadsSeen"),
    threadsWithUsage: n("threadsWithUsage"),
    threadsFailed: n("threadsFailed"),
    lastError: typeof lastError === "string" && lastError.length > 0 ? lastError : null,
    ...(mismatches.length ? { mismatches } : {}),
  };
}

export function daysOn(from: string, to: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return days;
  for (let ms = start; ms <= end; ms += DAY_MS) days.push(utcDay(ms));
  return days;
}
