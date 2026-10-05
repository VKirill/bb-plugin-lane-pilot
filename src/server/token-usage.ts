import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LanePilotDatabase } from "../database";
import { pluginStopped } from "./run-finish";
import { stringAt, valueAt } from "./values";
import type { ServerCore } from "./core";

export const TOKEN_USAGE_SCHEDULE = "token-usage-sync";
export const TOKEN_USAGE_LAST_SYNC_KEY = "token-usage:last-sync-at";
export const TOKEN_USAGE_DIAGNOSTICS_KEY = "token-usage:diagnostics";
export const TOKEN_USAGE_CURSOR_RESET_KEY = "token-usage:reset-cursors-0.1.152";
export const TOKEN_USAGE_EVENT_TYPES = [
  "thread/tokenUsage/updated",
  "client/turn/requested",
  "client/thread/start",
  "provider/modelFallback",
] as const;
const THREAD_PAGE = 200;
export const EVENT_PAGE = 100;
const DAY_MS = 86_400_000;

export type TokenBreakdown = { input: number; output: number; cached: number; total: number };
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
  byModel: Array<{ providerId: string; model: string; input: number; output: number; cached: number; total: number }>;
  series: Array<{ day: string; models: Array<{ providerId: string; model: string; total: number }> }>;
  byProject: Array<{ projectId: string; total: number; share: number; topModel: string }>;
  months: string[];
  lastSyncAt: number | null;
  noDataProviders: string[];
  diagnostics: TokenUsageDiagnostics;
};

const EMPTY_DIAGNOSTICS: TokenUsageDiagnostics = {
  threadsSeen: 0, threadsWithUsage: 0, threadsFailed: 0, lastError: null,
};

const ZERO: TokenBreakdown = { input: 0, output: 0, cached: 0, total: 0 };

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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
  const n = (key: string) => {
    const value = Reflect.get(raw, key);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  };
  return {
    input: n("inputTokens"),
    output: n("outputTokens"),
    cached: n("cachedInputTokens") || n("cacheReadInputTokens"),
    total: n("totalTokens"),
  };
}

function hasTokens(row: TokenBreakdown): boolean {
  return row.total > 0 || row.input > 0 || row.output > 0 || row.cached > 0;
}

function sameTokens(a: TokenBreakdown, b: TokenBreakdown): boolean {
  return a.input === b.input && a.output === b.output && a.cached === b.cached && a.total === b.total;
}

function subTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cached: Math.max(0, a.cached - b.cached),
    total: Math.max(0, a.total - b.total),
  };
}

/** Per-turn delta from `last`; consecutive `total` only when last is missing or a re-emit. Never add cumulative totals. */
export function tokenDelta(
  usage: { last?: TokenBreakdown | null; total?: TokenBreakdown | null },
  prev: { last: TokenBreakdown; total: TokenBreakdown; turnId: string },
  turnId = "",
): TokenBreakdown {
  const last = usage.last ?? ZERO;
  const total = usage.total ?? ZERO;
  if (turnId && turnId === prev.turnId && hasTokens(last)) return subTokens(last, prev.last);
  if (hasTokens(last) && !sameTokens(last, prev.last)) return last;
  if (hasTokens(total) && hasTokens(prev.total)) return subTokens(total, prev.total);
  if (hasTokens(total) && !hasTokens(last) && !hasTokens(prev.total)) return total;
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

async function resetBrokenCursors(ctx: { bb: BbPluginApi; db: LanePilotDatabase }): Promise<void> {
  const done = await ctx.bb.storage.kv.get(TOKEN_USAGE_CURSOR_RESET_KEY).catch(() => null);
  if (done) return;
  ctx.db.transaction(() => {
    ctx.db.prepare(`DELETE FROM lane_pilot_token_cursor`).run();
    ctx.db.prepare(`DELETE FROM lane_pilot_token_daily`).run();
  })();
  await ctx.bb.storage.kv.set(TOKEN_USAGE_CURSOR_RESET_KEY, 1);
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
    const stored = { input: n("input"), output: n("output"), cached: n("cached"), total: n("total") };
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
  if (!hasTokens(row.delta)) return;
  db.prepare(`INSERT INTO lane_pilot_token_daily
    (day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(day, project_id, provider_id, model) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      total_tokens = total_tokens + excluded.total_tokens`)
    .run(row.day, row.projectId, row.providerId, row.model, row.delta.input, row.delta.output, row.delta.cached, row.delta.total);
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
    ? ctx.db.prepare(`SELECT day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens
        FROM lane_pilot_token_daily WHERE day>=? AND day<=? AND project_id=?`).all(from, to, projectId)
    : ctx.db.prepare(`SELECT day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens
        FROM lane_pilot_token_daily WHERE day>=? AND day<=?`).all(from, to)) as Array<{
    day: string; project_id: string; provider_id: string; model: string; input_tokens: number; output_tokens: number; cached_tokens: number; total_tokens: number;
  }>;
  const byKey = new Map<string, TokenUsageResult["byModel"][number]>();
  const byDay = new Map<string, TokenUsageResult["series"][number]["models"]>();
  const byProjectMap = new Map<string, { total: number; models: Map<string, number> }>();
  for (const row of daily) {
    const key = `${row.provider_id}\0${row.model}`;
    const current = byKey.get(key) ?? { providerId: row.provider_id, model: row.model, input: 0, output: 0, cached: 0, total: 0 };
    current.input += row.input_tokens;
    current.output += row.output_tokens;
    current.cached += row.cached_tokens;
    current.total += row.total_tokens;
    byKey.set(key, current);
    const dayModels = byDay.get(row.day) ?? [];
    const existing = dayModels.find((item) => item.providerId === row.provider_id && item.model === row.model);
    if (existing) existing.total += row.total_tokens;
    else dayModels.push({ providerId: row.provider_id, model: row.model, total: row.total_tokens });
    byDay.set(row.day, dayModels);
    const project = byProjectMap.get(row.project_id) ?? { total: 0, models: new Map<string, number>() };
    project.total += row.total_tokens;
    project.models.set(row.model, (project.models.get(row.model) ?? 0) + row.total_tokens);
    byProjectMap.set(row.project_id, project);
  }
  const byModel = [...byKey.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
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
    return { projectId: id, total: row.total, share: projectTotal > 0 ? row.total / projectTotal : 0, topModel };
  }).sort((a, b) => b.total - a.total || a.projectId.localeCompare(b.projectId));
  return { byModel, series, byProject, months: months.map((row) => row.month), lastSyncAt, noDataProviders, diagnostics };
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
  ctx.bb.background.schedule(TOKEN_USAGE_SCHEDULE, "*/30 * * * *", async () => { start(90); });
  start(90);
  return { start };
}
