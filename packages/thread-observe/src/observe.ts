import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { decideThreadCompletion, THREAD_WATCH_EVENT_TYPES } from "./completion";

function stringAt(value: unknown, key: string): string | null {
  const found = value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  return typeof found === "string" && found.length > 0 ? found : null;
}

function sanitizeEventsListError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/\s+/g, " ").slice(0, 240);
}

export function eventsListQueryLabel(query: Record<string, unknown>): string {
  const types = Array.isArray(query.types) ? query.types.join(",") : "";
  return `threadId=${String(query.threadId ?? "")};types=${types || "all"};order=${String(query.order ?? "")};limit=${String(query.limit ?? "")}`;
}

export type ThreadEventsQuery = { threadId:string; types?: typeof THREAD_WATCH_EVENT_TYPES; order:"desc"; limit:"50" };

export async function listThreadEventsRaw(
  bb: BbPluginApi,
  query: ThreadEventsQuery,
): Promise<{ ok:true; events:unknown[] } | { ok:false; kind:"error"|"invalid"; detail:string }> {
  try {
    const listed = await bb.sdk.threads.events.list(query);
    if (!Array.isArray(listed)) {
      return { ok:false, kind:"invalid", detail:`events_list_invalid:${eventsListQueryLabel(query)};result=${listed === null ? "null" : typeof listed}` };
    }
    return { ok:true, events:listed };
  } catch (cause) {
    return { ok:false, kind:"error", detail:`events_list_error:${eventsListQueryLabel(query)};error=${sanitizeEventsListError(cause)}` };
  }
}

/**
 * Whether a turn of the thread is held in the queue by a plugin's dispatch hook (BB's concurrency-limit: «N of N running
 * on host»). Such a turn is waiting its turn, not a provider that never started, so the start limit of `threadFailure` does
 * not apply to it. False when nothing is held, the queue cannot be read or no such plugin exists.
 */
export async function turnHeldByPlugin(bb: BbPluginApi, threadId: string): Promise<boolean> {
  try {
    const rows = await bb.sdk.threads.queue.list({ threadId });
    return (Array.isArray(rows) ? rows : []).some((row) => row.waitingOn?.kind === "plugin");
  } catch {
    return false;
  }
}

/** A failure that is only the start limit, while the turn waits in a plugin's queue, is no failure. */
export async function startLimitWaiting(bb: BbPluginApi, threadId: string, failure: string | null): Promise<boolean> {
  return Boolean(failure && failure.startsWith("provider_not_started") && await turnHeldByPlugin(bb, threadId));
}

/**
 * Waits for a child thread's turn with no overall deadline: BB's events say when it failed (see
 * threadFailure), so a slow but working model is never cut off. `probeMs` bounds a diagnostic probe only.
 */
export async function waitThreadIdle(bb: BbPluginApi, threadId: string, timeoutMessage: string, probeMs?: number, requestedAfter?: number): Promise<void> {
  let lastDetail = "status=unknown;queuedWork=unknown;started_seq=none;turn=none";
  const deadline = probeMs === undefined ? Infinity : Date.now() + probeMs;
  while (Date.now() < deadline) {
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const listed = await listThreadEventsRaw(bb, {
      threadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50",
    });
    if (!listed.ok) throw new Error(`${timeoutMessage}:${listed.detail}`);
    const decision = decideThreadCompletion({
      threadId,
      status:stringAt(thread, "status"),
      queuedWork:stringAt(thread, "queuedWork"),
      events:listed.events,
      requestedAfter,
    });
    if (decision.ok) return;
    if ((decision.via === "error" || decision.via === "canceled") && !(decision.via === "error" && await startLimitWaiting(bb, threadId, decision.detail))) {
      throw new Error(`${timeoutMessage}:${decision.via}:${decision.detail}`);
    }
    lastDetail = decision.detail;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${timeoutMessage}:incomplete:${lastDetail}`);
}

export type StageChildObservation =
  | { kind:"completed" }
  | { kind:"product_failure"; via:string; detail:string }
  | { kind:"observing"; detail:string };

export async function observeStageChild(
  bb: BbPluginApi,
  threadId: string,
  timeoutMs: number,
): Promise<StageChildObservation> {
  let lastDetail = "status=unknown;queuedWork=unknown;started_seq=none;turn=none";
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const listed = await listThreadEventsRaw(bb, {
      threadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50",
    });
    if (!listed.ok) return { kind:"observing", detail:listed.detail };
    const decision = decideThreadCompletion({
      threadId,
      status:stringAt(thread, "status"),
      queuedWork:stringAt(thread, "queuedWork"),
      events:listed.events,
    });
    if (decision.ok) return { kind:"completed" };
    if ((decision.via === "error" || decision.via === "canceled") && !(decision.via === "error" && await startLimitWaiting(bb, threadId, decision.detail))) {
      return { kind:"product_failure", via:decision.via, detail:decision.detail };
    }
    lastDetail = decision.detail;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { kind:"observing", detail:lastDetail };
}
