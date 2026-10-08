import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LanePilotDatabase } from "../database";
import { pluginStopped } from "./run-finish";
import { stringAt, valueAt } from "./values";
import { MODEL_PRICES, costUsd } from "../model-prices";
import type { ServerCore } from "./core";
import { scheduleIsolated } from "./schedules";

export const TOKEN_USAGE_SCHEDULE = "token-usage-sync";
export const TOKEN_USAGE_LAST_SYNC_KEY = "token-usage:last-sync-at";
export const TOKEN_USAGE_DIAGNOSTICS_KEY = "token-usage:diagnostics";
export const TOKEN_USAGE_CURSOR_RESET_KEY = "token-usage:reset-cursors-0.1.152";
export const TOKEN_USAGE_CACHE_SPLIT_RESET_KEY = "token-usage:reset-cursors-0.1.159";
export const TOKEN_USAGE_EVENT_TYPES = [
  "thread/tokenUsage/updated",
  "client/turn/requested",
  "client/thread/start",
  "provider/modelFallback",
] as const;
const THREAD_PAGE = 200;
export const EVENT_PAGE = 100;
const DAY_MS = 86_400_000;

export type TokenBreakdown = {
  input: number; output: number; cached: number; total: number; cacheRead: number; cacheWrite: number;
};
export type TokenUsageRange = "7d" | "14d" | "30d" | "month";
export type TokenUsageQuery = {
  range: TokenUsageRange;
  month?: string;
  projectId?: string;
  now?: number;
};
export type TokenUsageDiagnostics = {
  threadsSeen: number;
  threadsWithUsage: number;
  threadsFailed: number;
  lastError: string | null;
};
export type TokenUsageResult = {
  byModel: Array<{ providerId: string; model: string; input: number; output: number; cached: number; total: number; costUsd: number | null }>;
  series: Array<{ day: string; models: Array<{ providerId: string; model: string; total: number }> }>;
  byProject: Array<{ projectId: string; projectName: string; total: number; share: number; topModel: string; costUsd: number | null }>;
  months: string[];
  lastSyncAt: number | null;
  noDataProviders: string[];
  diagnostics: TokenUsageDiagnostics;
  costUsd: number | null;
};

const EMPTY_DIAGNOSTICS: TokenUsageDiagnostics = {
  threadsSeen: 0, threadsWithUsage: 0, threadsFailed: 0, lastError: null,
};

const ZERO: TokenBreakdown = { input: 0, output: 0, cached: 0, total: 0, cacheRead: 0, cacheWrite: 0 };

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

export function tokenBreakdown(raw: unknown): TokenBreakdown {
  if (!raw || typeof raw !== "object") return { ...ZERO };
  const nMaybe = (key: string) => {
    const value = Reflect.get(raw, key);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
  };
  const cached = nMaybe("cachedInputTokens") ?? nMaybe("cacheReadInputTokens") ?? 0;
  const output = nMaybe("outputTokens") ?? 0;
  const total = nMaybe("totalTokens") ?? 0;
  const input = nMaybe("inputTokens") ?? 0;
  const cacheWrite = nMaybe("cacheWriteInputTokens") ?? 0;
  const cacheRead = nMaybe("cacheReadInputTokens") ?? cached;
  return { input, output, cached, total, cacheRead, cacheWrite };
}

function hasTokens(row: TokenBreakdown): boolean {
  return row.total > 0 || row.input > 0 || row.output > 0 || row.cached > 0 || row.cacheRead > 0 || row.cacheWrite > 0;
}

function sameTokens(a: TokenBreakdown, b: TokenBreakdown): boolean {
  return a.input === b.input && a.output === b.output && a.cached === b.cached && a.total === b.total
    && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

function subTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cached: Math.max(0, a.cached - b.cached),
    total: Math.max(0, a.total - b.total),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  };
}

function asBreakdown(row?: TokenBreakdown | null): TokenBreakdown {
  return { ...ZERO, ...row };
}

