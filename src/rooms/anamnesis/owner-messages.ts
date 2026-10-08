import type { Evidence } from "./model";

/**
 * The one collector of the owner's own messages (A2), ported from the retired memory-profile plugin and shared by both learning
 * layers: anamnesis (who the owner is) and the learning-from-dialogues work (T1: what the owner corrected). It reads original
 * human requests only. Provider transcripts carry injected context, so the source is the `client/turn/requested` event, kept
 * when a person made it (initiator `user`, no sender thread, no system label, no retry), in a thread that is visible, a top-level
 * one, not made by a plugin and not deleted. Archived threads count. A fork keeps the timestamps of the thread it copied, so an
 * event older than the fork itself is the copied history, not something said there.
 *
 * Two ways in, one filter: `scanOwnerMessages` walks a window of history (a load, the daily pass); `ownerMessagesOf` judges one
 * event as it arrives (the at-message hook). Consumers subscribe once to `createOwnerMessageHub` and get both.
 */
export interface OwnerMessage { id: string; threadId: string; projectId: string; at: number; text: string }

export type ThreadLike = {
  id: string; projectId: string; createdAt: number; visibility?: string | null; parentThreadId?: string | null; originPluginId?: string | null;
  originKind?: string | null; deletedAt?: number | null;
};
export type EventLike = { seq: number; type: string; createdAt: number; data: Record<string, unknown> };

/** What the collector needs from BB; the SDK and the `bb` CLI both fit. */
export interface ThreadsPort {
  listThreads(query: { offset: number; limit: number; signal?: AbortSignal | undefined }): Promise<ThreadLike[]>;
  /** Newest first. `beforeSeq` pages backwards. Only `client/turn/requested` events are needed. */
  listEvents(query: { threadId: string; beforeSeq?: number | undefined; limit: number; signal?: AbortSignal | undefined }): Promise<EventLike[]>;
}

export const PAGE_SIZE = 100;
export const MAX_TEXT_CHARACTERS = 600_000;
/** These guards fail the whole collection rather than return partial evidence. */
export const MAX_THREAD_PAGES = 1_000;
export const MAX_EVENT_PAGES = 100_000;
const AGENT_ENVELOPE = /^\[bb message from thread:[^;\]\s]+(?:;[^\]]*)?\]\s*/;
export const TURN_REQUESTED = "client/turn/requested";

/** Threads whose messages are the owner's: visible, top level, not made by a plugin, not deleted. */
export const isOwnerThread = (thread: ThreadLike): boolean =>
  (thread.visibility ?? "visible") === "visible" && !thread.parentThreadId && !thread.originPluginId && thread.deletedAt == null;

type TextPart = { type?: unknown; text?: unknown; visibility?: unknown };
const textOf = (input: unknown): string => (Array.isArray(input) ? (input as TextPart[]) : [])
  .filter((part) => part?.type === "text" && part.visibility !== "agent-only").map((part) => String(part.text ?? "")).join("");

/** The owner's messages in one event, or none: the single filter for a window and for a live event. */
export function ownerMessagesOf(event: EventLike, thread: ThreadLike): OwnerMessage[] {
  if (event.type !== TURN_REQUESTED || !isOwnerThread(thread)) return [];
  // Fork inheritance retains the original timestamp, not the copy time.
  if (thread.originKind === "fork" && event.createdAt < thread.createdAt) return [];
  const data = event.data;
  // Live BB stamps ordinary user requests as "unlabeled" too; only a specific kind marks a system message.
  const systemNotice = data.systemMessageKind != null && data.systemMessageKind !== "unlabeled";
  if (data.initiator !== "user" || data.senderThreadId || systemNotice || data.retryOfRequestId) return [];
  const groups = (Array.isArray(data.inputGroups) ? data.inputGroups : [data.input]) as unknown[];
  const out: OwnerMessage[] = [];
  groups.forEach((input, index) => {
    const text = textOf(input);
    if (!text.trim() || AGENT_ENVELOPE.test(text)) return;
    out.push({ id: `${thread.id}:${event.seq}:${index}`, threadId: thread.id, projectId: thread.projectId, at: event.createdAt, text });
  });
  return out;
}

export type ScanOptions = {
  from: number; to: number; signal?: AbortSignal | undefined;
  /** Called for each message in the window, in the order found (not chronological). */
  onMessage: (message: OwnerMessage) => void;
};

