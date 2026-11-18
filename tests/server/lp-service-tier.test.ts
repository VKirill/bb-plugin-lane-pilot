import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { lanePilotOwnedTarget, lpStandardTierAdmission, withStandardServiceTier } from "../../src/rooms/platform/server/lp-service-tier";
import { fullAccessSpawn } from "../../src/rooms/platform/server/pm-spawn";
import { mountNativeWiring } from "../../src/rooms/core/server/native-wiring";
import { createRun, openDatabase } from "../../src/rooms/plugin-db";
import { openRunOfPmThread } from "../../src/rooms/storage/runs-store";
import { nativeThreadKey } from "../../src/rooms/contracts";
import { nativeSelectionSchema } from "../../src/rooms/contracts/native-selection";
import { nativeSelectionMarker } from "../../src/rooms/native-agent/native-session";

const selection = (projectId = "project_a") =>
  nativeSelectionSchema.parse({
    token: crypto.randomUUID(),
    projectId,
    agentId: "dev-orchestrator",
    profileMode: "session-override",
    agentsJson: null,
    sourceHash: null,
    createdAt: Date.now(),
  });

function sendHost(thread: Record<string, unknown> | null) {
  const sent: Array<Record<string, unknown>> = [];
  let providerCalls = 0;
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "gone") throw new Error("thread lookup unavailable");
          return { id: threadId, providerId: "claude-code", ...(thread ?? {}) };
        },
        send: async (args: Record<string, unknown>) => {
          sent.push(args);
          return { ok: true };
        },
      },
      providers: { list: async () => { providerCalls += 1; return []; }, models: async () => { providerCalls += 1; return { models: [] }; } },
    } as never,
  });
  const db = openDatabase(bb);
  const api = withStandardServiceTier(bb, (request) =>
    lanePilotOwnedTarget(bb, (threadId) => openRunOfPmThread(db, threadId), request));
  return { bb, api, sent, db, providerCalls: () => providerCalls };
}