function billedFrom(delta: TokenBreakdown): {
  uncached: number; cacheRead: number; cacheWrite: number; output: number; input: number; cached: number; total: number;
} {
  const cached = delta.cached > 0 ? delta.cached : delta.cacheRead + delta.cacheWrite;
  const uncached = Math.max(0, delta.total - delta.output - cached);
  const cacheRead = delta.cacheRead;
  const cacheWrite = delta.cacheWrite;
  const input = uncached + cacheRead + cacheWrite;
  const cachedOut = cacheRead + cacheWrite;
  const total = delta.total > 0 ? delta.total : input + delta.output;
  return { uncached, cacheRead, cacheWrite, output: delta.output, input, cached: cachedOut, total };
}

/** Per-turn delta from `last`; consecutive `total` only when last is missing or a re-emit. Never add cumulative totals. */
export function tokenDelta(
  usage: { last?: TokenBreakdown | null; total?: TokenBreakdown | null },
  prev: { last: TokenBreakdown; total: TokenBreakdown; turnId: string },
  turnId = "",
): TokenBreakdown {
  const last = asBreakdown(usage.last);
  const total = asBreakdown(usage.total);
  const prevLast = asBreakdown(prev.last);
  const prevTotal = asBreakdown(prev.total);
  if (turnId && turnId === prev.turnId && hasTokens(last)) return subTokens(last, prevLast);
  if (hasTokens(last) && !sameTokens(last, prevLast)) return last;
  if (hasTokens(total) && hasTokens(prevTotal)) return subTokens(total, prevTotal);
  if (hasTokens(total) && !hasTokens(last) && !hasTokens(prevTotal)) return total;
  if (hasTokens(last)) return last;
  return { ...ZERO };
}

function eventBag(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== "object") return {};
  const data = valueAt(event, "data");
  return data && typeof data === "object" ? data as Record<string, unknown> : event as Record<string, unknown>;
}

function eventSeq(event: unknown): number {
  const seq = valueAt(event, "seq") ?? valueAt(eventBag(event), "seq");
  if (typeof seq === "number" && Number.isFinite(seq)) return seq;
  if (typeof seq === "string" && /^\d+$/.test(seq)) return Number(seq);
  return 0;
}

function listingError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/\s+/g, " ").slice(0, 240);
}

