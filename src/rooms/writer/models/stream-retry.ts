import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";

/** Same cap as BB provider-retry, but only for stream/transport drops. */
export const MAX_STREAM_RETRY_ATTEMPTS = 3;
export const STREAM_RETRY_DELAY_MS = 3_000;

const RETRY_CATEGORIES = new Set(["stream-disconnected", "connection-failed"]);
const PROVIDER_RETRY_CATEGORIES = new Set(["rate-limit", "overloaded"]);

export type StreamRetryDecision =
  | { kind: "retry"; delayMs: number }
  | { kind: "decline"; reason: string };

export function looksLikeDroppedStream(detail: string): boolean {
  return /RetriableError|http\/2|stream closed|CANCEL \(0x8\)|ECONNRESET|UND_ERR|socket hang up/i.test(detail);
}

export function droppedStreamDetail(events: readonly unknown[]): string | null {
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const type = Reflect.get(event, "type");
    if (type !== "provider/error" && type !== "system/error") continue;
    const data = Reflect.get(event, "data");
    if (!data || typeof data !== "object") continue;
    for (const key of ["message", "detail"]) {
      const value = Reflect.get(data, key);
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

export function streamRetryDecision(failure: Pick<PluginTurnFailedEvent, "attemptNumber" | "errorInfo"> & { detail?: string | null }): StreamRetryDecision {
  if (failure.attemptNumber >= MAX_STREAM_RETRY_ATTEMPTS) return { kind: "decline", reason: "attempts-exhausted" };
  const category = failure.errorInfo?.category;
  if (category && PROVIDER_RETRY_CATEGORIES.has(category)) return { kind: "decline", reason: "provider-retry-owns" };
  if (category && RETRY_CATEGORIES.has(category)) return { kind: "retry", delayMs: STREAM_RETRY_DELAY_MS };
  if (failure.detail && looksLikeDroppedStream(failure.detail)) return { kind: "retry", delayMs: STREAM_RETRY_DELAY_MS };
  return { kind: "decline", reason: "not-retryable" };
}

