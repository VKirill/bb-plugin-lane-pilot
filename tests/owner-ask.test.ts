import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createOwnerAsk, OWNER_ASK_OPEN_GRACE_MS } from "../src/rooms/relay/server/owner-ask";
import { buildOwnerAskPayload, ownerAnswerText, ownerAskPayloadSchema, ownerAskTitle, resolveOwnerResponse } from "../src/rooms/relay/owner-ask";
import { IntegrationGateRunner } from "../src/server/integration-gate";
import { askOwnerToJoin } from "../src/rooms/council/server/council";

afterEach(() => { vi.useRealTimers(); });

function host() {
  const made = createFakePluginHost({ pluginId: "lane-pilot" });
  const ownerAsk = createOwnerAsk(made.bb, () => undefined);
  return { ...made, ownerAsk };
}

describe("the form's contract (H8)", () => {
  it("numbers the options, keeps the question as the push title and reads the answer back", () => {
    const payload = buildOwnerAskPayload({ source: "gate", question: "Gate is red.\nSecond line", options: ["Fix it", "  ", "Leave it"], detail: "log" });
    expect(ownerAskPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.options).toEqual([{ id: "1", label: "Fix it" }, { id: "2", label: "Leave it" }]);
    expect(payload.allowText).toBe(true);
    expect(ownerAskTitle(payload)).toBe("Gate is red.");
    expect(ownerAnswerText(resolveOwnerResponse(payload, { choice: "2", text: " but wait " }))).toBe("Leave it — but wait");
    expect(resolveOwnerResponse(payload, { choice: "9" }).choice).toBeNull();
    expect(buildOwnerAskPayload({ source: "pm", question: "q", options: ["a"], allowText: false }).allowText).toBe(false);
    expect(buildOwnerAskPayload({ source: "pm", question: "q", allowText: false }).allowText).toBe(true);
    expect(ownerAskTitle(buildOwnerAskPayload({ source: "pm", question: "x".repeat(500) })).length).toBeLessThanOrEqual(160);
  });
});