function eventCreatedAt(event: unknown): number | null {
  const at = valueAt(event, "createdAt") ?? valueAt(eventBag(event), "createdAt");
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

function eventType(event: unknown): string {
  return stringAt(event, "type") ?? stringAt(eventBag(event), "type") ?? "";
}

function turnModel(event: unknown): string | null {
  const bag = eventBag(event);
  const type = eventType(event);
  if (type === "provider/modelFallback") {
    return stringAt(bag, "fallbackModel") ?? stringAt(event, "fallbackModel");
  }
  const request = valueAt(bag, "request");
  const params = request && typeof request === "object" ? valueAt(request, "params") : undefined;
  const execution = valueAt(bag, "execution") ?? valueAt(params ?? {}, "execution") ?? valueAt(params ?? {}, "options");
  return stringAt(execution, "model") ?? stringAt(params ?? {}, "model");
}

function turnProvider(event: unknown, fallback: string): string {
  const bag = eventBag(event);
  const request = valueAt(bag, "request");
  const params = request && typeof request === "object" ? valueAt(request, "params") : undefined;
  const execution = valueAt(bag, "execution") ?? valueAt(params ?? {}, "execution") ?? valueAt(params ?? {}, "options");
  return stringAt(execution, "providerId") ?? stringAt(params ?? {}, "providerId") ?? fallback;
}

function usageTurnId(event: unknown): string {
  const bag = eventBag(event);
  return stringAt(bag, "turnId") ?? stringAt(event, "turnId") ?? "";
}

function usageFromEvent(event: unknown): { last: TokenBreakdown; total: TokenBreakdown } | null {
  const bag = eventBag(event);
  const usage = valueAt(bag, "tokenUsage") ?? valueAt(event, "tokenUsage");
  if (!usage || typeof usage !== "object") return null;
  return { last: tokenBreakdown(valueAt(usage, "last")), total: tokenBreakdown(valueAt(usage, "total")) };
}

type ListedThread = { id: string; projectId: string; providerId: string };

async function listAllThreads(bb: BbPluginApi): Promise<ListedThread[]> {
  const found: ListedThread[] = [];
  const seen = new Set<string>();
  for (const archived of [false, true]) {
    for (let offset = 0; offset < 50_000; offset += THREAD_PAGE) {
      const page = await bb.sdk.threads.list({
        includeHidden: true, archived, limit: THREAD_PAGE, offset,
      } as never).catch(() => []) as unknown;
      const rows = Array.isArray(page) ? page : [];
      for (const row of rows) {
        const id = stringAt(row, "id");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        found.push({
          id,
          projectId: stringAt(row, "projectId") ?? "",
          providerId: stringAt(row, "providerId") ?? "",
        });
      }
      if (rows.length < THREAD_PAGE) break;
    }
  }
  return found;
}

async function listThreadEvents(bb: BbPluginApi, threadId: string, afterSeq: number): Promise<unknown[]> {
  const events: unknown[] = [];
  let cursor = afterSeq;
  for (let pages = 0; pages < 200; pages++) {
    const listed = await bb.sdk.threads.events.list({
      threadId,
      order: "asc",
      limit: String(EVENT_PAGE),
      ...(cursor > 0 ? { afterSeq: String(cursor) } : {}),
      types: TOKEN_USAGE_EVENT_TYPES,
    });
    if (!Array.isArray(listed)) {
      throw new Error(`events_list_invalid:threadId=${threadId};result=${listed === null ? "null" : typeof listed}`);
    }
    if (listed.length === 0) break;
    events.push(...listed);
    const last = eventSeq(listed[listed.length - 1]);
    if (last <= cursor || listed.length < EVENT_PAGE) break;
    cursor = last;
  }
  return events;
}

function parseDiagnostics(raw: unknown): TokenUsageDiagnostics {
  if (!raw || typeof raw !== "object") return { ...EMPTY_DIAGNOSTICS };
  const n = (key: string) => {
    const value = Reflect.get(raw, key);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  };
  const lastError = Reflect.get(raw, "lastError");
  return {
    threadsSeen: n("threadsSeen"),
    threadsWithUsage: n("threadsWithUsage"),
    threadsFailed: n("threadsFailed"),
    lastError: typeof lastError === "string" && lastError.length > 0 ? lastError : null,
  };
}

async function resetCursorsOnce(ctx: { bb: BbPluginApi; db: LanePilotDatabase }, key: string): Promise<void> {
  const done = await ctx.bb.storage.kv.get(key).catch(() => null);
  if (done) return;
  ctx.db.transaction(() => {
    ctx.db.prepare(`DELETE FROM lane_pilot_token_cursor`).run();
    ctx.db.prepare(`DELETE FROM lane_pilot_token_daily`).run();
  })();
  await ctx.bb.storage.kv.set(key, 1);
}

async function resetBrokenCursors(ctx: { bb: BbPluginApi; db: LanePilotDatabase }): Promise<void> {
  await resetCursorsOnce(ctx, TOKEN_USAGE_CURSOR_RESET_KEY);
  await resetCursorsOnce(ctx, TOKEN_USAGE_CACHE_SPLIT_RESET_KEY);
}

type CursorRow = {
  last_seq: number;
  last_json: string;
  total_json: string;
  last_model: string;
  last_provider: string;
  last_turn_id: string;
};

function parseBreakdown(raw: string): TokenBreakdown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...ZERO };
    const n = (key: string) => {
      const value = Reflect.get(parsed, key);
      return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    };
    const stored = {
      input: n("input"), output: n("output"), cached: n("cached"), total: n("total"),
      cacheRead: n("cacheRead"), cacheWrite: n("cacheWrite"),
    };
    return hasTokens(stored) ? stored : tokenBreakdown(parsed);
  } catch { return { ...ZERO }; }
}

