import { describe, expect, it } from "vitest";
import { createRelay, type RelayItem, type RelayReminder } from "../src/rooms/relay/server/relay";

function harness() {
  let items:RelayItem[] = [];
  let now = 10_000_000;
  const sent:Array<{ threadId:string; text:string }> = [];
  const relay = createRelay({
    load:async () => structuredClone(items),
    save:async (next) => { items = structuredClone(next); },
    send:async (threadId, text) => { sent.push({ threadId, text }); },
    settled:async () => false,
    output:async () => "",
    taskStates:async () => ({}),
    now:() => now,
    log:() => undefined,
  });
  return {
    relay, sent,
    tick:(ms:number) => { now += ms; },
    items:() => items,
  };
}

async function fireDue(h:ReturnType<typeof harness>, inMinutes:number) {
  h.tick(inMinutes * 60_000);
  expect((await h.relay.sweep()).fired).toBe(1);
}

const timeOnly = (h:ReturnType<typeof harness>):RelayReminder[] =>
  h.items().filter((row):row is RelayReminder => row.kind === "remind" && !row.watchThreadId && !row.taskIds?.length);

describe("time-only reminder caps", () => {
  it("refuses a time-only reminder longer than 120 minutes", async () => {
    const h = harness();
    await expect(h.relay.remind({ projectId:"P", threadId:"pm", note:"check later", inMinutes:121 }))
      .rejects.toThrow(/a wait longer than 2 hours on nothing Lane Pilot can see — tell the owner what you wait for and end the turn, or use lane_pilot_schedule for a recurring check/);
    expect(h.items()).toEqual([]);
  });

  it("allows a time-only reminder of 120 minutes", async () => {
    const h = harness();
    const item = await h.relay.remind({ projectId:"P", threadId:"pm", note:"check in two hours", inMinutes:120 });
    expect(item.chainDepth).toBe(1);
    expect(item.dueAt - 10_000_000).toBe(120 * 60_000);
  });

  it("allows a taskIds reminder of 300 minutes", async () => {
    const h = harness();
    const item = await h.relay.remind({ projectId:"P", threadId:"pm", note:"when merged, ship", inMinutes:300, taskIds:["t1"] });
    expect(item.taskIds).toEqual(["t1"]);
    expect(item.chainDepth).toBeUndefined();
  });

  it("allows a watch reminder of 300 minutes", async () => {
    const h = harness();
    const item = await h.relay.remind({ projectId:"P", threadId:"pm", note:"when holder settles", inMinutes:300, watchThreadId:"holder" });
    expect(item.watchThreadId).toBe("holder");
    expect(item.chainDepth).toBeUndefined();
  });

  it("refuses the third time-only reminder in a chain", async () => {
    const h = harness();
    await h.relay.remind({ projectId:"P", threadId:"pm", note:"first", inMinutes:1 });
    await fireDue(h, 1);
    expect(timeOnly(h).at(-1)!.firedBy).toBe("time");

    await h.relay.remind({ projectId:"P", threadId:"pm", note:"second", inMinutes:1 });
    expect(timeOnly(h).filter((row) => !row.firedAt).at(-1)!.chainDepth).toBe(2);
    await fireDue(h, 1);

    await expect(h.relay.remind({ projectId:"P", threadId:"pm", note:"third", inMinutes:1 }))
      .rejects.toThrow(/three reminders in a row without progress — tell the owner what you tried and what to decide/);
  });

  it("resets the chain more than 15 minutes after the last time-fired reminder", async () => {
    const h = harness();
    await h.relay.remind({ projectId:"P", threadId:"pm", note:"first", inMinutes:1 });
    await fireDue(h, 1);
    h.tick(15 * 60_000 + 1);
    const next = await h.relay.remind({ projectId:"P", threadId:"pm", note:"fresh chain", inMinutes:5 });
    expect(next.chainDepth).toBe(1);
  });

  it("returns the open twin before refusing a long time-only wait", async () => {
    const h = harness();
    const first = await h.relay.remind({ projectId:"P", threadId:"pm", note:"same wait", inMinutes:120 });
    const again = await h.relay.remind({ projectId:"P", threadId:"pm", note:"same wait", inMinutes:121 });
    expect(again.id).toBe(first.id);
  });
});