describe("send facade", () => {
  it("normalizes a send to an LP-origin thread on any provider and preserves every other field", async () => {
    const { api, sent } = sendHost({ originPluginId: "lane-pilot", providerId: "codex" });
    const request = {
      threadId: "lp-thread",
      senderThreadId: "sender-1",
      mode: "queue-if-active",
      serviceTier: "fast",
      sendAt: 123,
      input: [{ type: "text", text: "hello", mentions: [] }],
    };

    const result = await api.sdk.threads.send(request as never);

    expect(result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.serviceTier).toBe("default");
    expect(sent[0]?.threadId).toBe("lp-thread");
    expect(sent[0]?.senderThreadId).toBe("sender-1");
    expect(sent[0]?.mode).toBe("queue-if-active");
    expect(sent[0]?.sendAt).toBe(123);
    expect(sent[0]?.input).toEqual([{ type: "text", text: "hello", mentions: [] }]);
  });

  it("adds the standard tier when an owned send omitted it", async () => {
    const { api, sent } = sendHost({ originPluginId: "lane-pilot" });

    await api.sdk.threads.send({ threadId: "lp-thread", input: [{ type: "text", text: "t", mentions: [] }] } as never);

    expect(sent[0]?.serviceTier).toBe("default");
  });

  it("keeps an actively-bound native chat on the standard tier", async () => {
    const { api, bb, sent } = sendHost({});
    await bb.storage.kv.set(nativeThreadKey("native-chat"), selection());

    await api.sdk.threads.send({ threadId: "native-chat", serviceTier: "fast", input: [{ type: "text", text: "t", mentions: [] }] } as never);

    expect(sent[0]?.serviceTier).toBe("default");
  });

  it("keeps the PM thread of an open run on the standard tier", async () => {
    const { api, sent, db } = sendHost({});
    createRun(db, "run-1", "project_a", "cli", "/workspace");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("pm-1", "run-1");

    await api.sdk.threads.send({ threadId: "pm-1", serviceTier: "fast", input: [{ type: "text", text: "t", mentions: [] }] } as never);

    expect(sent[0]?.serviceTier).toBe("default");
  });

  it("leaves an ordinary owner chat on whatever tier its message carried, including Fast", async () => {
    const { api, sent } = sendHost({});

    await api.sdk.threads.send({ threadId: "owner-chat", serviceTier: "fast", input: [{ type: "text", text: "t", mentions: [] }] } as never);
    await api.sdk.threads.send({ threadId: "owner-chat", input: [{ type: "text", text: "t2", mentions: [] }] } as never);

    expect(sent[0]?.serviceTier).toBe("fast");
    expect("serviceTier" in (sent[1] ?? {})).toBe(false);
  });

  it("does not normalize an ordinary chat kept on another provider by a dormant binding", async () => {
    const { api, bb, sent } = sendHost({ providerId: "gpt-5" });
    await bb.storage.kv.set(nativeThreadKey("switched-chat"), selection());

    await api.sdk.threads.send({ threadId: "switched-chat", serviceTier: "fast", input: [{ type: "text", text: "t", mentions: [] }] } as never);

    expect(sent[0]?.serviceTier).toBe("fast");
  });

  it("does not guess an unreadable bound target owned", async () => {
    const { api, bb, sent } = sendHost({});
    await bb.storage.kv.set(nativeThreadKey("gone"), selection());

    await api.sdk.threads.send({ threadId: "gone", serviceTier: "fast", input: [{ type: "text", text: "t", mentions: [] }] } as never);

    expect(sent[0]?.serviceTier).toBe("fast");
  });

  it("leaves the original api object untouched and delegates lazily", async () => {
    const { bb, api, sent } = sendHost({ originPluginId: "lane-pilot" });

    expect(api).not.toBe(bb);
    expect(api.sdk).not.toBe(bb.sdk);
    expect(api.sdk).toBe(api.sdk);
    expect(api.sdk.threads).toBe(api.sdk.threads);

    const rawSend = bb.sdk.threads.send;
    await rawSend({ threadId: "lp-thread", serviceTier: "fast" } as never);
    expect(sent[0]?.serviceTier).toBe("fast");

    const thread = await api.sdk.threads.get({ threadId: "lp-thread" });
    expect(thread).toMatchObject({ id: "lp-thread", originPluginId: "lane-pilot" });
    expect(api.log).toBe(bb.log);
  });

  it("invokes namespace methods with their original receiver", async () => {
    class Sdk {
      #secret = "sdk-secret";
      readonly threads = { send: async (args: unknown) => args, get: async () => ({ id: "t" }) };
      ping() {
        return this.#secret;
      }
    }
    const realBb = { sdk: new Sdk(), log: { warn: () => undefined } } as unknown as Parameters<typeof withStandardServiceTier>[0];
    const api = withStandardServiceTier(realBb, async () => false);

    expect((api.sdk as unknown as { ping: () => string }).ping()).toBe("sdk-secret");
    await api.sdk.threads.send({ threadId: "any", serviceTier: "fast" } as never);
    expect(api.sdk.threads.get).toBe(api.sdk.threads.get);
  });

  it("treats a synchronously throwing threads.get as unknown ownership and keeps the send untouched", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const realBb = {
      sdk: {
        threads: {
          get: () => {
            throw new Error("sdk disposed");
          },
          send: async (args: Record<string, unknown>) => {
            sent.push(args);
            return { ok: true };
          },
        },
      },
      storage: { kv: { get: async () => null } },
      log: { warn: () => undefined },
    } as unknown as Parameters<typeof withStandardServiceTier>[0];
    const api = withStandardServiceTier(realBb, async () =>
      lanePilotOwnedTarget(realBb, () => false, { threadId: "any" }));

    await api.sdk.threads.send({ threadId: "any", serviceTier: "fast" } as never);

    expect(sent[0]?.serviceTier).toBe("fast");
  });

  it("propagates send errors unchanged", async () => {
    const failure = new Error("send refused");
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          get: async () => ({ id: "owner-chat", providerId: "claude-code" }),
          send: async () => {
            throw failure;
          },
        },
      } as never,
    });
    const api = withStandardServiceTier(bb, async () => false);

    await expect(api.sdk.threads.send({ threadId: "owner-chat" } as never)).rejects.toBe(failure);
  });

  it("makes no provider or model calls", async () => {
    const { api, providerCalls } = sendHost({ originPluginId: "lane-pilot" });

    await api.sdk.threads.send({ threadId: "lp-thread", serviceTier: "fast" } as never);

    expect(providerCalls()).toBe(0);
  });
});

describe("dispatch admission", () => {
  const ctx = (overrides: Record<string, unknown>) =>
    makeMessageDispatchHookContext({
      thread: { id: "thr-x", projectId: "project_a", providerId: "claude-code", originPluginId: null },
      project: { id: "project_a" },
      requestedExecution: { providerId: "claude-code", serviceTier: "fast" },
      ...overrides,
    } as never);

  it("rejects an LP-origin thread's turn saved on a nondefault tier", async () => {
    const { bb } = sendHost({});
    const verdict = await lpStandardTierAdmission(bb, ctx({ thread: { id: "thr-x", projectId: "project_a", providerId: "claude-code", originPluginId: "lane-pilot" } }));

    expect(verdict.action).toBe("reject");
  });

  it("rejects a dispatch carrying an LP-origin row in a mixed queue", async () => {
    const { bb } = sendHost({});
    const verdict = await lpStandardTierAdmission(
      bb,
      ctx({
        originPluginId: "mixed",
        queuedMessages: [
          { id: "q1", originPluginId: null },
          { id: "q2", originPluginId: "lane-pilot" },
        ],
      }),
    );

    expect(verdict.action).toBe("reject");
  });

  it("rejects a bound native chat's saved Fast turn", async () => {
    const { bb } = sendHost({});
    await bb.storage.kv.set(nativeThreadKey("thr-x"), selection());
    const verdict = await lpStandardTierAdmission(bb, ctx({}));

    expect(verdict.action).toBe("reject");
  });

  it("lets a dormant bound chat's Fast turn proceed on another provider", async () => {
    const { bb } = sendHost({});
    await bb.storage.kv.set(nativeThreadKey("thr-x"), selection());
    const verdict = await lpStandardTierAdmission(bb, ctx({ requestedExecution: { providerId: "gpt-5", serviceTier: "fast" } }));

    expect(verdict).toEqual({ action: "proceed" });
  });

  it("lets an ordinary chat's Fast turn proceed", async () => {
    const { bb } = sendHost({});

    expect(await lpStandardTierAdmission(bb, ctx({}))).toEqual({ action: "proceed" });
    expect(await lpStandardTierAdmission(bb, ctx({ originPluginId: "other-plugin" }))).toEqual({ action: "proceed" });
  });

  it("proceeds for default and missing tiers regardless of ownership", async () => {
    const { bb } = sendHost({});
    const lpThread = { id: "thr-x", projectId: "project_a", providerId: "claude-code", originPluginId: "lane-pilot" };

    expect(await lpStandardTierAdmission(bb, ctx({ thread: lpThread, requestedExecution: { providerId: "claude-code", serviceTier: "default" } }))).toEqual({ action: "proceed" });
    expect(await lpStandardTierAdmission(bb, ctx({ thread: lpThread, requestedExecution: { providerId: "claude-code", serviceTier: null } }))).toEqual({ action: "proceed" });
  });
});