describe("questions to the owner as BB pending interactions (H8)", () => {
  it("opens a form in the thread and returns what the owner chose and wrote", async () => {
    const { harness, ownerAsk } = host();
    const asked = ownerAsk.ask("thr_pm", { source: "pm", question: "Ship the migration?", options: ["Yes", "No"] });
    expect(harness.pendingInteractions).toHaveLength(1);
    const form = harness.pendingInteractions[0]!;
    expect(form).toMatchObject({ threadId: "thr_pm", rendererId: "lane-pilot-ask", title: "Ship the migration?" });
    expect(form.payload).toMatchObject({ v: 1, source: "pm", options: [{ id: "1", label: "Yes" }, { id: "2", label: "No" }], allowText: true });
    harness.behavior.submitInteraction(form.id, { choice: "1", text: "after the release" });
    expect(await asked).toEqual({ outcome: "answered", choice: { id: "1", label: "Yes" }, text: "after the release", line: "Yes — after the release" });
  });

  it("reports a dismissed form, an empty answer and a timeout as cancelled", async () => {
    const { harness, ownerAsk } = host();
    const dismissed = ownerAsk.ask("thr_a", { source: "pm", question: "q" });
    harness.behavior.cancelInteraction(harness.pendingInteractions[0]!.id);
    expect(await dismissed).toEqual({ outcome: "cancelled", reason: "user" });
    const empty = ownerAsk.ask("thr_a", { source: "pm", question: "q" });
    harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { text: "  " });
    expect(await empty).toEqual({ outcome: "cancelled", reason: "empty_answer" });
    vi.useFakeTimers();
    const slow = ownerAsk.ask("thr_a", { source: "pm", question: "q" }, { timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await slow).toEqual({ outcome: "cancelled", reason: "timeout" });
  });

  it("opens one form per thread; a second question is «unavailable» so the caller can say it in text", async () => {
    const { harness, ownerAsk } = host();
    const first = ownerAsk.ask("thr_pm", { source: "pm", question: "one" });
    const second = await ownerAsk.ask("thr_pm", { source: "gate", question: "two" });
    expect(second).toMatchObject({ outcome: "unavailable" });
    const other = ownerAsk.ask("thr_other", { source: "pm", question: "three" });
    expect(harness.pendingInteractions).toHaveLength(2);
    harness.behavior.cancelInteraction(harness.pendingInteractions[0]!.id);
    await first;
    // The thread is free again.
    const again = ownerAsk.ask("thr_pm", { source: "pm", question: "four" });
    expect(harness.pendingInteractions.some((row) => row.title === "four")).toBe(true);
    for (const row of harness.pendingInteractions) harness.behavior.cancelInteraction(row.id);
    await Promise.all([other, again]);
  });

  it("is unavailable on a BB without bb.ui.requestInput", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const ownerAsk = createOwnerAsk({ ...bb, ui: undefined } as unknown as typeof bb, () => undefined);
    expect(ownerAsk.available()).toBe(false);
    expect(await ownerAsk.ask("thr", { source: "pm", question: "q" })).toMatchObject({ outcome: "unavailable" });
    expect(await ownerAsk.askInBackground("thr", { source: "pm", question: "q" }, () => { throw new Error("never"); })).toBe(false);
  });

  it("askInBackground says the form is open, then hands the answer to the callback", async () => {
    const { harness, ownerAsk } = host();
    const settled: unknown[] = [];
    const opened = await ownerAsk.askInBackground("thr_pm", { source: "council", question: "Add a point?", options: ["Decide"] }, (answer) => { settled.push(answer); });
    expect(opened).toBe(true);
    expect(settled).toEqual([]);
    harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { choice: "1" });
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    expect(settled[0]).toMatchObject({ outcome: "answered", line: "Decide" });
  });

  it("askInBackground does not call back for a form lost to a withdrawal or a reload, and is false when BB refused the form", async () => {
    const { harness, ownerAsk } = host();
    const settled: unknown[] = [];
    const withdrawn = new AbortController();
    await ownerAsk.askInBackground("thr_a", { source: "council", question: "q" }, (answer) => { settled.push(answer); }, { signal: withdrawn.signal });
    withdrawn.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toEqual([]);
    expect(harness.pendingInteractions).toHaveLength(0);
    // A refused form (here: a thread that already has one) is reported at once.
    const blocker = ownerAsk.ask("thr_b", { source: "pm", question: "first" });
    const started = Date.now();
    expect(await ownerAsk.askInBackground("thr_b", { source: "gate", question: "second" }, (answer) => { settled.push(answer); })).toBe(false);
    expect(Date.now() - started).toBeLessThan(OWNER_ASK_OPEN_GRACE_MS);
    harness.behavior.cancelInteraction(harness.pendingInteractions[0]!.id);
    await blocker;
    expect(settled).toEqual([]);
  });

  it("a user's dismissal and a timeout are reported to the asking thread as messages", async () => {
    const { ownerAsk } = host();
    const question = "Gate is red. What now?";
    expect(ownerAsk.answerMessage(question, { outcome: "answered", choice: null, text: "revert it", line: "revert it" })).toBe("Lane Pilot: the owner answered «Gate is red. What now?»: revert it");
    expect(ownerAsk.answerMessage(question, { outcome: "cancelled", reason: "timeout" }, 3_600_000)).toContain("did not answer");
    expect(ownerAsk.answerMessage(question, { outcome: "cancelled", reason: "user" })).toContain("dismissed");
  });
});

