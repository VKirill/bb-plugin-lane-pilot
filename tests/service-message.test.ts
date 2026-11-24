import { describe, expect, it } from "vitest";
import { sendServiceMessage } from "../src/rooms/platform/server/service-message";

function api(fail?: (args: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    bb: { sdk: { threads: { send: async (args: Record<string, unknown>) => { calls.push(args); const error = fail?.(args); if (error) throw error; return { ok: true }; } } } } as never,
  };
}

// The real wire shape (apps/server ApiError → toResponse body): status on the error, {code,message,details} in body.
const apiError = (status: number, code: string, message: string, details?: unknown) =>
  Object.assign(new Error(message), { status, body: { code, message, ...(details === undefined ? {} : { details }) } });
const senderGone = (reason: "not_found" | "deleted" = "not_found") =>
  apiError(400, "parent_thread_invalid", "Sender thread is invalid", { reason, subject: "sender" });

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
    const { bb, calls } = api((args) => "senderThreadId" in args ? senderGone() : null);
    await sendServiceMessage(bb, { threadId: "pm", text: "hello", senderThreadId: "gone" });
    expect(calls).toHaveLength(2);
    expect("senderThreadId" in calls[1]!).toBe(false);
  });

  it("rethrows every rejection that is not exactly a gone sender thread", async () => {
    // A plugin's dispatch_rejected (409) may mention the sender thread in its message; the anonymous retry must not bypass it.
    const dispatch = api((args) => "senderThreadId" in args
      ? apiError(409, "dispatch_rejected", "plugin lane-guard refused: sender thread thr_gone may not write here", { pluginId: "lane-guard" })
      : null);
    await expect(sendServiceMessage(dispatch.bb, { threadId: "pm", text: "hello", senderThreadId: "gone" })).rejects.toThrow("lane-guard");
    expect(dispatch.calls).toHaveLength(1);
    // parent_thread_invalid for the PARENT subject, other reasons, other statuses: none of them is a gone sender.
    for (const cause of [
      apiError(400, "parent_thread_invalid", "Parent thread is invalid", { reason: "not_found", subject: "parent" }),
      apiError(400, "parent_thread_invalid", "Sender thread is invalid", { reason: "self", subject: "sender" }),
      apiError(400, "parent_thread_invalid", "Sender thread is invalid", { reason: "cycle", subject: "sender" }),
      apiError(500, "parent_thread_invalid", "Sender thread is invalid", { reason: "not_found", subject: "sender" }),
      apiError(400, "thread_not_writable", "Sender thread is invalid", { reason: "not_found", subject: "sender" }),
      new Error("parent_thread_invalid sender thread"),
    ]) {
      const { bb, calls } = api(() => cause);
      await expect(sendServiceMessage(bb, { threadId: "pm", text: "hello", senderThreadId: "gone" })).rejects.toBe(cause);
      expect(calls).toHaveLength(1);
    }
    // The two real sender reasons both fall back.
    for (const reason of ["not_found", "deleted"] as const) {
      const { bb, calls } = api((args) => "senderThreadId" in args ? senderGone(reason) : null);
      await sendServiceMessage(bb, { threadId: "pm", text: "hello", senderThreadId: "gone" });
      expect(calls).toHaveLength(2);
      expect("senderThreadId" in calls[1]!).toBe(false);
    }
  });

  it("marks every sender-less send so BB's initiator:user record never reads it as the owner's words", async () => {
    const { bb, calls } = api();
    await sendServiceMessage(bb, { threadId: "pm", text: "hello" });
    expect((calls[0]!.input as Array<{ text: string }>)[0]!.text).toBe("[Lane Pilot service] hello");
    // A bracketed machine form is already unmistakable: no double marker.
    const bracketed = api();
    await sendServiceMessage(bracketed.bb, { threadId: "pm", text: "[Lane Pilot phase] note" });
    expect((bracketed.calls[0]!.input as Array<{ text: string }>)[0]!.text).toBe("[Lane Pilot phase] note");
    // A rejected sender falls back to the marked anonymous send, not the bare text.
    const fallback = api((args) => "senderThreadId" in args ? senderGone() : null);
    await sendServiceMessage(fallback.bb, { threadId: "pm", text: "hello", senderThreadId: "gone" });
    expect((fallback.calls[1]!.input as Array<{ text: string }>)[0]!.text).toBe("[Lane Pilot service] hello");
    // A live sender keeps the original text: the agent envelope carries provenance instead.
    const authored = api();
    await sendServiceMessage(authored.bb, { threadId: "pm", text: "hi", senderThreadId: "writer" });
    expect((authored.calls[0]!.input as Array<{ text: string }>)[0]!.text).toBe("hi");
  });

  it("goes as BB's titled system notice when the core offers it, and a gone sender falls back to it too", async () => {
    const notices: Array<Record<string, unknown>> = [];
    const sends: Array<Record<string, unknown>> = [];
    const bb = { sdk: { threads: {
      send: async (args: Record<string, unknown>) => { sends.push(args); if (args.senderThreadId) throw senderGone(); return { ok: true }; },
      experimental_vkSystemNotice: async (args: Record<string, unknown>) => { notices.push(args); return true; },
    } } } as never;
    expect(await sendServiceMessage(bb, { threadId: "pm", text: "Run ended", label: "Lane Pilot · errand" })).toBe(true);
    await sendServiceMessage(bb, { threadId: "pm", text: "plain" });
    await sendServiceMessage(bb, { threadId: "pm", text: "now", mode: "steer-if-active" });
    await sendServiceMessage(bb, { threadId: "pm", text: "from writer", senderThreadId: "gone" });
    expect(notices).toEqual([
      { threadId: "pm", text: "Run ended", label: "Lane Pilot · errand", mode: "queue" },
      { threadId: "pm", text: "plain", label: "Lane Pilot", mode: "queue" },
      { threadId: "pm", text: "now", label: "Lane Pilot", mode: "steer" },
      { threadId: "pm", text: "from writer", label: "Lane Pilot", mode: "queue" },
    ]);
    // Only the authored attempt went through send; nothing sender-less was recorded as the owner's words.
    expect(sends.map((call) => call.senderThreadId)).toEqual(["gone"]);
  });

  it("does not hide any other failure", async () => {
    const { bb, calls } = api(() => new Error("HTTP 502: host offline"));
    await expect(sendServiceMessage(bb, { threadId: "pm", text: "hello", senderThreadId: "writer" })).rejects.toThrow("host offline");
    expect(calls).toHaveLength(1);
  });
});
