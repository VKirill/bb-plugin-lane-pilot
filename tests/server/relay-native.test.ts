import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRelay, relayFor, type RelayItem } from "../../src/server/relay";
import { openDatabase } from "../../src/database";

type Queued = { threadId: string; text: string; sendAt: number };

/** The relay with BB's queue faked: rows by id, and what the plugin itself sent. */
function harness(options: { schedule?: "ok" | "null" | "throws"; drop?: "deleted" | "gone" | "failed" } = {}) {
  let items: RelayItem[] = [];
  let now = 1_000_000;
  const sent: Array<{ threadId: string; text: string }> = [];
  const rows = new Map<string, Queued>();
  const dropped: string[] = [];
  const tasks = new Map<string, string>();
  const status = new Map<string, string>();
  let rowSeq = 0;
  const relay = createRelay({
    load: async () => structuredClone(items),
    save: async (next) => { items = structuredClone(next); },
    send: async (threadId, text) => { sent.push({ threadId, text }); },
    settled: async (threadId) => status.get(threadId) === "idle",
    output: async () => "",
    taskStates: async (_project, ids) => Object.fromEntries(ids.map((task) => [task, tasks.get(task) ?? null])),
    now: () => now,
    log: () => undefined,
    scheduleQueued: async (threadId, text, sendAt) => {
      if (options.schedule === "throws") throw new Error("HTTP 500");
      if (options.schedule === "null") return null;
      const id = `q${++rowSeq}`;
      rows.set(id, { threadId, text, sendAt });
      return id;
    },
    dropQueued: async (_threadId, id) => {
      dropped.push(id);
      const outcome = options.drop ?? (rows.has(id) ? "deleted" : "gone");
      if (outcome === "deleted") rows.delete(id);
      return outcome;
    },
    queuedState: async (_threadId, id) => rows.has(id) ? "waiting" : "gone",
  });
  return { relay, sent, rows, dropped, tasks, status, items: () => items, tick: (ms: number) => { now += ms; } };
}

describe("reminders in BB's own queue", () => {
  it("queues the reminder for its due time and sends nothing itself", async () => {
    const h = harness();
    const item = await h.relay.remind({ projectId: "P", threadId: "pm", note: "check the merge", inMinutes: 10 });
    expect(item.queuedMessageId).toBe("q1");
    const row = h.rows.get("q1")!;
    expect(row).toMatchObject({ threadId: "pm", sendAt: item.dueAt });
    expect(row.text).toContain(item.id);
    expect(row.text).toContain("check the merge");
    expect(row.text).toContain("time reached");
    h.tick(11 * 60_000);
    // BB's clock sends it; the sweep only looks.
    expect(await h.relay.sweep()).toEqual({ fired: 0, settled: 0 });
    expect(h.sent).toHaveLength(0);
    expect(h.items()[0]).toMatchObject({ firedAt: null });
  });

  it("closes the reminder once its row is gone: sent by BB, or deleted from the card", async () => {
    const h = harness();
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "n", inMinutes: 1 });
    h.rows.clear();
    h.tick(2 * 60_000);
    await h.relay.sweep();
    expect(h.items()[0]).toMatchObject({ firedBy: "time" });
    expect(h.sent).toHaveLength(0);
  });

  it("an early wake by a finished thread deletes the row, then sends once", async () => {
    const h = harness();
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "retry", inMinutes: 30, watchThreadId: "holder" });
    h.status.set("holder", "idle");
    expect((await h.relay.sweep()).settled).toBe(1);
    expect(h.dropped).toEqual(["q1"]);
    expect(h.rows.size).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain("finished its turn");
    h.tick(31 * 60_000);
    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
  });

  it("an early wake by finished tasks does the same, with their states", async () => {
    const h = harness();
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "ship", inMinutes: 40, taskIds: ["a"] });
    h.tasks.set("a", "accepted");
    expect((await h.relay.sweep()).fired).toBe(1);
    expect(h.dropped).toEqual(["q1"]);
    expect(h.sent[0]!.text).toMatch(/a — accepted/);
  });

  it("an early wake finds the row already gone (BB sent it a moment ago): no second reminder", async () => {
    const h = harness();
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "retry", inMinutes: 30, watchThreadId: "holder" });
    h.rows.clear();
    h.status.set("holder", "idle");
    await h.relay.sweep();
    expect(h.sent).toHaveLength(0);
    expect(h.items()[0]).toMatchObject({ firedBy: "time" });
  });

  it("a failed delete still sends the early reminder", async () => {
    const h = harness({ drop: "failed" });
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "retry", inMinutes: 30, watchThreadId: "holder" });
    h.status.set("holder", "idle");
    await h.relay.sweep();
    expect(h.sent).toHaveLength(1);
  });

  it("cancel deletes the row; so does the answer of the thread a reminder waited on", async () => {
    const h = harness();
    const first = await h.relay.remind({ projectId: "P", threadId: "pm", note: "n", inMinutes: 5 });
    expect(await h.relay.cancel({ threadId: "pm", reminderId: first.id })).toBe(true);
    expect(h.rows.has("q1")).toBe(false);
    const asked = await h.relay.ask({ projectId: "P", fromThreadId: "pm", toThreadId: "lp", question: "Fix?" });
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "lp?", inMinutes: 10, watchThreadId: "lp" });
    expect(h.rows.size).toBe(1);
    await h.relay.reply({ askId: asked.id, fromThreadId: "lp", answer: "done" });
    expect(h.rows.size).toBe(0);
  });

  it("BB's events: a dispatched row closes the reminder as sent, a deleted one as canceled", async () => {
    const h = harness();
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "a", inMinutes: 5 });
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "b", inMinutes: 5 });
    expect(await h.relay.queueEvent("message.dispatched", "q1")).toBe(true);
    expect(await h.relay.queueEvent("message.cancelled", "q2")).toBe(true);
    expect(await h.relay.queueEvent("message.cancelled", "q_unknown")).toBe(false);
    expect(h.items().map((item) => item.kind === "remind" ? item.firedBy : null)).toEqual(["time", "canceled"]);
    h.tick(10 * 60_000);
    await h.relay.sweep();
    expect(h.sent).toHaveLength(0);
  });

  for (const schedule of ["null", "throws"] as const) {
    it(`falls back to the sweep when the row cannot be queued (${schedule})`, async () => {
      const h = harness({ schedule });
      const item = await h.relay.remind({ projectId: "P", threadId: "pm", note: "later", inMinutes: 5 });
      expect(item.queuedMessageId ?? null).toBeNull();
      h.tick(6 * 60_000);
      expect((await h.relay.sweep()).fired).toBe(1);
      expect(h.sent[0]!.text).toContain("later");
    });
  }
});

