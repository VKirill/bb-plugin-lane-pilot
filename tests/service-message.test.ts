import { describe, expect, it } from "vitest";
import { sendServiceMessage } from "../src/rooms/relay/server/service-message";

function api(fail?: (args: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    bb: { sdk: { threads: { send: async (args: Record<string, unknown>) => { calls.push(args); const error = fail?.(args); if (error) throw error; return { ok: true }; } } } } as never,
  };
}

const senderInvalid = () => Object.assign(new Error("HTTP 400: Sender thread is invalid"), { code: "parent_thread_invalid", status: 400 });

describe("service messages", () => {
  it("carry the author thread and keep the message shape", async () => {
    const { bb, calls } = api();
    await sendServiceMessage(bb, { threadId: "pm", text: "hello", senderThreadId: "writer" });
    expect(calls).toEqual([{ threadId: "pm", mode: "queue-if-active", senderThreadId: "writer", input: [{ type: "text", text: "hello", mentions: [] }] }]);
  });

  it("send without an author when none is named or it is the receiver itself", async () => {
    const { bb, calls } = api();
    await sendServiceMessage(bb, { threadId: "pm", text: "a" });
    await sendServiceMessage(bb, { threadId: "pm", text: "b", senderThreadId: "pm" });
    await sendServiceMessage(bb, { threadId: "w", text: "c", mode: "steer-if-active", senderThreadId: null });
    expect(calls.map((call) => "senderThreadId" in call)).toEqual([false, false, false]);
    expect(calls[2]).toMatchObject({ mode: "steer-if-active" });
  });

  it("falls back to no author when BB rejects the sender thread, so the message is not lost", async () => {
    const { bb, calls } = api((args) => "senderThreadId" in args ? senderInvalid() : null);
    await sendServiceMessage(bb, { threadId: "pm", text: "hello", senderThreadId: "gone" });
    expect(calls).toHaveLength(2);
    expect("senderThreadId" in calls[1]!).toBe(false);
  });

  it("does not hide any other failure", async () => {
    const { bb, calls } = api(() => new Error("HTTP 502: host offline"));
    await expect(sendServiceMessage(bb, { threadId: "pm", text: "hello", senderThreadId: "writer" })).rejects.toThrow("host offline");
    expect(calls).toHaveLength(1);
  });
});