function loadCursor(db: LanePilotDatabase, threadId: string): CursorRow {
  const row = db.prepare(`SELECT last_seq, last_json, total_json, last_model, last_provider, last_turn_id
    FROM lane_pilot_token_cursor WHERE thread_id=?`).get(threadId) as CursorRow | undefined;
  return row ?? { last_seq: 0, last_json: "{}", total_json: "{}", last_model: "", last_provider: "", last_turn_id: "" };
}

function addDaily(db: LanePilotDatabase, row: {
  day: string; projectId: string; providerId: string; model: string; delta: TokenBreakdown;
}): void {
  const billed = billedFrom(row.delta);
  if (billed.uncached <= 0 && billed.cacheRead <= 0 && billed.cacheWrite <= 0 && billed.output <= 0 && billed.total <= 0) return;
  db.prepare(`INSERT INTO lane_pilot_token_daily
    (day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens,
     uncached_tokens, cache_read_tokens, cache_write_tokens)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(day, project_id, provider_id, model) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      total_tokens = total_tokens + excluded.total_tokens,
      uncached_tokens = uncached_tokens + excluded.uncached_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`)
    .run(row.day, row.projectId, row.providerId, row.model, billed.input, billed.output, billed.cached, billed.total,
      billed.uncached, billed.cacheRead, billed.cacheWrite);
}

function saveCursor(db: LanePilotDatabase, thread: ListedThread, cursor: CursorRow, now: number): void {
  db.prepare(`INSERT INTO lane_pilot_token_cursor
    (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET
      project_id=excluded.project_id, provider_id=excluded.provider_id, last_seq=excluded.last_seq,
      last_json=excluded.last_json, total_json=excluded.total_json, last_model=excluded.last_model,
      last_provider=excluded.last_provider, last_turn_id=excluded.last_turn_id, updated_at=excluded.updated_at`)
    .run(thread.id, thread.projectId, cursor.last_provider || thread.providerId, cursor.last_seq,
      cursor.last_json, cursor.total_json, cursor.last_model, cursor.last_provider || thread.providerId,
      cursor.last_turn_id, now);
}

function daysOn(from: string, to: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return days;
  for (let ms = start; ms <= end; ms += DAY_MS) days.push(utcDay(ms));
  return days;
}

async function projectNames(bb: BbPluginApi): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const add = (rows: unknown) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = stringAt(row, "id");
      const name = stringAt(row, "name");
      if (id && name) names.set(id, name);
    }
  };
  add(await bb.sdk.projects.list({ includePersonal: true } as never).catch(() => []));
  add(await bb.sdk.projects.list({ includePersonal: true, archived: true } as never).catch(() => []));
  return names;
}

