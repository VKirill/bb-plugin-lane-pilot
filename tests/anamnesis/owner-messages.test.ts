import { describe, expect, it } from "vitest";
import { MAX_TEXT_CHARACTERS, collectOwnerMessages, createOwnerMessageHub, messageEvidence, ownerMessagesOf, scanOwnerMessages, sdkThreadsPort,
  type EventLike, type ThreadLike, type ThreadsPort } from "../../src/rooms/anamnesis/owner-messages";

const T = Date.UTC(2026, 5, 1);
const thread = (id: string, over: Partial<ThreadLike> = {}): ThreadLike => ({ id, projectId: "proj_a", createdAt: T - 1000, visibility: "visible", parentThreadId: null, originPluginId: null, deletedAt: null, ...over });
let requestCounter = 0;
const turn = (seq: number, at: number, data: Record<string, unknown> = {}): EventLike => ({
  seq, type: "client/turn/requested", createdAt: at,
  data: { initiator: "user", requestId: `r${++requestCounter}`, input: [{ type: "text", text: `message ${seq}` }], ...data },
});

function port(threads: ThreadLike[], events: Record<string, EventLike[]>, pageLog: number[] = []): ThreadsPort {
  return {
    listThreads: async ({ offset, limit }) => threads.slice(offset, offset + limit),
    listEvents: async ({ threadId, beforeSeq, limit }) => {
      const all = [...(events[threadId] ?? [])].sort((a, b) => b.seq - a.seq).filter((e) => beforeSeq === undefined || e.seq < beforeSeq);
      pageLog.push(all.length);
      return all.slice(0, limit);
    },
  };
}

describe("ownerMessagesOf: original human requests only", () => {
  const t = thread("thr_1");
  it("keeps a plain user request, including the «unlabeled» system kind live BB stamps on them", () => {
    expect(ownerMessagesOf(turn(1, T, { systemMessageKind: "unlabeled" }), t).map((m) => m.id)).toEqual(["thr_1:1:0"]);
  });
  it("drops agent, system, retry and agent-only content", () => {
    expect(ownerMessagesOf(turn(1, T, { initiator: "agent" }), t)).toEqual([]);
    expect(ownerMessagesOf(turn(1, T, { senderThreadId: "thr_x" }), t)).toEqual([]);
    expect(ownerMessagesOf(turn(1, T, { systemMessageKind: "relay" }), t)).toEqual([]);
    expect(ownerMessagesOf(turn(1, T, { retryOfRequestId: "r0" }), t)).toEqual([]);
    expect(ownerMessagesOf(turn(1, T, { input: [{ type: "text", text: "secret context", visibility: "agent-only" }] }), t)).toEqual([]);
    expect(ownerMessagesOf(turn(1, T, { input: [{ type: "text", text: "[bb message from thread:thr_9;x=1] hi" }] }), t)).toEqual([]);
    expect(ownerMessagesOf({ ...turn(1, T), type: "agent/turn" }, t)).toEqual([]);
  });
  it("splits input groups into separate messages", () => {
    const e = turn(2, T, { inputGroups: [[{ type: "text", text: "a" }], [{ type: "text", text: " " }], [{ type: "text", text: "c" }]] });
    expect(ownerMessagesOf(e, t).map((m) => [m.id, m.text])).toEqual([["thr_1:2:0", "a"], ["thr_1:2:2", "c"]]);
  });
  it("skips hidden, child, plugin-made and deleted threads, and the copied history of a fork", () => {
    for (const bad of [{ visibility: "hidden" }, { parentThreadId: "thr_p" }, { originPluginId: "lane-pilot" }, { deletedAt: 5 }]) {
      expect(ownerMessagesOf(turn(1, T), thread("thr_b", bad))).toEqual([]);
    }
    const fork = thread("thr_f", { originKind: "fork", createdAt: T });
    expect(ownerMessagesOf(turn(1, T - 5000), fork)).toEqual([]);
    expect(ownerMessagesOf(turn(2, T + 5), fork)).toHaveLength(1);
  });
});