/** Walks every owner thread and calls `onMessage` for the messages inside [from, to). Counts without keeping text when the caller only counts. */
export async function scanOwnerMessages(port: ThreadsPort, options: ScanOptions): Promise<{ threads: number; scanned: number }> {
  const { from, to, signal } = options;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("Conversation collection requires a finite, increasing [from, to) window.");
  const seenThreads = new Set<string>(), seenRequests = new Set<string>();
  let eventPages = 0, threads = 0;
  for (let page = 0; ; page++) {
    signal?.throwIfAborted();
    if (page >= MAX_THREAD_PAGES) throw new Error(`Conversation collection exceeded ${MAX_THREAD_PAGES} thread pages; no partial result is available.`);
    const listed = await port.listThreads({ offset: page * PAGE_SIZE, limit: PAGE_SIZE, signal });
    for (const thread of listed) {
      signal?.throwIfAborted();
      if (seenThreads.has(thread.id)) continue;
      seenThreads.add(thread.id);
      if (!isOwnerThread(thread)) continue;
      threads += 1;
      let beforeSeq: number | undefined;
      for (;;) {
        signal?.throwIfAborted();
        if (++eventPages > MAX_EVENT_PAGES) throw new Error(`Conversation collection exceeded ${MAX_EVENT_PAGES} event pages; no partial result is available.`);
        const events = await port.listEvents({ threadId: thread.id, beforeSeq, limit: PAGE_SIZE, signal });
        if (!events.length) break;
        const next = Math.min(...events.map((event) => event.seq));
        if (!Number.isSafeInteger(next) || (beforeSeq !== undefined && next >= beforeSeq)) throw new Error("Conversation event pagination did not advance; no partial result is available.");
        for (const event of events) {
          if (event.createdAt < from || event.createdAt >= to) continue;
          const messages = ownerMessagesOf(event, thread);
          if (!messages.length) continue;
          const requestId = String(event.data.requestId ?? "");
          if (requestId) { if (seenRequests.has(requestId)) continue; seenRequests.add(requestId); }
          for (const message of messages) options.onMessage(message);
        }
        // Newest first and times follow sequence, except in a fork, which carries older times: stop once a page is wholly before the window.
        if (thread.originKind !== "fork" && events.every((event) => event.createdAt < from)) break;
        if (events.length < PAGE_SIZE) break;
        beforeSeq = next;
      }
    }
    if (listed.length < PAGE_SIZE) break;
  }
  return { threads, scanned: eventPages };
}

/** All messages of a window, oldest first. Over 600 000 characters it fails instead of cutting silently; narrow the window. */
export async function collectOwnerMessages(port: ThreadsPort, from: number, to: number, signal?: AbortSignal): Promise<OwnerMessage[]> {
  const records: OwnerMessage[] = [];
  let characters = 0;
  await scanOwnerMessages(port, { from, to, signal, onMessage: (message) => {
    characters += message.text.length;
    if (characters > MAX_TEXT_CHARACTERS) throw new Error(`Conversation collection exceeds ${MAX_TEXT_CHARACTERS} text characters; narrow the window. No text was silently truncated.`);
    records.push(message);
  } });
  return records.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** The pointer kept as evidence. The text itself is not stored unless a caller adds a short, masked quote. */
export const messageEvidence = (message: OwnerMessage, quote?: string): Evidence => ({
  source: "bb-message", ref: message.id, at: message.at, ...(quote ? { quote } : {}),
});

/** The SDK of a plugin as a port. */
export function sdkThreadsPort(bb: { sdk: { threads: { list(query: Record<string, unknown>): Promise<unknown>; events: { list(query: Record<string, unknown>): Promise<unknown> } } } }): ThreadsPort {
  return {
    listThreads: async ({ offset, limit, signal }) => await bb.sdk.threads.list({ includeHidden: false, hasParent: false, limit, offset, signal }) as ThreadLike[],
    listEvents: async ({ threadId, beforeSeq, limit, signal }) => await bb.sdk.threads.events.list({
      threadId, types: [TURN_REQUESTED], order: "desc", limit: String(limit), ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }), signal,
    }) as EventLike[],
  };
}

/* ---- the shared hook ---- */

export type OwnerMessageMeta = { live: boolean; window?: { from: number; to: number } };
export interface OwnerMessageConsumer { name: string; handle(batch: OwnerMessage[], meta: OwnerMessageMeta): Promise<void> | void }

/** One subscription point for everything that learns from the owner's messages. A consumer that fails does not stop the others. */
export function createOwnerMessageHub() {
  const consumers = new Map<string, OwnerMessageConsumer>();
  return {
    subscribe(consumer: OwnerMessageConsumer): () => void {
      consumers.set(consumer.name, consumer);
      return () => { if (consumers.get(consumer.name) === consumer) consumers.delete(consumer.name); };
    },
    names: (): string[] => [...consumers.keys()],
    async deliver(batch: OwnerMessage[], meta: OwnerMessageMeta): Promise<{ delivered: string[]; failed: Array<{ name: string; error: string }> }> {
      const delivered: string[] = [], failed: Array<{ name: string; error: string }> = [];
      if (!batch.length) return { delivered, failed };
      await Promise.all([...consumers.values()].map(async (consumer) => {
        try { await consumer.handle(batch, meta); delivered.push(consumer.name); }
        catch (cause) { failed.push({ name: consumer.name, error: cause instanceof Error ? cause.message : String(cause) }); }
      }));
      return { delivered: delivered.sort(), failed };
    },
    /** The at-message path: one live event from a thread, through the same filter. */
    async deliverEvent(event: EventLike, thread: ThreadLike) {
      return await this.deliver(ownerMessagesOf(event, thread), { live: true });
    },
  };
}
export type OwnerMessageHub = ReturnType<typeof createOwnerMessageHub>;