export async function syncTokenUsage(ctx: { bb: BbPluginApi; db: LanePilotDatabase }, input: { sinceDays: number } = { sinceDays: 90 }): Promise<TokenUsageDiagnostics> {
  const now = Date.now();
  const since = now - Math.max(1, input.sinceDays) * DAY_MS;
  const diagnostics: TokenUsageDiagnostics = { ...EMPTY_DIAGNOSTICS };
  const saveDiagnostics = () => ctx.bb.storage.kv.set(TOKEN_USAGE_DIAGNOSTICS_KEY, diagnostics);
  try {
    await resetBrokenCursors(ctx);
    const threads = await listAllThreads(ctx.bb);
    diagnostics.threadsSeen = threads.length;
    let loggedListingError = false;
    for (const thread of threads) {
      const cursor = loadCursor(ctx.db, thread.id);
      let events: unknown[];
      try {
        events = await listThreadEvents(ctx.bb, thread.id, cursor.last_seq);
      } catch (cause) {
        diagnostics.threadsFailed += 1;
        const message = listingError(cause);
        if (!diagnostics.lastError) diagnostics.lastError = message;
        if (!loggedListingError) {
          ctx.bb.log.warn(`Lane Pilot token usage listing failed: ${message}`);
          loggedListingError = true;
        }
        continue;
      }
      let model = cursor.last_model;
      let providerId = cursor.last_provider || thread.providerId;
      let prev = { last: parseBreakdown(cursor.last_json), total: parseBreakdown(cursor.total_json), turnId: cursor.last_turn_id };
      let lastSeq = cursor.last_seq;
      const apply = ctx.db.transaction((event: unknown) => {
        const type = eventType(event);
        const createdAt = eventCreatedAt(event);
        const tooOld = createdAt !== null && createdAt < since;
        if (type === "client/turn/requested" || type === "client/thread/start" || type === "provider/modelFallback" || type === "client/turn/start") {
          model = turnModel(event) ?? model;
          providerId = turnProvider(event, providerId);
        } else if (type === "thread/tokenUsage/updated") {
          const usage = usageFromEvent(event);
          if (usage) {
            const turnId = usageTurnId(event);
            if (!tooOld) {
              addDaily(ctx.db, {
                day: utcDay(createdAt ?? now),
                projectId: thread.projectId,
                providerId: providerId || thread.providerId || "unknown",
                model: model || "unknown",
                delta: tokenDelta(usage, prev, turnId),
              });
            }
            prev = { last: usage.last, total: usage.total, turnId };
          }
        }
        lastSeq = Math.max(lastSeq, eventSeq(event));
      });
      for (const event of events) apply(event);
      saveCursor(ctx.db, thread, {
        last_seq: lastSeq,
        last_json: JSON.stringify(prev.last),
        total_json: JSON.stringify(prev.total),
        last_model: model,
        last_provider: providerId,
        last_turn_id: prev.turnId,
      }, now);
    }
    const usageCursors = ctx.db.prepare(`SELECT last_json, total_json FROM lane_pilot_token_cursor`).all() as Array<{ last_json: string; total_json: string }>;
    diagnostics.threadsWithUsage = usageCursors.filter((row) => hasTokens(parseBreakdown(row.last_json)) || hasTokens(parseBreakdown(row.total_json))).length;
    await ctx.bb.storage.kv.set(TOKEN_USAGE_LAST_SYNC_KEY, now);
    await saveDiagnostics();
    return diagnostics;
  } catch (cause) {
    if (!diagnostics.lastError) diagnostics.lastError = listingError(cause);
    await saveDiagnostics();
    throw cause;
  }
}