describe("scan and collect", () => {
  it("collects a window across threads, pages backwards through long threads and sorts oldest first", async () => {
    const many = Array.from({ length: 250 }, (_, i) => turn(i + 1, T + i * 10));
    const log: number[] = [];
    const p = port([thread("thr_1"), thread("thr_2"), thread("thr_hidden", { visibility: "hidden" })], { thr_1: many, thr_2: [turn(1, T + 5)], thr_hidden: [turn(1, T)] }, log);
    const messages = await collectOwnerMessages(p, T, T + 100_000);
    expect(messages).toHaveLength(251);
    expect(messages[0]!.at).toBe(T);
    expect(messages.map((m) => m.at)).toEqual([...messages.map((m) => m.at)].sort((a, b) => a - b));
    expect(log.length).toBeGreaterThanOrEqual(4);
  });

  it("applies the window as [from, to) and stops reading a thread once a page is wholly older", async () => {
    const log: number[] = [];
    const old = Array.from({ length: 300 }, (_, i) => turn(i + 1, T - 1_000_000 + i));
    const p = port([thread("thr_1")], { thr_1: [...old, turn(301, T), turn(302, T + 50)] }, log);
    const got = await collectOwnerMessages(p, T, T + 50);
    expect(got.map((m) => m.id)).toEqual(["thr_1:301:0"]);
    expect(log).toHaveLength(2);
  });

  it("counts a request id once and lists a thread seen on two pages once", async () => {
    const e = turn(1, T);
    const p = port([thread("thr_1"), thread("thr_1")], { thr_1: [e, { ...e, seq: 2 }] });
    expect(await collectOwnerMessages(p, T, T + 1)).toHaveLength(1);
  });

  it("refuses a bad window, honours abort, and fails instead of truncating silently", async () => {
    const p = port([thread("thr_1")], { thr_1: [turn(1, T, { input: [{ type: "text", text: "x".repeat(MAX_TEXT_CHARACTERS + 1) }] })] });
    await expect(collectOwnerMessages(p, T + 1, T)).rejects.toThrow(/increasing/);
    await expect(collectOwnerMessages(p, T, T + 1)).rejects.toThrow(/text characters/);
    const controller = new AbortController(); controller.abort();
    await expect(collectOwnerMessages(p, T, T + 1, controller.signal)).rejects.toThrow();
  });

  it("fails when event pagination does not advance", async () => {
    const stuck: ThreadsPort = { listThreads: async ({ offset }) => (offset ? [] : [thread("thr_1")]), listEvents: async () => Array.from({ length: 100 }, () => turn(7, T)) };
    await expect(scanOwnerMessages(stuck, { from: T, to: T + 1, onMessage: () => undefined })).rejects.toThrow(/did not advance/);
  });

  it("scans without keeping text when the caller only counts", async () => {
    let count = 0;
    const result = await scanOwnerMessages(port([thread("thr_1")], { thr_1: [turn(1, T), turn(2, T + 1)] }), { from: T, to: T + 10, onMessage: () => { count += 1; } });
    expect(count).toBe(2);
    expect(result.threads).toBe(1);
  });

  it("builds its port from the SDK with the memory-profile query shape", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bb = { sdk: { threads: { list: async (q: Record<string, unknown>) => { calls.push(q); return []; }, events: { list: async (q: Record<string, unknown>) => { calls.push(q); return []; } } } } };
    const sdk = sdkThreadsPort(bb);
    await sdk.listThreads({ offset: 100, limit: 100 });
    await sdk.listEvents({ threadId: "thr_1", beforeSeq: 9, limit: 100 });
    expect(calls[0]).toMatchObject({ includeHidden: false, hasParent: false, limit: 100, offset: 100 });
    expect(calls[1]).toMatchObject({ threadId: "thr_1", types: ["client/turn/requested"], order: "desc", limit: "100", beforeSeq: "9" });
  });
});

describe("the shared hook", () => {
  it("delivers a batch to every consumer, and one failing consumer does not stop the other", async () => {
    const hub = createOwnerMessageHub();
    const seen: string[] = [];
    hub.subscribe({ name: "anamnesis", handle: (batch, meta) => { seen.push(`a:${batch.length}:${meta.live}`); } });
    hub.subscribe({ name: "learning", handle: () => { throw new Error("boom"); } });
    const batch = ownerMessagesOf(turn(1, T), thread("thr_1"));
    expect(await hub.deliver(batch, { live: false })).toEqual({ delivered: ["anamnesis"], failed: [{ name: "learning", error: "boom" }] });
    expect(seen).toEqual(["a:1:false"]);
  });

  it("a live event goes through the same filter as a scan, and an agent's message reaches nobody", async () => {
    const hub = createOwnerMessageHub();
    const got: string[] = [];
    const off = hub.subscribe({ name: "x", handle: (batch) => { got.push(...batch.map((m) => m.id)); } });
    await hub.deliverEvent(turn(5, T), thread("thr_1"));
    await hub.deliverEvent(turn(6, T, { initiator: "agent" }), thread("thr_1"));
    await hub.deliverEvent(turn(7, T), thread("thr_h", { visibility: "hidden" }));
    expect(got).toEqual(["thr_1:5:0"]);
    off();
    expect(hub.names()).toEqual([]);
  });

  it("evidence points at the message and carries a quote only when given one", () => {
    const [message] = ownerMessagesOf(turn(3, T), thread("thr_1"));
    expect(messageEvidence(message!)).toEqual({ source: "bb-message", ref: "thr_1:3:0", at: T });
    expect(messageEvidence(message!, "short")).toMatchObject({ quote: "short" });
  });
});
