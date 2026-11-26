import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LanePilotDatabase } from "../../../storage";
import { stringAt } from "@lane-pilot/kit";
import { costUsd } from "@lane-pilot/models";
import { billedFrom, hasTokens, isCumulativeProvider, parseBreakdown, tokenDelta } from "../../models/token-math";
import {
  eventCreatedAt,
  eventSeq,
  eventType,
  listingError,
  turnModel,
  turnProvider,
  usageFromEvent,
  usageTurnId,
} from "../../models/thread-usage";
import {
  DAY_MS,
  EMPTY_DIAGNOSTICS,
  THREAD_PAGE,
  TOKEN_USAGE_CACHE_SPLIT_RESET_KEY,
  TOKEN_USAGE_CURSOR_RESET_KEY,
  TOKEN_USAGE_DIAGNOSTICS_KEY,
  TOKEN_USAGE_LAST_SYNC_KEY,
  daysOn,
  normalizeModel,
  parseDiagnostics,
  rangeBounds,
  utcDay,
  type DailyTokenAdd,
  type ListedThread,
  type ThreadFoldResult,
  type TokenUsageDiagnostics,
  type TokenUsageMismatch,
  type TokenUsageQuery,
  type TokenUsageRebuildReset,
  type TokenUsageResult,
} from "../../models/token-usage";
import {
  clearTokenUsageTables,
  commitTokenFold,
  listCursorBreakdowns,
  listCursorProviders,
  listDailyProviders,
  listDailyUsageMonths,
  listDailyUsageRows,
  loadCursor,
  resetTokenUsageForRebuild,
} from "../repositories/token-usage-repository";
import { listThreadEvents } from "./thread-usage";
import { emitTokenUsageAdded } from "./token-usage-bus";