export async function queryTokenUsage(ctx: { bb: BbPluginApi; db: LanePilotDatabase }, input: TokenUsageQuery): Promise<TokenUsageResult> {
  const now = input.now ?? Date.now();
  const { from, to } = rangeBounds(input, now);
  const projectId = input.projectId;
  const daily = (projectId
    ? ctx.db.prepare(`SELECT day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens,
        uncached_tokens, cache_read_tokens, cache_write_tokens
        FROM lane_pilot_token_daily WHERE day>=? AND day<=? AND project_id=?`).all(from, to, projectId)
    : ctx.db.prepare(`SELECT day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens,
        uncached_tokens, cache_read_tokens, cache_write_tokens
        FROM lane_pilot_token_daily WHERE day>=? AND day<=?`).all(from, to)) as Array<{
    day: string; project_id: string; provider_id: string; model: string; input_tokens: number; output_tokens: number;
    cached_tokens: number; total_tokens: number; uncached_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  }>;
  const names = await projectNames(ctx.bb);
  type ModelAgg = TokenUsageResult["byModel"][number] & { uncached: number; cacheRead: number; cacheWrite: number };
  const byKey = new Map<string, ModelAgg>();
  const byDay = new Map<string, TokenUsageResult["series"][number]["models"]>();
  const byProjectMap = new Map<string, { total: number; models: Map<string, number>; costUsd: number | null }>();
  for (const row of daily) {
    const model = normalizeModel(row.model);
    const key = `${row.provider_id}\0${model}`;
    const current = byKey.get(key) ?? {
      providerId: row.provider_id, model, input: 0, output: 0, cached: 0, total: 0, costUsd: null,
      uncached: 0, cacheRead: 0, cacheWrite: 0,
    };
    current.input += row.input_tokens;
    current.output += row.output_tokens;
    current.cached += row.cached_tokens;
    current.total += row.total_tokens;
    current.uncached += row.uncached_tokens;
    current.cacheRead += row.cache_read_tokens;
    current.cacheWrite += row.cache_write_tokens;
    byKey.set(key, current);
    const dayModels = byDay.get(row.day) ?? [];
    const existing = dayModels.find((item) => item.providerId === row.provider_id && item.model === model);
    if (existing) existing.total += row.total_tokens;
    else dayModels.push({ providerId: row.provider_id, model, total: row.total_tokens });
    byDay.set(row.day, dayModels);
    const project = byProjectMap.get(row.project_id) ?? { total: 0, models: new Map<string, number>(), costUsd: null };
    project.total += row.total_tokens;
    project.models.set(model, (project.models.get(model) ?? 0) + row.total_tokens);
    const rowCost = costUsd(model, {
      uncached: row.uncached_tokens, cacheRead: row.cache_read_tokens, cacheWrite: row.cache_write_tokens, output: row.output_tokens,
    });
    if (rowCost !== null) project.costUsd = (project.costUsd ?? 0) + rowCost;
    byProjectMap.set(row.project_id, project);
  }
  for (const row of byKey.values()) {
    row.costUsd = costUsd(row.model, {
      uncached: row.uncached, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, output: row.output,
    });
  }
  const byModel = [...byKey.values()]
    .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model))
    .map((row) => ({
      providerId: row.providerId, model: row.model, input: row.input, output: row.output,
      cached: row.cached, total: row.total, costUsd: row.costUsd,
    }));
  const series = daysOn(from, to).map((day) => ({
    day,
    models: (byDay.get(day) ?? []).sort((a, b) => b.total - a.total || a.model.localeCompare(b.model)),
  }));
  const months = (projectId
    ? ctx.db.prepare(`SELECT DISTINCT substr(day,1,7) AS month FROM lane_pilot_token_daily WHERE project_id=? ORDER BY month DESC`).all(projectId)
    : ctx.db.prepare(`SELECT DISTINCT substr(day,1,7) AS month FROM lane_pilot_token_daily ORDER BY month DESC`).all()
  ) as Array<{ month: string }>;
  const lastSync = await ctx.bb.storage.kv.get(TOKEN_USAGE_LAST_SYNC_KEY).catch(() => null);
  const lastSyncAt = typeof lastSync === "number" && Number.isFinite(lastSync) ? lastSync : null;
  const diagnostics = parseDiagnostics(await ctx.bb.storage.kv.get(TOKEN_USAGE_DIAGNOSTICS_KEY).catch(() => null));
  const seen = (projectId
    ? ctx.db.prepare(`SELECT DISTINCT provider_id FROM lane_pilot_token_cursor WHERE provider_id!='' AND project_id=?`).all(projectId)
    : ctx.db.prepare(`SELECT DISTINCT provider_id FROM lane_pilot_token_cursor WHERE provider_id!=''`).all()) as Array<{ provider_id: string }>;
  const withEvents = new Set((ctx.db.prepare(`SELECT DISTINCT provider_id FROM lane_pilot_token_daily`).all() as Array<{ provider_id: string }>)
    .map((row) => row.provider_id));
  const noDataProviders = [...new Set(seen.map((row) => row.provider_id).filter((id) => !withEvents.has(id)))].sort();
  const projectTotal = [...byProjectMap.values()].reduce((sum, row) => sum + row.total, 0);
  const byProject = [...byProjectMap.entries()].map(([id, row]) => {
    const topModel = [...row.models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
    return {
      projectId: id,
      projectName: names.get(id) ?? id,
      total: row.total,
      share: projectTotal > 0 ? row.total / projectTotal : 0,
      topModel,
      costUsd: row.costUsd,
    };
  }).sort((a, b) => b.total - a.total || a.projectId.localeCompare(b.projectId));
  const priced = byModel.map((row) => row.costUsd).filter((value): value is number => value !== null);
  const totalCost = priced.length > 0 ? priced.reduce((sum, value) => sum + value, 0) : null;
  return { byModel, series, byProject, months: months.map((row) => row.month), lastSyncAt, noDataProviders, diagnostics, costUsd: totalCost };
}

