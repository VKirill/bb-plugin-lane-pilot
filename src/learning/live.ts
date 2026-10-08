import { TURN_REQUESTED, ownerMessagesOf, isOwnerThread, type EventLike, type OwnerMessage, type OwnerMessageHub, type ThreadLike } from "../anamnesis/owner-messages";

/**
 * The live feed of the owner's messages into the shared hub (T1). BB announces `thread.active` when a thread starts a turn (which is
 * what a message from the owner does) and `experimental_thread.events`, debounced to once a second per thread, while it runs. Neither
 * carries the message, so the feed reads the thread's newest `client/turn/requested` events when it hears one, keeps for each thread the
 * last sequence it has delivered, and passes the new ones through `ownerMessagesOf`, the one filter of the collector (a person's
 * message, a visible top-level thread, not a plugin's, not a fork's copied history).
 *
 * Cost: one small read of five events, at most once per `THROTTLE_MS` for a thread; a thread of a writer, helper or stage is dropped
 * before any read. A thread seen for the first time is read for messages of the last `FIRST_LOOK_MS` only, so a reload does not replay
 * history. The messages already seen are remembered by the room's own table, so a message delivered twice is judged once.
 */
export const THROTTLE_MS = 3_000;
export const FIRST_LOOK_MS = 5 * 60_000;
const READ_EVENTS = 5;
const MAX_TRACKED = 5_000;

export type LiveDeps = {
  hub: Pick<OwnerMessageHub, "deliver">;
  /** The newest `client/turn/requested` events of a thread, newest first. */
  readEvents(threadId: string, limit: number): Promise<EventLike[]>;
  now?(): number;
  log?(line: string): void;
};

export function createLiveFeed(deps: LiveDeps) {
  const now = deps.now ?? Date.now;
  const lastSeq = new Map<string, number>();
  const lastRead = new Map<string, number>();
  const pending = new Set<string>();

  async function pull(thread: ThreadLike): Promise<OwnerMessage[]> {
    const events = await deps.readEvents(thread.id, READ_EVENTS);
    const first = !lastSeq.has(thread.id);
    const known = lastSeq.get(thread.id) ?? 0;
    const fresh = events.filter((event) => event.type === TURN_REQUESTED && event.seq > known && (!first || event.createdAt >= now() - FIRST_LOOK_MS));
    if (events.length) lastSeq.set(thread.id, Math.max(known, ...events.map((event) => event.seq)));
    if (lastSeq.size > MAX_TRACKED) for (const key of [...lastSeq.keys()].slice(0, MAX_TRACKED / 2)) { lastSeq.delete(key); lastRead.delete(key); }
    return fresh.sort((a, b) => a.seq - b.seq).flatMap((event) => ownerMessagesOf(event, thread));
  }

  /** A thread event: true when it led to a read. */
  async function heard(thread: ThreadLike | null | undefined, options: { force?: boolean } = {}): Promise<boolean> {
    if (!thread?.id || !isOwnerThread(thread) || pending.has(thread.id)) return false;
    const at = now();
    if (!options.force && at - (lastRead.get(thread.id) ?? 0) < THROTTLE_MS) return false;
    lastRead.set(thread.id, at);
    pending.add(thread.id);
    try {
      const batch = await pull(thread);
      if (batch.length) await deps.hub.deliver(batch, { live: true });
      return true;
    } catch (cause) {
      deps.log?.(`learning: live read of ${thread.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    } finally { pending.delete(thread.id); }
  }

  return { heard, tracked: () => lastSeq.size };
}
export type LiveFeed = ReturnType<typeof createLiveFeed>;