describe("lane_pilot_ask_owner (H8)", () => {
  async function pmHost(role = "pm") {
    const made = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { getPluginMetadata: async () => ({ role, lanePilotRunId: "run-x" }) } } as never });
    await plugin(made.bb);
    return made;
  }

  it("holds a form for the owner and returns the answer to the PM", async () => {
    const { harness } = await pmHost();
    const called = harness.behavior.callAgentTool("lane_pilot_ask_owner", { question: "Which payment provider?", options: ["Stripe", "Cloudpayments"], detail: "context" },
      { threadId: "thr_pm", projectId: "proj_1" });
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    const form = harness.pendingInteractions[0]!;
    expect(form).toMatchObject({ threadId: "thr_pm", rendererId: "lane-pilot-ask", title: "Which payment provider?" });
    harness.behavior.submitInteraction(form.id, { choice: "2" });
    expect(JSON.parse(String(await called))).toEqual({ answered: true, choice: "Cloudpayments", text: "" });
  });

  it("tells the PM when the owner dismissed the form, and refuses a thread that is not a PM", async () => {
    const { harness } = await pmHost();
    const called = harness.behavior.callAgentTool("lane_pilot_ask_owner", { question: "Delete the old data?" }, { threadId: "thr_pm", projectId: "proj_1" });
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    harness.behavior.cancelInteraction(harness.pendingInteractions[0]!.id);
    expect(JSON.parse(String(await called))).toMatchObject({ answered: false, reason: "user" });

    const writer = await pmHost("writer");
    const refused = JSON.parse(String(await writer.harness.behavior.callAgentTool("lane_pilot_ask_owner", { question: "q" }, { threadId: "thr_w", projectId: "proj_1" })));
    expect(refused.error.code).toBe("not_pm_thread");
    expect(writer.harness.pendingInteractions).toHaveLength(0);
  });

  it("says owner_question_unavailable when a form is already open in the chat", async () => {
    const { harness } = await pmHost();
    const first = harness.behavior.callAgentTool("lane_pilot_ask_owner", { question: "first" }, { threadId: "thr_pm", projectId: "proj_1" });
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    const second = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_ask_owner", { question: "second" }, { threadId: "thr_pm", projectId: "proj_1" })));
    expect(second.error.code).toBe("owner_question_unavailable");
    harness.behavior.cancelInteraction(harness.pendingInteractions[0]!.id);
    await first;
  });
});

describe("the integration gate asks the owner when no culprit can be named (H8)", () => {
  function gate(over: { ownerAsk?: unknown } = {}) {
    const sent: Array<{ threadId: string; text: string }> = [];
    const send = async (input: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: input.threadId, text: input.input[0]!.text }); };
    const made = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { send } } as never });
    const ownerAsk = createOwnerAsk(made.bb, () => undefined);
    const ctx = { bb: { sdk: { threads: { send } } }, ownerAsk: "ownerAsk" in over ? over.ownerAsk : ownerAsk, log: () => undefined };
    const runner = new IntegrationGateRunner(ctx as never, {} as never);
    const tell = (runner as unknown as { tellPm: (thread: string, text: string, ask: { question: string; detail: string; options: string[] }) => Promise<void> }).tellPm.bind(runner);
    return { made, tell, sent };
  }
  const ask = { question: "Gate `npm test` is red and no single task is to blame. What should the PM do?", detail: "log", options: ["Investigate and fix it", "Leave it, I will look myself"] };

  it("opens a form in the PM chat, says so in the PM's message, and forwards the answer as a message", async () => {
    const { made, tell, sent } = gate();
    await tell("thr_pm", "Lane Pilot: integration gate failed.", ask);
    expect(made.harness.pendingInteractions).toHaveLength(1);
    expect(made.harness.pendingInteractions[0]).toMatchObject({ threadId: "thr_pm", rendererId: "lane-pilot-ask" });
    expect(sent).toEqual([{ threadId: "thr_pm", text: "Lane Pilot: integration gate failed. The owner was asked what to do; the answer arrives in this chat." }]);
    made.harness.behavior.submitInteraction(made.harness.pendingInteractions[0]!.id, { choice: "1" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.text).toContain("the owner answered");
    expect(sent[1]!.text).toContain("Investigate and fix it");
  });

  it("falls back to the plain message when no form can open", async () => {
    const { tell, sent } = gate({ ownerAsk: undefined });
    await tell("thr_pm", "Lane Pilot: integration gate failed.", ask);
    expect(sent).toEqual([{ threadId: "thr_pm", text: "Lane Pilot: integration gate failed." }]);
  });
});