describe("through BB's SDK", () => {
  function sdkRelay(env?: string) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rows = new Map<string, boolean>();
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      send: async (args: Record<string, unknown>) => {
        calls.push({ name: "send", args });
        if (args.sendAt === undefined) return { delivery: "sent", ok: true };
        rows.set("row_1", true);
        return { delivery: "queued", ok: true, queuedMessage: { id: "row_1" } };
      },
      queuedMessages: {
        delete: async (args: Record<string, unknown>) => { calls.push({ name: "delete", args }); if (!rows.delete(String(args.queuedMessageId))) throw new Error("HTTP 404: queued message not found"); return { ok: true }; },
        list: async () => [...rows.keys()].map((id) => ({ id })),
      },
    } } } as never);
    const previous = process.env.LANE_PILOT_NATIVE_REMINDERS;
    if (env !== undefined) process.env.LANE_PILOT_NATIVE_REMINDERS = env;
    const relay = relayFor({ bb, db: openDatabase(bb), log: () => undefined } as never);
    if (env !== undefined) { if (previous === undefined) delete process.env.LANE_PILOT_NATIVE_REMINDERS; else process.env.LANE_PILOT_NATIVE_REMINDERS = previous; }
    return { relay, calls, rows };
  }

  it("threads.send with sendAt queues it, queuedMessages.delete takes it out", async () => {
    const { relay, calls, rows } = sdkRelay();
    const item = await relay.remind({ projectId: "P", threadId: "pm", note: "later", inMinutes: 15 });
    expect(item.queuedMessageId).toBe("row_1");
    expect(calls[0]).toMatchObject({ name: "send", args: { threadId: "pm", mode: "queue-if-active", sendAt: item.dueAt } });
    expect(await relay.cancel({ threadId: "pm", reminderId: item.id })).toBe(true);
    expect(calls[1]).toMatchObject({ name: "delete", args: { threadId: "pm", queuedMessageId: "row_1" } });
    expect(rows.size).toBe(0);
  });

  it("a row that BB no longer has counts as sent", async () => {
    const { relay, rows } = sdkRelay();
    const item = await relay.remind({ projectId: "P", threadId: "pm", note: "later", inMinutes: 0.01 });
    rows.clear();
    await new Promise((wake) => setTimeout(wake, 700));
    await relay.sweep();
    expect((await relay.list("pm"))[0]).toMatchObject({ id: item.id, firedBy: "time" });
  });

  it("LANE_PILOT_NATIVE_REMINDERS=0 queues nothing", async () => {
    const { relay, calls } = sdkRelay("0");
    const item = await relay.remind({ projectId: "P", threadId: "pm", note: "later", inMinutes: 15 });
    expect(item.queuedMessageId ?? null).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