async function listAllThreads(bb: BbPluginApi): Promise<ListedThread[]> {
  const found: ListedThread[] = [];
  const seen = new Set<string>();
  for (const archived of [false, true]) {
    for (let offset = 0; offset < 50_000; offset += THREAD_PAGE) {
      const page = await bb.sdk.threads.list({
        includeHidden: true, archived, limit: THREAD_PAGE, offset,
      } as never) as unknown;
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

async function resetCursorsOnce(ctx: { bb: BbPluginApi; db: LanePilotDatabase }, key: string): Promise<void> {
  const done = await ctx.bb.storage.kv.get(key);
  if (done) return;
  clearTokenUsageTables(ctx.db);
  await ctx.bb.storage.kv.set(key, 1);
}

async function resetBrokenCursors(ctx: { bb: BbPluginApi; db: LanePilotDatabase }): Promise<void> {
  await resetCursorsOnce(ctx, TOKEN_USAGE_CURSOR_RESET_KEY);
  await resetCursorsOnce(ctx, TOKEN_USAGE_CACHE_SPLIT_RESET_KEY);
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
  add(await bb.sdk.projects.list({ includePersonal: true } as never).catch((cause: unknown) => { bb.log.warn(`Lane Pilot usage: project list unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return []; }));
  add(await bb.sdk.projects.list({ includePersonal: true, archived: true } as never).catch((cause: unknown) => { bb.log.warn(`Lane Pilot usage: archived project list unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return []; }));
  return names;
}

export async function foldThreadEvents(
  ctx: { bb: BbPluginApi; db: LanePilotDatabase; isDisposed?: () => boolean },
  thread: ListedThread,
  options: { now: number; since: number },
): Promise<ThreadFoldResult> {
  if (ctx.isDisposed?.()) return { failed: false, error: null, tokensAdded: 0, mismatches: [] };
  const cursor = loadCursor(ctx.db, thread.id);
  let events: unknown[];
  try {
    events = await listThreadEvents(ctx.bb, thread.id, cursor.last_seq);
  } catch (cause) {
    return { failed: true, error: listingError(cause), tokensAdded: 0, mismatches: [] };
  }
  if (ctx.isDisposed?.()) return { failed: false, error: null, tokensAdded: 0, mismatches: [] };
  let model = cursor.last_model;
  let providerId = cursor.last_provider || thread.providerId;
  const cursorTotal = JSON.parse(cursor.total_json || "{}") as Record<string, unknown>;
  let turns = typeof cursorTotal.turns === "number" ? cursorTotal.turns : 0;
  let prev = { last: parseBreakdown(cursor.last_json), total: parseBreakdown(cursor.total_json), turnId: cursor.last_turn_id };
  let lastSeq = cursor.last_seq;
  let pendingMismatch: { chosen: string; actual: string } | null = null;
  let tokensAdded = 0;
  const mismatches: TokenUsageMismatch[] = [];
  const dailyAdds: DailyTokenAdd[] = [];

  for (const event of events) {
    const type = eventType(event);
    const createdAt = eventCreatedAt(event);
    const tooOld = createdAt !== null && createdAt < options.since;
    if (type === "provider/modelFallback") {
      // The turn ran on another model than the chosen one: booked under the actual model, and the mismatch is
      // named to the person (SMA m_cf_book_usage) — the chosen model is remembered until the turn's spend lands.
      const chosen = stringAt(event as never, "originalModel") ?? stringAt((event as { data?: never }).data ?? {}, "originalModel");
      pendingMismatch = chosen && chosen !== model ? { chosen, actual: "" } : null;
      model = turnModel(event) ?? model;
      providerId = turnProvider(event, providerId);
      if (pendingMismatch) pendingMismatch.actual = model;
    } else if (type === "client/turn/requested" || type === "client/thread/start" || type === "client/turn/start") {
      model = turnModel(event) ?? model;
      providerId = turnProvider(event, providerId);
    } else if (type === "thread/tokenUsage/updated") {
      const usage = usageFromEvent(event);
      if (usage) {
        const turnId = usageTurnId(event);
        if (turnId && turnId !== prev.turnId) turns += 1;
        if (!tooOld) {
          const delta = tokenDelta(usage, prev, turnId, isCumulativeProvider(providerId || thread.providerId));
          tokensAdded += billedFrom(delta).total;
          dailyAdds.push({
            day: utcDay(createdAt ?? options.now),
            projectId: thread.projectId,
            providerId: providerId || thread.providerId || "unknown",
            model: model || "unknown",
            delta,
          });
          if (pendingMismatch && pendingMismatch.actual) {
            mismatches.push({ threadId: thread.id, projectId: thread.projectId, chosen: pendingMismatch.chosen, actual: pendingMismatch.actual, tokens: billedFrom(delta).total, at: createdAt ?? options.now });
            pendingMismatch = null;
          }
        }
        prev = { last: usage.last, total: usage.total, turnId };
      }
    }
    lastSeq = Math.max(lastSeq, eventSeq(event));
  }

  const committed = commitTokenFold(ctx.db, {
    thread,
    expectedSeq: cursor.last_seq,
    nextCursor: {
      last_seq: lastSeq,
      last_json: JSON.stringify(prev.last),
      total_json: JSON.stringify({ ...prev.total, turns }),
      last_model: model,
      last_provider: providerId,
      last_turn_id: prev.turnId,
    },
    dailyAdds,
    now: options.now,
  });
  return { failed: false, error: null, tokensAdded: committed ? tokensAdded : 0, mismatches: committed ? mismatches : [] };
}

export async function syncTokenUsage(ctx: { bb: BbPluginApi; db: LanePilotDatabase; isDisposed?: () => boolean }, input: { sinceDays: number } = { sinceDays: 90 }): Promise<TokenUsageDiagnostics> {
  const now = Date.now();
  const since = now - Math.max(1, input.sinceDays) * DAY_MS;
  const diagnostics: TokenUsageDiagnostics = { ...EMPTY_DIAGNOSTICS };
  const saveDiagnostics = () => ctx.bb.storage.kv.set(TOKEN_USAGE_DIAGNOSTICS_KEY, diagnostics);
  try {
    await resetBrokenCursors(ctx);
    const threads = await listAllThreads(ctx.bb);
    diagnostics.threadsSeen = threads.length;
    let loggedListingError = false;
    let totalAdded = 0;
    for (const thread of threads) {
      if (ctx.isDisposed?.()) break;
      const folded = await foldThreadEvents(ctx, thread, { now, since });
      if (folded.failed && folded.error) {
        diagnostics.threadsFailed += 1;
        if (!diagnostics.lastError) diagnostics.lastError = folded.error;
        if (!loggedListingError) {
          ctx.bb.log.warn(`Lane Pilot token usage listing failed: ${folded.error}`);
          loggedListingError = true;
        }
        continue;
      }
      totalAdded += folded.tokensAdded;
      if (folded.mismatches.length) {
        diagnostics.mismatches = [...(diagnostics.mismatches ?? []), ...folded.mismatches].slice(-50);
      }
    }
    if (ctx.isDisposed?.()) return diagnostics;
    const usageCursors = listCursorBreakdowns(ctx.db);
    diagnostics.threadsWithUsage = usageCursors.filter((row) => hasTokens(parseBreakdown(row.last_json)) || hasTokens(parseBreakdown(row.total_json))).length;
    await ctx.bb.storage.kv.set(TOKEN_USAGE_LAST_SYNC_KEY, now);
    await saveDiagnostics();
    if (totalAdded > 0) emitTokenUsageAdded(ctx.bb);
    return diagnostics;
  } catch (cause) {
    if (!diagnostics.lastError) diagnostics.lastError = listingError(cause);
    await saveDiagnostics();
    throw cause;
  }
}

/** Reset (with backups) and re-sync from the thread events with the current delta rule. Safe to repeat: it ends in the same numbers. */
export async function rebuildTokenUsage(ctx: { bb: BbPluginApi; db: LanePilotDatabase }, input: { sinceDays: number } = { sinceDays: 90 }): Promise<TokenUsageRebuildReset & { diagnostics: TokenUsageDiagnostics }> {
  const reset = resetTokenUsageForRebuild(ctx.db);
  return { ...reset, diagnostics: await syncTokenUsage(ctx, input) };
}

export async function queryTokenUsage(ctx: { bb: BbPluginApi; db: LanePilotDatabase }, input: TokenUsageQuery): Promise<TokenUsageResult> {
  const now = input.now ?? Date.now();
  const { from, to } = rangeBounds(input, now);
  const projectId = input.projectId;
  const daily = listDailyUsageRows(ctx.db, from, to, projectId);
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
  const months = listDailyUsageMonths(ctx.db, projectId);
  const lastSync = await ctx.bb.storage.kv.get(TOKEN_USAGE_LAST_SYNC_KEY);
  const lastSyncAt = typeof lastSync === "number" && Number.isFinite(lastSync) ? lastSync : null;
  const diagnostics = parseDiagnostics(await ctx.bb.storage.kv.get(TOKEN_USAGE_DIAGNOSTICS_KEY));
  const seen = listCursorProviders(ctx.db, projectId);
  const withEvents = new Set(listDailyProviders(ctx.db));
  const noDataProviders = [...new Set(seen.filter((id) => !withEvents.has(id)))].sort();
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
  return { byModel, series, byProject, months, lastSyncAt, noDataProviders, diagnostics, mismatches: diagnostics.mismatches ?? [], costUsd: totalCost };
}
