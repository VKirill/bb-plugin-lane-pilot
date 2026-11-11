import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { decideThreadCompletion, retryRun, threadFailure, THREAD_WATCH_EVENT_TYPES } from "./completion";
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

/** BB serves at most this many thread events per request (THREAD_EVENT_LIST_PAGE_SIZE of the core's server contract): a larger `limit` is refused with 400 «Thread event limit cannot exceed 100». */
export const THREAD_EVENTS_PAGE = 100;

/** What a session did, without the stream around it: on live writer threads the typed-out deltas, the context counters and
 * the service events are 75-85 % of the events (measured 2026-11-11), and a reader of `data.item` uses none of them. */
export const THREAD_ITEM_EVENT_TYPES = ["item/started", "item/completed"] as const;

export type ThreadEventsQuery = { threadId:string; types?: readonly string[]; order:"asc" | "desc"; limit:string; beforeSeq?:string; afterSeq?:string };

/**
 * `bb.sdk.threads.events.list` for any `limit`: more than one page is read page by page along the sequence numbers
 * (newest first: below the oldest seen; oldest first: above the newest seen) until `limit` events or a short page.
 * Answers and throws as the SDK call does; a later page that fails keeps the pages already read.
 */
export async function listThreadEventsPaged(bb: BbPluginApi, query: ThreadEventsQuery): Promise<unknown> {
  const want = Math.max(1, Math.floor(Number(query.limit)) || THREAD_EVENTS_PAGE);
  const list = (page: Partial<ThreadEventsQuery>): Promise<unknown> => bb.sdk.threads.events.list({ ...query, ...page } as never) as Promise<unknown>;
  const first = await list({ limit:String(Math.min(want, THREAD_EVENTS_PAGE)) });
  if (!Array.isArray(first) || want <= THREAD_EVENTS_PAGE) return first;
  const out: unknown[] = [...first];
  let page: unknown[] = first;
  while (out.length < want && page.length >= THREAD_EVENTS_PAGE) {
    const seqs = page.map((event) => Number((event as { seq?: unknown } | null)?.seq)).filter(Number.isFinite);
    if (seqs.length === 0) break;
    const cursor = query.order === "asc" ? { afterSeq:String(Math.max(...seqs)) } : { beforeSeq:String(Math.min(...seqs)) };
    const next = await list({ ...cursor, limit:String(Math.min(want - out.length, THREAD_EVENTS_PAGE)) }).catch(() => null);
    if (!Array.isArray(next) || next.length === 0) break;
    out.push(...next);
    page = next;
  }
  return out;
}

export async function listThreadEventsRaw(
  bb: BbPluginApi,
  query: ThreadEventsQuery,
): Promise<{ ok:true; events:unknown[] } | { ok:false; kind:"error"|"invalid"; detail:string }> {
  try {
    const listed = await listThreadEventsPaged(bb, query);
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

/** The newest event of the thread, of any type: what a run of retry notices is compared with before the wait gives up on it. */
async function newestSeq(bb: BbPluginApi, threadId: string): Promise<number | null> {
  const listed = await listThreadEventsRaw(bb, { threadId, order:"desc", limit:"1" });
  if (!listed.ok) return null;
  const seqs = listed.events.map((event) => (event && typeof event === "object" ? Reflect.get(event, "seq") : null)).filter((seq): seq is number => typeof seq === "number");
  return seqs.length ? Math.max(...seqs) : null;
}

/**
 * Waits for a child thread's turn with no overall deadline: BB's events say when it failed (see
 * threadFailure), so a slow but working model is never cut off. `probeMs` bounds a diagnostic probe only.
 * `givesUpOn`: a caller that has another model to go to names the retry notices it does not wait out (a provider limit).
 * When such notices are all the thread has said for a while (retryRun) and nothing came after the last one, the thread is
 * stopped and the wait fails with the notice as a provider error; without it retries are never cut short.
 */
export async function waitThreadIdle(bb: BbPluginApi, threadId: string, timeoutMessage: string, probeMs?: number, requestedAfter?: number, shouldStop?: () => string | null, givesUpOn?: (notice: string) => boolean): Promise<void> {
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
    const stuck = givesUpOn ? retryRun(listed.events) : null;
    if (stuck && givesUpOn!(stuck.notice) && await newestSeq(bb, threadId) === stuck.lastSeq) {
      const cause = `provider_error:${stuck.notice}`;
      // Left running it would retry for many minutes more and might then do the work a second time, beside the caller's next model.
      await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      try { failureListeners.get(bb)?.(threadId, cause); } catch { /* a listener never fails the wait */ }
      throw new Error(`${timeoutMessage}:error:${cause}`);
    }
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
