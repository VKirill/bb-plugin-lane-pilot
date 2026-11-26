import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CostState } from "@lane-pilot/contracts";
import { stringAt } from "@lane-pilot/kit";
import { MODEL_PRICES, costUsd } from "@lane-pilot/models";
import { ZERO, billedFrom, tokenDelta } from "../../models/token-math";
import {
  EVENT_PAGE,
  TOKEN_USAGE_EVENT_TYPES,
  eventBag,
  eventCreatedAt,
  eventSeq,
  eventType,
  turnModel,
  turnProvider,
  usageFromEvent,
  usageTurnId,
  type ThreadUsage,
} from "../../models/thread-usage";

export type { ThreadUsage };

export async function listThreadEvents(bb: BbPluginApi, threadId: string, afterSeq: number): Promise<unknown[]> {
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

/**
 * What one thread spent from `since` (ms; 0 = from its start) up to `until` (ms, exclusive; none = to its end): total tokens and the price of them.
 * Keeps `costUsd` conservative via `dearest` fallback for run budgets while reporting `pricedCostUsd` and `costState` strictly from `MODEL_PRICES`.
 */
export async function threadUsage(
  bb: BbPluginApi,
  threadId: string,
  options: { since?: number; until?: number; fallbackModel?: string; fallbackProvider?: string } = {},
): Promise<ThreadUsage> {
  const since = options.since ?? 0;
  let events: unknown[];
  try { events = await listThreadEvents(bb, threadId, 0); } catch { return { tokens: 0, costUsd: 0, known: false, unknown: true }; }
  if (!events.some((event) => eventType(event) === "thread/tokenUsage/updated" && usageFromEvent(event))) return { tokens: 0, costUsd: 0, known: false, unknown: true };
  const dearest = Object.keys(MODEL_PRICES).reduce((top, key) => (MODEL_PRICES[key]!.output > MODEL_PRICES[top]!.output ? key : top));
  let model = options.fallbackModel ?? "";
  let providerId = options.fallbackProvider ?? "";
  let requestedModel: string | null = options.fallbackModel ?? null;
  let requestedProvider: string | null = options.fallbackProvider ?? null;
  let answeredModel: string | null = options.fallbackModel ?? null;
  let answeredProvider: string | null = options.fallbackProvider ?? null;
  let lastRequestId: string | null = null;
  let prev = { last: { ...ZERO }, total: { ...ZERO }, turnId: "" };
  let tokens = 0, cost = 0, pricedCost = 0, measuredTurns = 0, unmeasuredTurns = 0;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  for (const event of events) {
    const type = eventType(event);
    const at = eventCreatedAt(event);
    const inWindow = at === null || (at >= since && (options.until === undefined || at < options.until));
    if (type === "client/turn/requested" || type === "client/thread/start" || type === "client/turn/start") {
      model = turnModel(event) ?? model;
      providerId = turnProvider(event, providerId);
      if (inWindow || !requestedModel) requestedModel = model || requestedModel;
      if (inWindow || !requestedProvider) requestedProvider = providerId || requestedProvider;
      if (model) answeredModel = model;
      if (providerId) answeredProvider = providerId;
      continue;
    }
    if (type === "provider/modelFallback") {
      const bag = eventBag(event);
      const origModel = stringAt(bag, "originalModel") ?? stringAt(event, "originalModel");
      const origProvider = stringAt(bag, "originalProvider") ?? stringAt(event, "originalProvider");
      if (origModel) requestedModel = origModel;
      else if (!requestedModel && model) requestedModel = model;
      if (origProvider) requestedProvider = origProvider;
      else if (!requestedProvider && providerId) requestedProvider = providerId;
      model = turnModel(event) ?? model;
      providerId = turnProvider(event, providerId);
      if (model) answeredModel = model;
      if (providerId) answeredProvider = providerId;
      continue;
    }
    if (type !== "thread/tokenUsage/updated") continue;
    const usage = usageFromEvent(event);
    if (!usage) continue;
    const turnId = usageTurnId(event);
    const delta = tokenDelta(usage, prev, turnId);
    prev = { last: usage.last, total: usage.total, turnId };
    if (!inWindow) continue;
    const bag = eventBag(event);
    const evModel = stringAt(bag, "model") ?? stringAt(bag, "modelId") ?? stringAt(bag, "modelID");
    const evProvider = stringAt(bag, "providerId") ?? stringAt(bag, "providerID");
    const activeModel = evModel ?? model;
    const activeProvider = evProvider ?? providerId;
    if (activeModel) answeredModel = activeModel;
    if (activeProvider) answeredProvider = activeProvider;
    const reqId = stringAt(bag, "requestId") ?? stringAt(bag, "responseId") ?? (turnId || null);
    if (reqId) lastRequestId = reqId;
    const billed = billedFrom(delta);
    tokens += billed.total;
    inputTokens += billed.uncached;
    outputTokens += billed.output;
    cacheReadTokens += billed.cacheRead;
    cacheWriteTokens += billed.cacheWrite;
    const turnPriced = activeModel ? costUsd(activeModel, billed) : null;
    if (turnPriced !== null) {
      pricedCost += turnPriced;
      measuredTurns += 1;
    } else {
      unmeasuredTurns += 1;
    }
    cost += turnPriced ?? costUsd(dearest, billed) ?? 0;
  }
  const costState: CostState = unmeasuredTurns === 0
    ? "measured"
    : measuredTurns > 0
      ? "partial"
      : "not_measured";
  const last = prev.last;
  return {
    tokens,
    costUsd: cost,
    known: true,
    parts: { input: last.input, output: last.output, cached: last.cached, total: last.total },
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    requestedProvider,
    requestedModel,
    answeredProvider,
    answeredModel,
    costState,
    pricedCostUsd: costState === "not_measured" ? null : pricedCost,
    requestId: lastRequestId,
  };
}