describe("a council room waiting for the owner opens a form in the PM chat (H8)", () => {
  const room = (ownerAsk: ReturnType<typeof createOwnerAsk> | undefined) => {
    const words: string[] = [];
    let decided = 0;
    const withdraw = askOwnerToJoin(ownerAsk, { pmThreadId: "thr_pm", question: "The council «Q» waits for you.", detail: "product: hi", timeoutMs: 600_000,
      onWords: (text) => words.push(text), onDecide: () => { decided += 1; } });
    return { words, decided: () => decided, withdraw };
  };

  it("turns a typed word into feed words and the button into a decision request", async () => {
    const { harness, ownerAsk } = host();
    const typed = room(ownerAsk);
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    expect(harness.pendingInteractions[0]).toMatchObject({ threadId: "thr_pm", rendererId: "lane-pilot-ask" });
    harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { text: "Skeptic, what about prices?" });
    await vi.waitFor(() => expect(typed.words).toEqual(["Skeptic, what about prices?"]));
    expect(typed.decided()).toBe(0);
    const decide = room(ownerAsk);
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { choice: "1" });
    await vi.waitFor(() => expect(decide.decided()).toBe(1));
    expect(decide.words).toEqual([]);
  });

  it("withdraws the form when the wait ends another way, and does nothing without question forms", async () => {
    const { harness, ownerAsk } = host();
    const open = room(ownerAsk);
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    open.withdraw();
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(0));
    expect(open.words).toEqual([]);
    expect(() => room(undefined).withdraw()).not.toThrow();
  });
});

describe("thread lifecycle events do not disturb an open form (H8)", () => {
  it("a thread event for the asked thread leaves the form open", async () => {
    const { harness, ownerAsk } = host();
    const asked = ownerAsk.ask("thr_pm", { source: "pm", question: "q" });
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_pm" }), lastAssistantText: null });
    expect(harness.pendingInteractions).toHaveLength(1);
    harness.behavior.cancelInteraction(harness.pendingInteractions[0]!.id);
    await asked;
  });
});

describe("a question lost to a reload (H8, audit B3)", () => {
  /** A BB whose form is cancelled by the reload (reason plugin-disposed) or by the owner, and a KV the next instance shares. */
  function reloadHost(reason: string) {
    const sent: Array<{ threadId: string; text: string }> = [];
    const send = async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return {}; };
    const made = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { send } } as never });
    (made.bb as unknown as { ui: unknown }).ui = { requestInput: async () => ({ outcome: "cancelled", reason }) };
    const logs: string[] = [];
    return { ...made, sent, logs, ownerAsk: createOwnerAsk(made.bb, (line) => logs.push(line)) };
  }

  it("keeps the question when the reload took the form, and the next instance tells the chat", async () => {
    const { bb, ownerAsk, sent } = reloadHost("plugin-disposed");
    expect(await ownerAsk.ask("thr_pm", { source: "pm", question: "Ship the migration?\nsecond line" })).toEqual({ outcome: "cancelled", reason: "plugin-disposed" });
    // The new instance: no form of its own is open in that chat, the old one's record is.
    const next = createOwnerAsk(bb, () => undefined);
    expect(await next.pending("thr_pm")).toBe(true);
    expect(await next.recoverLost()).toEqual(["thr_pm"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.threadId).toBe("thr_pm");
    expect(sent[0]!.text).toContain("«Ship the migration?»");
    expect(sent[0]!.text).toContain("lost when Lane Pilot reloaded");
    expect(await next.pending("thr_pm")).toBe(false);
    expect(await next.recoverLost()).toEqual([]);
  });

  it("forgets a question the owner dismissed, and one the chat itself ended", async () => {
    for (const reason of ["user", "timeout", "thread-stopped", "thread-deleted"]) {
      const { ownerAsk, sent } = reloadHost(reason);
      await ownerAsk.ask("thr_pm", { source: "pm", question: "q" });
      expect(await ownerAsk.pending("thr_pm"), reason).toBe(false);
      expect(await ownerAsk.recoverLost(), reason).toEqual([]);
      expect(sent, reason).toEqual([]);
    }
  });

  it("an open form is pending while it waits", async () => {
    const { harness, ownerAsk } = host();
    const asked = ownerAsk.ask("thr_pm", { source: "pm", question: "q" });
    expect(await ownerAsk.pending("thr_pm")).toBe(true);
    expect(await ownerAsk.pending("thr_other")).toBe(false);
    harness.behavior.submitInteraction(harness.pendingInteractions[0]!.id, { text: "yes" });
    await asked;
    expect(await ownerAsk.pending("thr_pm")).toBe(false);
  });
});
