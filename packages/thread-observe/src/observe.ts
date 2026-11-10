import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { decideThreadCompletion, threadFailure, THREAD_WATCH_EVENT_TYPES } from "./completion";
import { sleepUntilThreadSignal, threadWatchMark } from "./signals";

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

/** Who hears that a waited thread failed (the plugin's provider-limit memory); one per plugin instance. */
const failureListeners = new WeakMap<object, (threadId: string, detail: string) => void>();
export function onThreadFailure(bb: object, listener: (threadId: string, detail: string) => void): void { failureListeners.set(bb, listener); }

/** A failure that is only the start limit, while the turn waits in a plugin's queue, is no failure. */
export async function startLimitWaiting(bb: BbPluginApi, threadId: string, failure: string | null): Promise<boolean> {
  return Boolean(failure && failure.startsWith("provider_not_started") && await turnHeldByPlugin(bb, threadId));
}

/**
 * Waits for a child thread's turn with no overall deadline: BB's events say when it failed (see
 * threadFailure), so a slow but working model is never cut off. `probeMs` bounds a diagnostic probe only.
 */
export async function waitThreadIdle(bb: BbPluginApi, threadId: string, timeoutMessage: string, probeMs?: number, requestedAfter?: number, shouldStop?: () => string | null): Promise<void> {
  let lastDetail = "status=unknown;queuedWork=unknown;started_seq=none;turn=none";
  let lastEvents: unknown[] = [];
  const deadline = probeMs === undefined ? Infinity : Date.now() + probeMs;
  while (Date.now() < deadline) {
    // The caller knows something BB's thread events do not (the queued instruction was deleted): it ends the wait.
    const stop = shouldStop?.();
    if (stop) throw new Error(`${timeoutMessage}:${stop}`);
    // BB's events say when to look again; the mark is taken before the read so a change during it is not missed.
    const mark = threadWatchMark(bb);
    // an unreadable thread just yields no fresh status this poll
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const listed = await listThreadEventsRaw(bb, {
      threadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50",
    });
    if (!listed.ok) throw new Error(`${timeoutMessage}:${listed.detail}`);
    lastEvents = listed.events;
    const decision = decideThreadCompletion({
      threadId,
      status:stringAt(thread, "status"),
      queuedWork:stringAt(thread, "queuedWork"),
      events:listed.events,
      requestedAfter,
    });
    if (decision.ok) return;
    if ((decision.via === "error" || decision.via === "canceled") && !(decision.via === "error" && await startLimitWaiting(bb, threadId, decision.detail))) {
      if (decision.via === "error") { try { failureListeners.get(bb)?.(threadId, decision.detail); } catch { /* a listener never fails the wait */ } }
      throw new Error(`${timeoutMessage}:${decision.via}:${decision.detail}`);
    }
    lastDetail = decision.detail;
    await sleepUntilThreadSignal(bb, threadId, mark, 1000, undefined, { deadlineAt: deadline, ...(shouldStop ? { maxMs: 1000 } : {}) });
  }
  // Retries remain nonterminal while waiting. At the caller's deadline their cause must survive for its fallback.
  const stop = shouldStop?.();
  if (stop) throw new Error(`${timeoutMessage}:${stop}`);
  // This final diagnostic read gets at most one poll interval; an unavailable core cannot hold a finished wait open.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listed = await Promise.race([
    listThreadEventsRaw(bb, { threadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50" }),
    new Promise<{ ok:true; events:unknown[] }>((resolve) => { timer = setTimeout(() => resolve({ ok:true, events:lastEvents }), 1000); }),
  ]).finally(() => clearTimeout(timer));
  if (!listed.ok) throw new Error(`${timeoutMessage}:${listed.detail}`);
  const stopped = shouldStop?.();
  if (stopped) throw new Error(`${timeoutMessage}:${stopped}`);
  const cause = threadFailure(listed.events, Date.now(), { includeRetrying: true, requestedAfter });
  if (cause && !(await startLimitWaiting(bb, threadId, cause))) {
    try { failureListeners.get(bb)?.(threadId, cause); } catch { /* a listener never fails the wait */ }
    throw new Error(`${timeoutMessage}:error:${cause}`);
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
    const mark = threadWatchMark(bb);
    // an unreadable thread just yields no fresh status this poll
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
    await sleepUntilThreadSignal(bb, threadId, mark, 1000, undefined, { deadlineAt: deadline });
  }
  return { kind:"observing", detail:lastDetail };
}
