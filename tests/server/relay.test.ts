import { describe, expect, it } from "vitest";
import { createRelay, RELAY_LIMITS, type RelayItem } from "../../src/server/relay";

function harness() {
  let items: RelayItem[] = [];
  let now = 1_000_000;
  const sent: Array<{ threadId:string; text:string }> = [];
  const status = new Map<string, string>();
  const queued = new Map<string, number>();
  const tasks = new Map<string, string>();
  const relay = createRelay({
    load:async () => structuredClone(items),
    save:async (next) => { items = structuredClone(next); },
    send:async (threadId, text) => { sent.push({ threadId, text }); },
    settled:async (threadId) => status.get(threadId) === "idle" && !(queued.get(threadId) ?? 0),
    output:async () => "I hold the base checkout until 13:40",
    taskStates:async (_project, ids) => Object.fromEntries(ids.map((task) => [task, tasks.get(task) ?? null])),
    now:() => now,
    log:() => undefined,
  });
  return { relay, sent, status, queued, tasks, items:() => items, tick:(ms:number) => { now += ms; } };
}

describe("relay", () => {
  it("delivers a question and the holder's answer back to the asker", async () => {
    const h = harness();
    const ask = await h.relay.ask({ projectId:"P", fromThreadId:"pm", toThreadId:"writer", question:"What do you hold?" });
    expect(h.sent[0]).toMatchObject({ threadId:"writer" });
    expect(h.sent[0]!.text).toContain(ask.id);
    await expect(h.relay.reply({ askId:ask.id, fromThreadId:"someone", answer:"x" })).rejects.toThrow(/only the asked/);
    await h.relay.reply({ askId:ask.id, fromThreadId:"writer", answer:"Free in 5 minutes" });
    expect(h.sent[1]).toMatchObject({ threadId:"pm" });
    expect(h.sent[1]!.text).toContain("Free in 5 minutes");
  });

  it("passes an asked thread's last message back when it settles without answering", async () => {
    const h = harness();
    await h.relay.ask({ projectId:"P", fromThreadId:"pm", toThreadId:"writer", question:"When?" });
    expect(await h.relay.threadSettled("writer")).toBe(0);
    h.status.set("writer", "idle");
    // Idle between turns while the question still waits in its queue (or background work runs): not settled yet.
    h.queued.set("writer", 1);
    expect(await h.relay.threadSettled("writer")).toBe(0);
    h.queued.set("writer", 0);
    expect(await h.relay.threadSettled("writer")).toBe(1);
    expect(h.sent.at(-1)!.text).toContain("until 13:40");
    expect(await h.relay.threadSettled("writer")).toBe(0);
  });

  it("returns the open reminder when the same one is set again, and keeps a different one", async () => {
    const h = harness();
    const first = await h.relay.remind({ projectId:"P", threadId:"pm", note:"Check the merge", inMinutes:10, watchThreadId:"holder" });
    h.tick(20_000);
    const again = await h.relay.remind({ projectId:"P", threadId:"pm", note:" check the merge ", inMinutes:10, watchThreadId:"holder" });
    expect(again.id).toBe(first.id);
    const later = await h.relay.remind({ projectId:"P", threadId:"pm", note:"Check the merge", inMinutes:30, watchThreadId:"holder" });
    const unwatched = await h.relay.remind({ projectId:"P", threadId:"pm", note:"Check the merge", inMinutes:10 });
    const other = await h.relay.remind({ projectId:"Q", threadId:"other", note:"Check the merge", inMinutes:10, watchThreadId:"holder" });
    expect(new Set([first.id, later.id, unwatched.id, other.id]).size).toBe(4);
    expect(h.items().filter((row) => row.kind === "remind")).toHaveLength(4);
  });

  it("fires a reminder when its watched thread settles, or when it is due", async () => {
    const h = harness();
    await h.relay.remind({ projectId:"P", threadId:"pm", note:"retry the merge", inMinutes:10, watchThreadId:"holder" });
    await h.relay.remind({ projectId:"P", threadId:"pm", note:"check again", inMinutes:5 });
    expect((await h.relay.sweep()).fired).toBe(0);
    h.status.set("holder", "idle");
    expect((await h.relay.sweep()).settled).toBe(1);
    expect(h.sent.at(-1)!.text).toContain("retry the merge");
    h.tick(5 * 60_000);
    expect((await h.relay.sweep()).fired).toBe(1);
    expect(h.sent.at(-1)!.text).toContain("check again");
    expect(h.sent.filter((row) => row.threadId === "pm")).toHaveLength(2);
  });

  it("limits questions between two threads and cancels reminders", async () => {
    const h = harness();
    for (let index = 0; index < RELAY_LIMITS.asksPerPairPerHour; index++) {
      const asked = await h.relay.ask({ projectId:"P", fromThreadId:index % 2 ? "a" : "b", toThreadId:index % 2 ? "b" : "a", question:"?" });
      await h.relay.reply({ askId:asked.id, fromThreadId:asked.toThreadId, answer:"ok" });
    }
    await expect(h.relay.ask({ projectId:"P", fromThreadId:"a", toThreadId:"b", question:"?" })).rejects.toThrow(/relay limit/);
    await expect(h.relay.ask({ projectId:"P", fromThreadId:"a", toThreadId:"a", question:"?" })).rejects.toThrow(/itself/);
    const reminder = await h.relay.remind({ projectId:"P", threadId:"pm", note:"n", inMinutes:1 });
    expect(await h.relay.cancel({ threadId:"pm", reminderId:reminder.id })).toBe(true);
    h.tick(120_000);
    expect((await h.relay.sweep()).fired).toBe(0);
  });

  it("does not queue a second copy of a question that still waits for its answer", async () => {
    const h = harness();
    const first = await h.relay.ask({ projectId:"P", fromThreadId:"pm", toThreadId:"lp", question:"Fix the rollback?" });
    const again = await h.relay.ask({ projectId:"P", fromThreadId:"pm", toThreadId:"lp", question:"Reminder: fix the rollback?" });
    expect(again).toMatchObject({ id:first.id, alreadyWaiting:true });
    expect(h.sent.filter((row) => row.threadId === "lp")).toHaveLength(1);
    await h.relay.reply({ askId:first.id, fromThreadId:"lp", answer:"Fixed in 0.1.88" });
    const next = await h.relay.ask({ projectId:"P", fromThreadId:"pm", toThreadId:"lp", question:"One more thing?" });
    expect(next.id).not.toBe(first.id);
  });

  it("closes the asker's reminder on a thread once that thread answers, instead of sending a stale one", async () => {
    const h = harness();
    const asked = await h.relay.ask({ projectId:"P", fromThreadId:"pm", toThreadId:"lp", question:"Fix?" });
    await h.relay.remind({ projectId:"P", threadId:"pm", note:"check lp's answer", inMinutes:10, watchThreadId:"lp" });
    await h.relay.reply({ askId:asked.id, fromThreadId:"lp", answer:"Fixed" });
    h.tick(11 * 60_000);
    expect((await h.relay.sweep()).fired).toBe(0);
    expect(h.sent.filter((row) => row.threadId === "pm").map((row) => row.text)).toEqual([expect.stringContaining("Fixed")]);
    // Answered by settling: the passed-back answer arrives, the reminder on that thread does not.
    const second = await h.relay.ask({ projectId:"P", fromThreadId:"pm", toThreadId:"lp", question:"Deploy?" });
    await h.relay.remind({ projectId:"P", threadId:"pm", note:"deploy?", inMinutes:30, watchThreadId:"lp" });
    h.status.set("lp", "idle");
    expect(await h.relay.threadSettled("lp")).toBe(1);
    expect(h.sent.at(-1)!.text).toContain(second.id);
    expect(h.sent.filter((row) => row.text.includes("deploy?"))).toHaveLength(0);
  });

  it("a reminder on tasks fires the moment they all finish, with their states, not by polling", async () => {
    const h = harness();
    await h.relay.remind({ projectId:"P", threadId:"pm", note:"ship the pages", inMinutes:40, taskIds:["gc-a", "gc-b"] });
    h.tasks.set("gc-a", "accepted");
    h.tasks.set("gc-b", "running");
    expect((await h.relay.sweep()).fired).toBe(0);
    h.tasks.set("gc-b", "blocked");
    expect((await h.relay.sweep()).fired).toBe(1);
    expect(h.sent.at(-1)!.text).toMatch(/gc-a — accepted, gc-b — blocked/);
    h.tick(41 * 60_000);
    expect((await h.relay.sweep()).fired).toBe(0);
  });
});
