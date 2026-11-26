import { LP_EVENTS } from "@lane-pilot/contracts";
import { THREAD_EVENTS_PAGE } from "@lane-pilot/thread-observe";
import type { ServerCore } from "../../../contracts/server";

/**
 * The thread event feed both stability watches share (0.1.575): `experimental_thread.events` is only a debounced
 * wake ({thread, sequence} — the payload carries no event), so each notification makes the feed read the thread's
 * event log for what arrived since the last read (`threads.events.list`, seq-ordered). One subscription per plugin
 * host, one read in flight per thread; a wake during a read re-reads instead of being dropped, and a failed read
 * keeps the old cursor so the next wake retries it. First contact with a thread reads only events created after the
 * feed started — history is never replayed into outcomes the watch did not see happen.
 */

export type FeedEvent = { seq: number; type: string; createdAt: number | null; data: unknown };
export type FeedConsumer = { types: ReadonlySet<string>; handle: (threadId: string, events: FeedEvent[]) => void | Promise<void> };
export type ThreadEventEmitter = (
  name: string,
  payload: Record<string, unknown>,
  options?: { id?: string; key?: string; attemptKey?: string; projectId?: string },
) => Promise<unknown> | unknown;

/** First contact pages back at most this far while events are still younger than the feed. */
const FIRST_CONTACT_PAGES = 4;
/** One wake drains at most this many pages of backlog; a longer backlog continues on the next pass. */
const MAX_PAGES_PER_WAKE = 10;

type ThreadCursor = { lastSeq: number | null; headSeq: number; busy: boolean; again: boolean; lastWake: number };

const feeds = new WeakMap<object, { add(consumer: FeedConsumer): void; setEmitter(emit?: ThreadEventEmitter): void }>();

function readFeedEvent(row: unknown): { seq: number; type: string; createdAt: number | null; data: unknown } | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const seq = Number(record.seq);
  const type = record.type;
  if (!Number.isFinite(seq) || typeof type !== "string" || !type) return null;
  const createdAt = Number(record.createdAt);
  return { seq, type, createdAt: Number.isFinite(createdAt) ? createdAt : null, data: record.data };
}

