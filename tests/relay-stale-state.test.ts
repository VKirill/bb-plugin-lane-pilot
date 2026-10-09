import { describe, expect, it } from "vitest";
import { createRelay, type RelayItem } from "../src/rooms/relay/server/relay";

/**
 * Live 2026-10-09 (SelfyStudio PM): a reminder on `fix-marketing-greeting-cards-tests.2` arrived saying «blocked» eight seconds after
 * the PM had answered the writer, when the task was running again. The sweep read the state while the task was blocked, the
 * PM's thread was in a turn, and the text waited in BB's queue behind that turn with the state it was written with.
 */
function harness(options: { busy?: (threadId: string) => boolean } = {}) {
  let items: RelayItem[] = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const reads: Array<Record<string, string | null>> = [];
  let states: Array<Record<string, string | null>> = [];
  const relay = createRelay({
    load: async () => structuredClone(items),
    save: async (next) => { items = structuredClone(next); },
    send: async (threadId, text) => { sent.push({ threadId, text }); },
    settled: async () => false,
    output: async () => "",
    // Each read takes the next scripted answer; the last one repeats.
    taskStates: async () => { const next = states.length > 1 ? states.shift()! : states[0]!; reads.push(next); return next; },
    ...(options.busy ? { busy: async (threadId: string) => options.busy!(threadId) } : {}),
    now: () => 1_000_000,
    log: () => undefined,
  });
  return { relay, sent, reads, items: () => items, script: (...answers: Array<Record<string, string | null>>) => { states = [...answers]; } };
}

const open = (h: ReturnType<typeof harness>) => h.items().filter((row) => row.kind === "remind" && !row.firedAt);

describe("a reminder on tasks does not report a state that no longer holds", () => {
  it("reads the live state at send time: a task that is running again again sends nothing, and the reminder stays open", async () => {
    const h = harness();
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "ship when accepted", inMinutes: 180, taskIds: ["fix.2"] });
    // The sweep sees «blocked»; the PM answers the writer; the read just before the send sees «running».
    h.script({ "fix.2": "blocked" }, { "fix.2": "running" });

    expect((await h.relay.sweep()).fired).toBe(0);

    expect(h.sent).toEqual([]);
    expect(open(h)).toHaveLength(1);
  });

  it("sends the live states when they still hold", async () => {
    const h = harness();
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "ship when accepted", inMinutes: 180, taskIds: ["fix.2"] });
    h.script({ "fix.2": "blocked" });

    expect((await h.relay.sweep()).fired).toBe(1);

    expect(h.sent.at(-1)!.text).toContain("fix.2 — blocked");
    expect(open(h)).toHaveLength(0);
  });

  it("waits while the thread to wake is in a turn: the text would arrive behind that turn with an old state", async () => {
    let busy = true;
    const h = harness({ busy: () => busy });
    await h.relay.remind({ projectId: "P", threadId: "pm", note: "ship when accepted", inMinutes: 180, taskIds: ["fix.2"] });
    h.script({ "fix.2": "blocked" });

    expect((await h.relay.sweep()).fired).toBe(0);
    expect(h.sent).toEqual([]);
    expect(open(h)).toHaveLength(1);

    // The PM's turn ended, the writer is working again: nothing to say, the reminder keeps waiting for it.
    busy = false;
    h.script({ "fix.2": "running" });
    expect((await h.relay.sweep()).fired).toBe(0);
    expect(open(h)).toHaveLength(1);

    // Blocked for real and the PM idle: it is told, with the state as it is.
    h.script({ "fix.2": "blocked" });
    expect((await h.relay.sweep()).fired).toBe(1);
    expect(h.sent.at(-1)!.text).toContain("fix.2 — blocked");
  });
});
