import type { CostState } from "@lane-pilot/contracts";
import { stringAt, valueAt } from "@lane-pilot/kit";
import { tokenBreakdown, type TokenBreakdown } from "./token-math";

export const TOKEN_USAGE_EVENT_TYPES = [
  "thread/tokenUsage/updated",
  "client/turn/requested",
  "client/thread/start",
  "provider/modelFallback",
] as const;
export const EVENT_PAGE = 100;

export function eventBag(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== "object") return {};
  const data = valueAt(event, "data");
  return data && typeof data === "object" ? data as Record<string, unknown> : event as Record<string, unknown>;
}

export function eventSeq(event: unknown): number {
  const seq = valueAt(event, "seq") ?? valueAt(eventBag(event), "seq");
  if (typeof seq === "number" && Number.isFinite(seq)) return seq;
  if (typeof seq === "string" && /^\d+$/.test(seq)) return Number(seq);
  return 0;
}

export function listingError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/\s+/g, " ").slice(0, 240);
}

export function eventCreatedAt(event: unknown): number | null {
  const at = valueAt(event, "createdAt") ?? valueAt(eventBag(event), "createdAt");
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

export function eventType(event: unknown): string {
  return stringAt(event, "type") ?? stringAt(eventBag(event), "type") ?? "";
}

export function turnModel(event: unknown): string | null {
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

export function turnProvider(event: unknown, fallback: string): string {
  const bag = eventBag(event);
  const request = valueAt(bag, "request");
  const params = request && typeof request === "object" ? valueAt(request, "params") : undefined;
  const execution = valueAt(bag, "execution") ?? valueAt(params ?? {}, "execution") ?? valueAt(params ?? {}, "options");
  return stringAt(execution, "providerId") ?? stringAt(params ?? {}, "providerId") ?? fallback;
}

export function usageTurnId(event: unknown): string {
  const bag = eventBag(event);
  return stringAt(bag, "turnId") ?? stringAt(event, "turnId") ?? "";
}

export function usageFromEvent(event: unknown): { last: TokenBreakdown; total: TokenBreakdown } | null {
  const bag = eventBag(event);
  const usage = valueAt(bag, "tokenUsage") ?? valueAt(event, "tokenUsage");
  if (!usage || typeof usage !== "object") return null;
  return { last: tokenBreakdown(valueAt(usage, "last")), total: tokenBreakdown(valueAt(usage, "total")) };
}

/** What a thread spent. `unknown` is set when BB shows no usage for it at all: the 0 is then "not reported", not "free". */
export type ThreadUsage = {
  tokens: number;
  costUsd: number;
  known: boolean;
  unknown?: true;
  /** The last usage event's four numbers (input, output, cached, total), for providers that report a breakdown (SMA m_tl_codex_lane). */
  parts?: { input: number; output: number; cached: number; total: number };
  /** Aggregated window breakdown (uncached input only; cache reads separate) and model provenance. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  answeredProvider?: string | null;
  answeredModel?: string | null;
  costState?: CostState;
  pricedCostUsd?: number | null;
  requestId?: string | null;
};
