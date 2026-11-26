import { afterEach, describe, expect, it, vi } from "vitest";
import { installThreadEventFeed, type FeedEvent } from "../src/rooms/stability/server";

/**
 * The shared thread event feed (0.1.575): the real contract is a debounced {thread, sequence} wake plus
 * threads.events.list rows — never an inline event. These tests drive that contract end to end with a fake host.
 */

type Row = { threadId: string; seq: number; type: string; createdAt: number; data: unknown };
type ListQuery = { threadId?: string; types?: string[]; order?: string; limit?: string; afterSeq?: string; beforeSeq?: string };

function host() {
  const log: string[] = [];
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const rows: Row[] = [];
  const queries: ListQuery[] = [];
  // The feed captures `events.list` once at install, so failure injection swaps this delegate, not the SDK property.
  const realList = async (query: ListQuery) => {
    queries.push(query);
    let found = rows.filter((row) => row.threadId === query.threadId && (!query.types?.length || query.types.includes(row.type)));
    if (query.afterSeq !== undefined) found = found.filter((row) => row.seq > Number(query.afterSeq));
    if (query.beforeSeq !== undefined) found = found.filter((row) => row.seq < Number(query.beforeSeq));
    found = [...found].sort((a, b) => query.order === "desc" ? b.seq - a.seq : a.seq - b.seq);
    return found.slice(0, Number(query.limit) || 100).map((row) => ({ seq: row.seq, type: row.type, createdAt: row.createdAt, data: row.data }));
  };
  let listImpl: (query: ListQuery) => Promise<unknown> = realList;
  const bb = {
    log: { info: (line: string) => { log.push(line); } },
    events: { on: (name: string, handler: (payload: unknown) => unknown) => { handlers.set(name, handler); } },
    sdk: {
      threads: {
        events: {
          list: (query: ListQuery) => listImpl(query),
        },
      },
    },
  };
  let disposed = false;
  const ctx = { isDisposed: () => disposed, bb, log: { info: () => undefined } } as never;
  const emit = async (threadId: string, sequence?: number) => {
    const seq = sequence ?? Math.max(0, ...rows.filter((row) => row.threadId === threadId).map((row) => row.seq));
    await handlers.get("experimental_thread.events")!({ thread: { id: threadId, status: "active" }, sequence: seq });
  };
  const push = (threadId: string, type: string, data: unknown = {}, createdAt = Date.now()) => {
    const seq = Math.max(0, ...rows.map((row) => row.seq)) + 1;
    rows.push({ threadId, seq, type, createdAt, data });
    return seq;
  };
  return { bb, ctx, rows, log, handlers, queries, realList, setList: (fn: (query: ListQuery) => Promise<unknown>) => { listImpl = fn; }, emit, push, dispose: () => { disposed = true; } };
}

const collect = () => {
  const seen: Array<{ threadId: string; type: string; seq: number }> = [];
  return {
    seen,
    consumer: (types: string[]) => ({
      types: new Set(types),
      handle: (threadId: string, events: FeedEvent[]) => { for (const event of events) seen.push({ threadId, type: event.type, seq: event.seq }); },
    }),
  };
};

afterEach(() => { vi.useRealTimers(); });

