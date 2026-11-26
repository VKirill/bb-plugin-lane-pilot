import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import type { RelayItem } from "../../src/rooms/relay/models/relay";
import { createRelay } from "../../src/rooms/relay/server/services/relay";
import { EVENT_FIELDS, taskEventBody } from "../../src/rooms/relay/models/outbound";
import { postEvent } from "../../src/rooms/relay/server/services/outbound";

function open() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
    getPluginMetadata: async () => null,
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "P" }),
  } } as never });
  const db = openDatabase(bb);
  return { bb, harness, db };
}

describe("region 20 relay: one window asks another", () => {
  function relayWorld() {
    let items: RelayItem[] = [];
    const sent: Array<{ threadId: string; text: string }> = [];
    const relay = createRelay({
      load: async () => structuredClone(items), save: async (next) => { items = structuredClone(next); },
      send: async (threadId, text) => { sent.push({ threadId, text }); },
      settled: async () => true, output: async () => "", taskStates: async () => ({}), now: () => 1_000_000, log: () => undefined,
    });
    return { relay, sent, items: () => items };
  }

  it("[sma:k_v_ask] the question reaches the asked window and nobody else, a repeat is not sent twice, only the asked window can answer and the asker gets the answer", async () => {
    const w = relayWorld();
    const ask = await w.relay.ask({ projectId: "P", fromThreadId: "thr_pm", toThreadId: "thr_writer", question: "Which files do you hold?" });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.threadId).toBe("thr_writer");
    expect(w.sent[0]!.text).toContain("Which files do you hold?");
    expect(w.sent[0]!.text).toContain(ask.id);
    expect(w.items()).toMatchObject([{ kind: "ask", fromThreadId: "thr_pm", toThreadId: "thr_writer", answeredAt: null }]);
    const again = await w.relay.ask({ projectId: "P", fromThreadId: "thr_pm", toThreadId: "thr_writer", question: "Which files do you hold?" });
    expect(again.alreadyWaiting).toBe(true);
    expect(w.sent).toHaveLength(1);
    await expect(w.relay.ask({ projectId: "P", fromThreadId: "thr_pm", toThreadId: "thr_pm", question: "me?" })).rejects.toThrow(/itself/);
    await expect(w.relay.reply({ askId: ask.id, fromThreadId: "thr_other", answer: "mine" })).rejects.toThrow(/only the asked/);
    await w.relay.reply({ askId: ask.id, fromThreadId: "thr_writer", answer: "src/** until 14:00" });
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]!.threadId).toBe("thr_pm");
    expect(w.sent[1]!.text).toContain("src/** until 14:00");
    expect(w.items()[0]).toMatchObject({ answeredAt: 1_000_000 });
  });
});

describe("region 20 outward status", () => {
  const WEBHOOK = "https://hooks.example/lp";
  afterEach(() => vi.restoreAllMocks());

  it("[sma:k_lib_snapshot] the outward body has exactly the nine listed fields in order, each clipped to 200 characters, and nothing the caller adds", () => {
    const body = taskEventBody({ event: "task.accepted", projectId: "P", runId: "r1", taskId: "t1", title: "x".repeat(500), kind: "bb", state: "accepted", attempt: 3, at: 1700000000000,
      contract: { owns_paths: ["secret/**"] }, output: "stdout", path: "/home/ubuntu/x" });
    expect(Object.keys(body)).toEqual([...EVENT_FIELDS]);
    expect(Object.keys(body)).toHaveLength(9);
    expect(body.title).toBe("x".repeat(200));
    expect(body.attempt).toBe(3);
    expect(body.at).toBe(1700000000000);
    expect(taskEventBody({ event: "owner.waiting" })).toEqual({ event: "owner.waiting", projectId: null, runId: null, taskId: null, title: null, kind: null, state: null, attempt: null, at: null });
  });

  it("[sma:k_v_snapshot] a status event is posted to the project's https webhook with the nine fields only; an http address, no address, and a project of another address post nothing", async () => {
    const { db } = open();
    const post = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    saveProjectSetting(db, "P", "events.webhook_url", "http://hooks.example/lp");
    expect(await postEvent(db, "P", { event: "owner.waiting", state: "waiting" })).toBe(false);
    expect(await postEvent(db, "Q", { event: "owner.waiting", state: "waiting" })).toBe(false);
    expect(post).not.toHaveBeenCalled();
    saveProjectSetting(db, "P", "events.webhook_url", WEBHOOK);
    expect(await postEvent(db, "P", { event: "owner.waiting", state: "waiting", title: "needs you", projectId: "EVIL", contract: { secret: 1 }, output: "leak" }, () => undefined)).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, init] = post.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    expect((init as RequestInit).method).toBe("POST");
    const sent = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual([...EVENT_FIELDS]);
    expect(sent).toMatchObject({ event: "owner.waiting", projectId: "P", state: "waiting", title: "needs you", runId: null });
    expect(typeof sent.at).toBe("number");
    expect(JSON.stringify(sent)).not.toMatch(/secret|leak/);
  });
});