describe("wiring composition", () => {
  async function mount() {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "project_a", providerId: "claude-code" }),
          getPluginMetadata: async () => ({}),
          updatePluginMetadata: async () => ({}),
        },
        plugins: { callRpc: async () => null },
      } as never,
      experimental_callHostRpc: async () => ({}),
    });
    const db = openDatabase(bb);
    mountNativeWiring({ bb, db, nativeHost: { call: async () => ({}) } } as never);
    const hook = harness.registrations.hooks["message.dispatch"]!;
    return { bb, hook };
  }

  const ctx = (overrides: Record<string, unknown>) =>
    makeMessageDispatchHookContext({
      thread: { id: "thr-x", projectId: "project_a", providerId: "claude-code", originPluginId: null },
      project: { id: "project_a" },
      environment: { id: "env-1", projectId: "project_a", hostId: "host_a", path: "/workspace" },
      requestedExecution: { providerId: "claude-code", serviceTier: "fast" },
      input: { text: "hello", blocks: [{ type: "text", text: "hello", mentions: [] }] },
      ...overrides,
    } as never);

  it("rejects an LP-origin Fast dispatch that the native dispatch let proceed", async () => {
    const { hook } = await mount();

    const verdict = await hook(ctx({ thread: { id: "thr-x", projectId: "project_a", providerId: "claude-code", originPluginId: "lane-pilot" } }));

    expect(verdict.action).toBe("reject");
    expect((verdict as { message?: string }).message).toContain("standard service tier");
  });

  it("lets an ordinary Fast dispatch proceed", async () => {
    const { hook } = await mount();

    expect(await hook(ctx({}))).toEqual({ action: "proceed" });
  });

  it("lets a dormant bound chat's Fast dispatch proceed on another provider", async () => {
    const { bb, hook } = await mount();
    await bb.storage.kv.set(nativeThreadKey("thr-x"), selection());

    expect(await hook(ctx({ requestedExecution: { providerId: "gpt-5", serviceTier: "fast" } }))).toEqual({ action: "proceed" });
  });

  it("keeps the native dispatch's own reject ahead of the tier check", async () => {
    const { bb, hook } = await mount();
    const bound = selection();
    await bb.storage.kv.set(nativeThreadKey("thr-x"), bound);
    const text = `switch ${nativeSelectionMarker(crypto.randomUUID())}`;

    const verdict = await hook(ctx({ input: { text, blocks: [{ type: "text", text, mentions: [] }] } }));

    expect(verdict.action).toBe("reject");
    expect((verdict as { message?: string }).message).not.toContain("standard service tier");
  });
});

describe("spawn normalization", () => {
  it("sends the same standard-tier args to the keyed spawn path", async () => {
    const keyed: Array<Record<string, unknown>> = [];
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          experimental_vkSpawnKeyed: async (args: Record<string, unknown>) => {
            keyed.push(args);
            return { thread: { id: `thr-${keyed.length}` }, reused: false };
          },
          experimental_vkFindByKey: async () => null,
          spawn: async () => ({ id: "plain" }),
        },
      } as never,
    });
    (bb as { vk?: unknown }).vk = {};

    await fullAccessSpawn(bb, { projectId: "p1", providerId: "claude-code", serviceTier: "fast", prompt: "t", pluginMetadata: { role: "pm", lanePilotRunId: "run-1" } } as never);

    expect(keyed).toHaveLength(1);
    expect(keyed[0]?.serviceTier).toBe("default");
    expect((keyed[0]?.executionInputSources as Record<string, unknown>)?.serviceTier).toBe("explicit");
    expect(keyed[0]?.permissionMode).toBe("full");
  });
});