/** What a thread spent. `unknown` is set when BB shows no usage for it at all: the 0 is then "not reported", not "free". */
export type ThreadUsage = { tokens: number; costUsd: number; known: boolean; unknown?: true };

/**
 * What one thread spent from `since` (ms; 0 = from its start): total tokens and the price of them. The same events and the same per-turn
 * deltas as the daily sync (`thread/tokenUsage/updated` with the model of the turn that asked), read for this thread alone, so a workflow's
 * budget (`maxTokens`, `maxCostUsd`) counts what the Usage tab counts. A model the price table does not know is priced at the dearest
 * known rate: a budget that cannot see a cost must err on the cautious side. Never throws. A thread that cannot be read, or that has no
 * `thread/tokenUsage/updated` event at all (BB records none for ACP providers such as acp-opencode: only the context window), comes back
 * with `known: false` and `unknown: true` and zeros, so a budget never takes it for a free step.
 */
export async function threadUsage(bb: BbPluginApi, threadId: string, options: { since?: number; fallbackModel?: string } = {}): Promise<ThreadUsage> {
  const since = options.since ?? 0;
  let events: unknown[];
  try { events = await listThreadEvents(bb, threadId, 0); } catch { return { tokens: 0, costUsd: 0, known: false, unknown: true }; }
  if (!events.some((event) => eventType(event) === "thread/tokenUsage/updated" && usageFromEvent(event))) return { tokens: 0, costUsd: 0, known: false, unknown: true };
  const dearest = Object.keys(MODEL_PRICES).reduce((top, key) => (MODEL_PRICES[key]!.output > MODEL_PRICES[top]!.output ? key : top));
  let model = options.fallbackModel ?? "";
  let prev = { last: { ...ZERO }, total: { ...ZERO }, turnId: "" };
  let tokens = 0, cost = 0, known = false;
  for (const event of events) {
    const type = eventType(event);
    if (type === "client/turn/requested" || type === "client/thread/start" || type === "provider/modelFallback" || type === "client/turn/start") { model = turnModel(event) ?? model; continue; }
    if (type !== "thread/tokenUsage/updated") continue;
    const usage = usageFromEvent(event);
    if (!usage) continue;
    const turnId = usageTurnId(event);
    const delta = tokenDelta(usage, prev, turnId);
    prev = { last: usage.last, total: usage.total, turnId };
    const at = eventCreatedAt(event);
    if (at !== null && at < since) continue;
    const billed = billedFrom(delta);
    tokens += billed.total;
    cost += (model ? costUsd(model, billed) : null) ?? costUsd(dearest, billed) ?? 0;
  }
  // The thread reports usage (else the early return above): no event in the step's window is a step that spent nothing.
  return { tokens, costUsd: cost, known: true };
}

export function attachTokenUsage(ctx: ServerCore): { start: (sinceDays?: number) => boolean } {
  let running = false;
  const start = (sinceDays = 90) => {
    if (running) return false;
    running = true;
    void syncTokenUsage(ctx, { sinceDays })
      .catch((cause) => {
        if (!pluginStopped(cause)) ctx.bb.log.warn(`Lane Pilot token usage sync failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      })
      .finally(() => { running = false; });
    return true;
  };
  // The sync runs detached (`start` returns at once), so the isolated run is short; the limit only guards a stuck start.
  scheduleIsolated(ctx.bb, TOKEN_USAGE_SCHEDULE, "7,37 * * * *", async () => { start(90); }, { timeoutMs: 5 * 60_000 });
  start(90);
  return { start };
}