export function installThreadEventFeed(ctx: ServerCore, options?: { emitEvent?: ThreadEventEmitter }): { add(consumer: FeedConsumer): void } {
  const bb = ctx.bb as unknown as {
    events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void };
    sdk?: { threads?: { events?: { list?: (query: Record<string, unknown>) => Promise<unknown> } } };
  };
  const existing = feeds.get(bb as object);
  if (existing) {
    if (options?.emitEvent) existing.setEmitter(options.emitEvent);
    return existing;
  }
  const events = bb.events;
  const list = bb.sdk?.threads?.events?.list;
  const feed = { add: (_consumer: FeedConsumer) => undefined as void, setEmitter: () => undefined as void };
  if (!events || typeof events.on !== "function" || typeof list !== "function") {
    feeds.set(bb as object, feed);
    return feed;
  }
  let emitEvent = options?.emitEvent;

  const bootAt = Date.now();
  const consumers = new Set<FeedConsumer>();
  const cursors = new Map<string, ThreadCursor>();
  const log = (line: string) => { try { (ctx.bb as { log?: { info?: (line: string) => void } }).log?.info?.(line); } catch { /* logging must not break the feed */ } };

  const queryTypes = () => [...new Set([...consumers].flatMap((consumer) => [...consumer.types]))];

  const listPage = (threadId: string, query: Record<string, unknown>) =>
    (list as (q: Record<string, unknown>) => Promise<unknown>)({ threadId, limit: String(THREAD_EVENTS_PAGE), ...query }).catch(() => null);

  /** The events a first-contact thread may claim: newest pages back while they are younger than the feed. */
  async function firstContact(threadId: string): Promise<{ events: FeedEvent[]; maxSeq: number; backlogSkipped: boolean } | null> {
    const fresh: FeedEvent[] = [];
    let maxSeq = 0;
    let beforeSeq: string | undefined;
    let backlogSkipped = false;
    for (let page = 0; page < FIRST_CONTACT_PAGES; page++) {
      const rows = await listPage(threadId, { order: "desc", types: queryTypes(), ...(beforeSeq ? { beforeSeq } : {}) });
      // Any failed page means the fresh set is incomplete and older fresh rows sit below it: deliver nothing and keep the
      // cursor unset, so the next wake reads the whole first contact again instead of skipping what was not reached.
      if (!Array.isArray(rows)) return null;
      const events = rows.map(readFeedEvent).filter((event): event is NonNullable<typeof event> => event !== null);
      const rowSeqs = rows.map((row) => Number((row as { seq?: unknown })?.seq)).filter(Number.isFinite);
      if (rowSeqs.length) maxSeq = Math.max(maxSeq, ...rowSeqs);
      if (!events.length) break;
      let reachedHistory = false;
      for (const event of events) {
        if (event.createdAt === null || event.createdAt < bootAt) { reachedHistory = true; break; }
        fresh.push(event);
      }
      // A full page that never reached history means older fresh events may sit below the cap: they are skipped on
      // purpose (bounded read) and the skip is logged, never claimed as covered.
      backlogSkipped = !reachedHistory && rows.length >= THREAD_EVENTS_PAGE;
      if (reachedHistory || rows.length < THREAD_EVENTS_PAGE) break;
      beforeSeq = String(Math.min(...rowSeqs));
    }
    return { events: fresh.reverse(), maxSeq, backlogSkipped };
  }

  /** Events after the cursor, draining up to MAX_PAGES_PER_WAKE pages; a longer backlog asks for another pass. */
  async function sinceCursor(threadId: string, cursor: ThreadCursor): Promise<{ events: FeedEvent[]; maxSeq: number; truncated: boolean } | null> {
    const events: FeedEvent[] = [];
    let afterSeq = cursor.lastSeq as number;
    let maxSeq = afterSeq;
    for (let page = 0; page < MAX_PAGES_PER_WAKE; page++) {
      const rows = await listPage(threadId, { order: "asc", types: queryTypes(), afterSeq: String(afterSeq) });
      if (!Array.isArray(rows)) return events.length || maxSeq > (cursor.lastSeq as number) ? { events, maxSeq, truncated: false } : null;
      const parsed = rows.map(readFeedEvent).filter((event): event is NonNullable<typeof event> => event !== null);
      events.push(...parsed);
      const rowSeqs = rows.map((row) => Number((row as { seq?: unknown })?.seq)).filter(Number.isFinite);
      // An empty or unplaceable page is the end of the log, not a truncated backlog: reporting `truncated` here would
      // re-read the same empty page forever (0.1.575: a wake after a quiet turn spun the worker at 100%).
      if (!rowSeqs.length) return { events, maxSeq, truncated: false };
      afterSeq = Math.max(afterSeq, ...rowSeqs);
      maxSeq = afterSeq;
      if (rows.length < THREAD_EVENTS_PAGE) return { events, maxSeq, truncated: false };
    }
    return { events, maxSeq, truncated: true };
  }

  async function readOnce(threadId: string, headSeq: number, cursor: ThreadCursor): Promise<void> {
    if (!consumers.size || ctx.isDisposed()) { cursor.lastSeq = headSeq; return; }
    let events: FeedEvent[];
    if (cursor.lastSeq === null) {
      const first = await firstContact(threadId);
      if (first === null) return;
      events = first.events;
      // The cursor covers every row the read saw — including rows newer than the notification's sequence — so the
      // next wake never redelivers them; a capped backlog is logged, not claimed as covered.
      cursor.lastSeq = Math.max(headSeq, first.maxSeq);
      if (first.backlogSkipped) log(`Lane Pilot thread event feed skipped backlog older than ${FIRST_CONTACT_PAGES * THREAD_EVENTS_PAGE} events for ${threadId}`);
    } else {
      const batch = await sinceCursor(threadId, cursor);
      if (batch === null) return;
      events = batch.events;
      cursor.lastSeq = Math.max(cursor.lastSeq, batch.maxSeq);
      if (batch.truncated) cursor.again = true;
    }
    // Inactivity is measured from real traffic only: a notification (pump's wake flag) or rows the log actually gave.
    // A sweep's empty re-read must not keep a silent thread alive forever (0.1.575: it refreshed lastWake every pass).
    if (events.length) cursor.lastWake = Date.now();
    for (const consumer of [...consumers]) {
      const mine = events.filter((event) => consumer.types.has(event.type));
      if (!mine.length) continue;
      await Promise.resolve().then(() => consumer.handle(threadId, mine)).catch((cause: unknown) => log(`Lane Pilot thread event feed handler failed for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
  }

  async function pump(threadId: string, headSeq: number, wake = false): Promise<void> {
    let cursor = cursors.get(threadId);
    if (!cursor) { cursor = { lastSeq: null, headSeq: 0, busy: false, again: false, lastWake: 0 }; cursors.set(threadId, cursor); }
    cursor.headSeq = Math.max(cursor.headSeq, headSeq);
    if (wake) cursor.lastWake = Date.now();
    if (cursor.busy) { cursor.again = true; return; }
    cursor.busy = true;
    try {
      do {
        cursor.again = false;
        await readOnce(threadId, headSeq, cursor);
      } while (cursor.again && !ctx.isDisposed());
    } finally {
      cursor.busy = false;
    }
  }

  const realAdd = (consumer: FeedConsumer) => { consumers.add(consumer); };
  const api = { add: realAdd, setEmitter: (next?: ThreadEventEmitter) => { if (next) emitEvent = next; } };
  feeds.set(bb as object, api);

  // Missed-wake recovery, bounded to threads the feed has actually seen (the signal hub's fallback idea, applied to
  // the log cursor): a slow sweep re-reads each live cursor's tail — cheap empty reads when nothing was missed — and
  // forgets threads silent for a day so the map cannot grow without bound. A cursor whose first read failed
  // (lastSeq still null) is swept too: its bounded first contact simply retries. No all-thread polling.
  const SWEEP_MS = 60_000;
  const CURSOR_IDLE_MS = 86_400_000;
  const sweep = setInterval(() => {
    if (ctx.isDisposed()) return;
    const now = Date.now();
    for (const [threadId, cursor] of [...cursors]) {
      if (now - cursor.lastWake > CURSOR_IDLE_MS) { cursors.delete(threadId); continue; }
      if (!cursor.busy) void pump(threadId, cursor.headSeq).catch((cause: unknown) => log(`Lane Pilot thread event feed sweep failed for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
  }, SWEEP_MS);
  sweep.unref?.();
  (bb as unknown as { onDispose?: (fn: () => void) => void }).onDispose?.(() => { clearInterval(sweep); cursors.clear(); });

  try {
    events.on!("experimental_thread.events", (payload: unknown) => {
      if (ctx.isDisposed()) return;
      const thread = (payload as { thread?: { id?: unknown } } | null)?.thread;
      const sequence = Number((payload as { sequence?: unknown } | null)?.sequence);
      const threadId = thread && typeof thread === "object" ? (thread as { id?: unknown }).id : null;
      if (typeof threadId !== "string" || !threadId || !Number.isFinite(sequence)) return;
      return pump(threadId, sequence, true);
    });
  } catch (cause) {
    log(`Lane Pilot thread event feed does not listen: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    events.on!("thread.idle", (payload: unknown) => {
      if (ctx.isDisposed() || !emitEvent) return;
      const lastTurn = (payload as { experimental_vkLastTurn?: { isSubAgent?: unknown; turnId?: unknown } } | null)?.experimental_vkLastTurn;
      if (lastTurn && typeof lastTurn === "object" && lastTurn.isSubAgent === true) return;
      const thread = (payload as { thread?: { id?: unknown; projectId?: unknown } } | null)?.thread;
      const threadId = thread && typeof thread === "object" && typeof thread.id === "string" && thread.id ? thread.id : null;
      if (!threadId) return;
      const projectId = typeof thread?.projectId === "string" && thread.projectId ? thread.projectId : undefined;
      const turnId = lastTurn && typeof lastTurn === "object" && typeof lastTurn.turnId === "string" && lastTurn.turnId ? lastTurn.turnId : undefined;
      const lastAssistantText = (payload as { lastAssistantText?: unknown } | null)?.lastAssistantText;
      return Promise.resolve(emitEvent(LP_EVENTS.THREAD_IDLE, {
        ...(turnId ? { eventId: `${LP_EVENTS.THREAD_IDLE}:${threadId}:${turnId}` } : {}),
        eventKey: threadId,
        threadId,
        ...(projectId ? { projectId } : {}),
        ...(typeof lastAssistantText === "string" || lastAssistantText === null ? { lastAssistantText } : {}),
      })).catch((cause: unknown) => log(`Lane Pilot thread event feed emit failed for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`));
    });
  } catch (cause) {
    log(`Lane Pilot thread event feed does not listen to thread.idle: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return api;
}
