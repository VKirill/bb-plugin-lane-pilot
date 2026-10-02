import { describe, expect, it } from "vitest";
import { createRelay, RELAY_LIMITS, type RelayItem } from "../../src/server/relay";

function harness() {
  let items: RelayItem[] = [];
  let now = 1_000_000;
  const sent: Array<{ threadId:string; text:string }> = [];
  const status = new Map<string, string>();
  const queued = new Map<string, number>();
  const relay = createRelay({
    load:async () => structuredClone(items),
    save:async (next) => { items = structuredClone(next); },
    send:async (threadId, text) => { sent.push({ threadId, text }); },
    settled:async (threadId) => status.get(threadId) === "idle" && !(queued.get(threadId) ?? 0),
    output:async () => "I hold the base checkout until 13:40",
    now:() => now,
    log:() => undefined,
  });
  return { relay, sent, status, queued, items:() => items, tick:(ms:number) => { now += ms; } };
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
      await h.relay.ask({ projectId:"P", fromThreadId:index % 2 ? "a" : "b", toThreadId:index % 2 ? "b" : "a", question:"?" });
    }
    await expect(h.relay.ask({ projectId:"P", fromThreadId:"a", toThreadId:"b", question:"?" })).rejects.toThrow(/relay limit/);
    await expect(h.relay.ask({ projectId:"P", fromThreadId:"a", toThreadId:"a", question:"?" })).rejects.toThrow(/itself/);
    const reminder = await h.relay.remind({ projectId:"P", threadId:"pm", note:"n", inMinutes:1 });
    expect(await h.relay.cancel({ threadId:"pm", reminderId:reminder.id })).toBe(true);
    h.tick(120_000);
    expect((await h.relay.sweep()).fired).toBe(0);
  });
});