describe("thread event feed", () => {
  it("delivers real notification -> event rows in seq order, once", async () => {
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started", "turn/completed"]));
    const s1 = h.push("thr_a", "turn/started");
    const s2 = h.push("thr_a", "item/completed", { item: { type: "toolCall" } });
    const s3 = h.push("thr_a", "turn/completed", { status: "completed" });
    await h.emit("thr_a", s3);
    expect(seen.map((row) => row.seq)).toEqual([s1, s3]); // item/completed is not a subscribed type
    await h.emit("thr_a", s3); // duplicate wake: cursor already past, nothing redelivered
    expect(seen).toHaveLength(2);
    void s2;
  });

  it("drains more than one page of backlog and coalesces wakes during a read", async () => {
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started"]));
    const seqs: number[] = [];
    for (let i = 0; i < 105; i++) seqs.push(h.push("thr_b", "turn/started"));
    // A wake while the first read is in flight must not be dropped: it re-reads after the cursor.
    const first = h.emit("thr_b", seqs.at(-1)!);
    const second = h.emit("thr_b", seqs.at(-1)!);
    await Promise.all([first, second]);
    expect(seen).toHaveLength(105);
    expect(seen.every((row, index) => row.seq === seqs[index])).toBe(true);
  });

  it("keeps the cursor on a failed read and retries on the next wake", async () => {
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started"]));
    const s1 = h.push("thr_c", "turn/started");
    let fail = true;
    h.setList(async (query: ListQuery) => { if (fail) { fail = false; throw new Error("host down"); } return h.realList(query); });
    await h.emit("thr_c", s1);
    expect(seen).toHaveLength(0);
    await h.emit("thr_c", s1); // same sequence, retried read now succeeds
    expect(seen.map((row) => row.seq)).toEqual([s1]);
  });

  it("does not replay events older than the feed on first contact", async () => {
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started", "turn/completed"]));
    h.push("thr_d", "turn/started", {}, Date.now() - 120_000); // before the feed existed
    h.push("thr_d", "turn/completed", { status: "completed" }, Date.now() - 120_000);
    const s3 = h.push("thr_d", "turn/started");
    await h.emit("thr_d", s3);
    expect(seen.map((row) => row.seq)).toEqual([s3]);
  });

  it("covers rows newer than the notification sequence without redelivery", async () => {
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started"]));
    const s1 = h.push("thr_e", "turn/started");
    const s2 = h.push("thr_e", "turn/started");
    await h.emit("thr_e", s1); // notification lags: the log already holds s2
    expect(seen.map((row) => row.seq)).toEqual([s1, s2]);
    const s3 = h.push("thr_e", "turn/started");
    await h.emit("thr_e", s3);
    expect(seen.map((row) => row.seq)).toEqual([s1, s2, s3]); // s1/s2 not redelivered
  });

  it("stops reading once the host is disposed and ignores malformed wakes", async () => {
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started"]));
    const s1 = h.push("thr_f", "turn/started");
    await h.emit("thr_f", s1);
    expect(seen).toHaveLength(1);
    h.dispose();
    const s2 = h.push("thr_f", "turn/started");
    await h.emit("thr_f", s2);
    expect(seen).toHaveLength(1);
    await handlers_bad(h);
  });

  it("routes each consumer only its subscribed types", async () => {
    const h = host();
    const pm = collect();
    const limits = collect();
    const feed = installThreadEventFeed(h.ctx);
    feed.add(pm.consumer(["turn/started"]));
    feed.add(limits.consumer(["provider/rateLimits/updated"]));
    h.push("thr_g", "turn/started");
    h.push("thr_g", "provider/rateLimits/updated", { rateLimits: { kind: "subscription-window" } });
    const last = Math.max(...h.rows.map((row) => row.seq));
    await h.emit("thr_g", last);
    expect(pm.seen.map((row) => row.type)).toEqual(["turn/started"]);
    expect(limits.seen.map((row) => row.type)).toEqual(["provider/rateLimits/updated"]);
  });

  it("an empty page ends the read instead of re-pumping forever", async () => {
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started"]));
    const s1 = h.push("thr_h", "turn/started");
    await h.emit("thr_h", s1);
    expect(seen).toHaveLength(1);
    const calls = h.queries.length;
    await h.emit("thr_h", s1); // a wake after a quiet turn: the log has nothing new
    // The emit resolves at all only because the empty page is not `truncated`; a bounded number of list calls proves no spin.
    expect(h.queries.length - calls).toBeLessThanOrEqual(2);
    expect(seen).toHaveLength(1);
  });

  it("a failed later first-contact page delivers nothing and the retry recovers every fresh row", async () => {
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started"]));
    const seqs: number[] = [];
    for (let i = 0; i < 105; i++) seqs.push(h.push("thr_i", "turn/started"));
    let calls = 0;
    let fail = true;
    h.setList(async (query: ListQuery) => { calls += 1; if (fail && calls === 2) { fail = false; throw new Error("host lost page 2"); } return h.realList(query); });
    await h.emit("thr_i", seqs.at(-1)!);
    // Page 1 held the newest 100 fresh rows; returning them with the cursor at the head would lose the 5 older ones forever.
    expect(seen).toHaveLength(0);
    await h.emit("thr_i", seqs.at(-1)!); // cursor stayed unset: the whole first contact runs again
    expect(seen.map((row) => row.seq)).toEqual(seqs);
  });

  it("the sweep recovers a missed wake, evicts a silent thread and stops on dispose", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started"]));
    const s1 = h.push("thr_j", "turn/started");
    await h.emit("thr_j", s1);
    expect(seen.map((row) => row.seq)).toEqual([s1]);

    const s2 = h.push("thr_j", "turn/started"); // notification lost: no emit
    await vi.advanceTimersByTimeAsync(60_000); // one sweep pass
    expect(seen.map((row) => row.seq)).toEqual([s1, s2]);

    await vi.advanceTimersByTimeAsync(25 * 3_600_000); // a day of empty sweeps: the cursor is forgotten
    const s3 = h.push("thr_j", "turn/started");
    const before = h.queries.length;
    await h.emit("thr_j", s3);
    // An evicted cursor meets its thread as a first contact again (desc pages), not as a tail read (asc).
    expect(h.queries.slice(before).some((query) => query.order === "desc")).toBe(true);
    expect(seen.at(-1)?.seq).toBe(s3);

    h.dispose();
    const calls = h.queries.length;
    await vi.advanceTimersByTimeAsync(120_000);
    await h.emit("thr_j", s3);
    expect(h.queries.length).toBe(calls);
  });

  it("the sweep retries a first contact whose first read failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = host();
    const { seen, consumer } = collect();
    installThreadEventFeed(h.ctx).add(consumer(["turn/started"]));
    const s1 = h.push("thr_k", "turn/started");
    let fail = true;
    h.setList(async (query: ListQuery) => { if (fail) { fail = false; throw new Error("host down"); } return h.realList(query); });
    await h.emit("thr_k", s1);
    expect(seen).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000); // no second notification: the sweep alone retries the bounded first contact
    expect(seen.map((row) => row.seq)).toEqual([s1]);
  });
});

async function handlers_bad(h: ReturnType<typeof host>) {
  await h.handlers.get("experimental_thread.events")!({ thread: { id: "thr_f" } }); // no sequence
  await h.handlers.get("experimental_thread.events")!(null);
  await h.handlers.get("experimental_thread.events")!({ thread: { id: 42 }, sequence: "x" });
}
