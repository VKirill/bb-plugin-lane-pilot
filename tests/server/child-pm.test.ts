import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { createRun, findOpenNativeRun, getRun, getActivation, loadPrototypeConfig, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { listHandoffs } from "@lane-pilot/handoff";
import { tokensFrom } from "../../src/rooms/native-agent/models/native-session";
import { createRecipientResolver } from "../../src/rooms/native-agent/server/services/recipient";
import { relayFor } from "../../src/rooms/relay/server/services/relay-runtime";
import { finalizeNativeLaneBinding } from "../../src/rooms/native-agent/server/services/native-run";

const projectId = "source", threadId = "parent", runId = "run-parent";
let dispose: (() => Promise<void> | void) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

async function setup(options: { sources?: Array<{ hostId: string; path: string }>; spawnFails?: boolean; placementFails?: boolean; sendFails?: boolean; lostAck?: boolean; oldMinutes?: number; cacheExpired?: boolean; unreadable?: boolean; explicitRoot?: boolean; cacheFails?: boolean; archived?: boolean; neverOpened?: boolean } = {}) {
  const spawned: Array<Record<string, any>> = [], sent: Array<Record<string, any>> = [], placed: Array<Record<string, string>> = [];
  const events: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
    projects: { get: async ({ projectId: id }: { projectId: string }) => ({ id, sources: options.sources ?? [{ hostId: "target-host", path: "/target" }] }) },
    threads: {
      get: async ({ threadId: id }: { threadId: string }) => {
        if (options.unreadable) throw new Error("thread lookup unavailable");
        return { id, projectId: "other", environmentId: "env-child", status: "idle", title: "Analytics", createdAt: Date.now() - (id === "old" ? (options.oldMinutes ?? 0) * 60_000 : 0),
          archivedAt: options.archived && id === "old" ? Date.now() : null,
          lastReadAt: options.neverOpened ? null : Date.now() - (id === "old" ? (options.oldMinutes ?? 0) * 60_000 : 0) };
      },
      events: { list: async ({ threadId: id }: { threadId: string }) => {
        if (options.cacheFails) throw new Error("cache events unavailable");
        return id === "old" && options.cacheExpired
          ? [{ type: "thread/tokenUsage/updated", createdAt: Date.now() - 3600_000, data: { tokenUsage: { promptCacheTtlMs: 300_000 } } }] : [];
      } },
      updatePluginMetadata: async () => ({}),
      defaultExecutionOptions: async () => ({ providerId: "claude-code", model: "claude-opus-5-5" }),
      spawn: async (args: Record<string, any>) => { if (options.spawnFails) throw new Error("host offline"); spawned.push(args); events.push("spawn"); return { id: "child", environmentId: "env-child" }; },
      send: async (args: Record<string, any>) => { if (options.sendFails) throw new Error("send refused"); sent.push(args); events.push("send"); if (options.lostAck) throw new Error("ECONNRESET after acceptance"); return { ok: true }; },
    },
    environments: { get: async () => ({ id: "env-child", projectId: "other", hostId: "section-host", path: "/analytics" }) },
    plugins: { callRpc: async ({ method, input }: { method: string; input: Record<string, string> }) => {
      if (method === "pending" || method === "thread") return null;
      if (method === "thread_place") { if (options.placementFails) throw new Error("placement refused"); placed.push(input); events.push("place"); return { ok: true }; }
      if (method === "list") return { folders: [{ id: "folder", projectId: "other", kind: "folder" }], roots: [], bindings: { "env-child": "folder" }, places: options.explicitRoot ? { old: "" } : {} };
      if (method !== "sections_list") throw new Error(`unexpected RPC ${method}`);
      return { sections: [
        { id: "folder", projectId: input.projectId, parentId: null, name: "Analytics", kind: "folder", hostId: "section-host", path: "/analytics", paths: [{ hostId: "section-host", path: "/analytics" }] },
        { id: "group", projectId: input.projectId, parentId: "folder", name: "Tasks", kind: "group", hostId: "", path: "", paths: [] },
      ] };
    } },
  } as never, experimental_callHostRpc: async ({ method, input: args }) => {
    if (method === "nativeInstall") return { status: "enabled", sourceSha: "a".repeat(40), ownedFiles: 1, preservedFiles: 0 };
    if (method === "prepareNativeClaude") return { env: [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/launcher", reason: "test" }], agentId: (args as { agentId: string }).agentId, claudePath: "/claude", sessionAgents: false };
    throw new Error(`unexpected host call ${method}`);
  } });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  createRun(db, runId, projectId); setRunThread(db, runId, threadId);
  const call = async (extra: Record<string, unknown>, caller = threadId) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_relay", {
    action: "handoff", runId, title: "Analytics assignment", objective: "Read the report", acceptance: ["Cite the result"], ...extra,
  }, { threadId: caller, projectId })));
  return { bb, db, harness, spawned, sent, placed, events, call };
}

describe("native child Pilot through the registered relay", () => {
  it("opens a same-project root child without changing the parent's historical binding", async () => {
    const { db, spawned, placed, call } = await setup({ sources: [{ hostId: "root-host", path: "/root" }] });
    expect(finalizeNativeLaneBinding({ db, runId, hostId: "section-host", workspacePath: "/analytics", environmentId: "env-parent" })).toBe(true);
    expect((await call({ targetProjectId: projectId, targetHostId: "root-host", targetPath: "/root" })).deliveredTo).toBe("child");
    expect(spawned[0]).toMatchObject({ projectId, parentThreadId: threadId, environment: { hostId: "root-host", workspace: { path: "/root" } } });
    expect(placed).toEqual([]);
    expect(getRun(db, runId)).toMatchObject({ writer_environment_id: "env-parent", writer_workspace_path: "/analytics" });
  });
  it.each(["other", projectId])("starts in %s without setup, preserves parent/sender and owns its native profile", async (target) => {
    const { bb, db, harness, spawned, sent, placed, events, call } = await setup();
    const result = await call({ targetProjectId: target, targetSectionId: "folder" });
    expect(result.deliveredTo, JSON.stringify(result)).toBe("child");
    expect(spawned).toHaveLength(1); expect(sent).toHaveLength(1);
    expect(events).toEqual(["spawn", "place", "send"]);
    expect(spawned[0]).toMatchObject({ projectId: target, parentThreadId: threadId, senderThreadId: threadId,
      environment: { type: "host", hostId: "section-host", workspace: { type: "unmanaged", path: "/analytics" } } });
    expect(spawned[0]!.startedOnBehalfOf).toBeUndefined();
    expect(spawned[0]).not.toHaveProperty("sectionId");
    expect(placed).toEqual([{ threadId: "child", projectId: target, folderId: "folder" }]);
    expect(spawned[0]!.input[0].text).toContain("[Lane Pilot service]");
    expect(spawned[0]!.input[0].text).not.toContain("Read the report");
    expect(sent[0]).toMatchObject({ threadId: "child", senderThreadId: threadId });
    expect(sent[0]!.input[0].text).toContain(`Handoff ${result.handoff.id}`);
    const [token] = tokensFrom(spawned[0]!.input);
    const selection = await bb.storage.kv.get(`native-selection:${token}`);
    expect(selection).toMatchObject({ projectId: target, agentId: "dev-orchestrator", profileMode: "session-override" });
    expect(selection).not.toHaveProperty("parentRunId");
    const dispatched = await harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
      thread: { id: "child", projectId: target, providerId: "claude-code" }, project: { id: target },
      host: { id: "section-host" }, environment: { id: "env-child", hostId: "section-host", path: "/analytics", projectId: target },
      requestedExecution: { providerId: "claude-code" }, input: { blocks: spawned[0]!.input, text: spawned[0]!.input.map((part: { text: string }) => part.text).join("\n") },
    }));
    expect(dispatched).toEqual({ action: "proceed" });
    const childRunId = findOpenNativeRun(db, target, "child");
    expect(childRunId).toBeTruthy(); expect(childRunId).not.toBe(runId);
    expect(getRun(db, childRunId!)).toMatchObject({ project_id: target, pm_thread_id: "child", writer_workspace_path: "/analytics", writer_environment_id: "env-child" });
    expect(getActivation(db, target)).toBeUndefined();
    expect(loadPrototypeConfig(db, target)).toBeNull();
    const followup = await call({ recipientThreadId: "child", objective: "Continue with the second report" });
    expect(followup.deliveredTo).toBe("child"); expect(spawned).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: "child", senderThreadId: threadId });
    expect(sent[1]!.input[0].text).toContain("Continue with the second report");
  });

  it("refuses an unknown section or foreign folder before spawning", async () => {
    const { spawned, call } = await setup();
    expect((await call({ targetProjectId: "other", targetSectionId: "missing" })).error.message).toContain("section missing");
    expect((await call({ targetProjectId: "other", targetSectionId: "folder", targetHostId: "target-host", targetPath: "/target" })).error.message).toContain("select a targetHostId/targetPath");
    expect((await call({ targetProjectId: "other", targetSectionId: "group" })).error.message).toContain("choose a folder section");
    expect(spawned).toEqual([]);
  });

  it("requires an explicit pair for ambiguous sources and uses only that pair", async () => {
    const { spawned, call } = await setup({ sources: [{ hostId: "a", path: "/a" }, { hostId: "b", path: "/b" }] });
    expect((await call({ targetProjectId: "other" })).error.message).toContain("select a targetHostId/targetPath");
    expect(spawned).toEqual([]);
    expect((await call({ targetProjectId: "other", targetHostId: "b", targetPath: "/b" })).deliveredTo).toBe("child");
    expect(spawned[0]!.environment).toMatchObject({ hostId: "b", workspace: { path: "/b" } });
  });

  it.each(["placementFails", "sendFails"] as const)("reports the created child on %s and never sends work past a placement refusal", async (failure) => {
    const { db, spawned, sent, call } = await setup({ [failure]: true });
    const result = await call({ targetProjectId: "other", targetSectionId: "folder" });
    expect(result.error).toMatchObject({ code: failure === "sendFails" ? "handoff_delivery_unknown" : "child_handoff_failed", retryable: false, sideEffects: "unknown" });
    expect(result.error.message).toContain("@thread:child");
    expect(listHandoffs(db, { projectId })[0]!.card.state).toBe(failure === "sendFails" ? "queued" : "canceled");
    expect(spawned).toHaveLength(1); expect(sent).toEqual([]);
  });

  it("keeps a possibly delivered assignment open after a lost acknowledgement", async () => {
    const { db, sent, spawned, call } = await setup({ lostAck: true });
    const result = await call({ targetProjectId: "other" });
    expect(result.error).toMatchObject({ code: "handoff_delivery_unknown", retryable: false, sideEffects: "unknown" });
    expect(sent).toHaveLength(1); expect(spawned).toHaveLength(1);
    expect(listHandoffs(db, { projectId })[0]!.card.state).toBe("queued");
  });

  it("does not bypass a host refusal or the real calling-PM boundary", async () => {
    const { spawned, sent, call } = await setup({ spawnFails: true });
    expect((await call({ targetProjectId: "other" })).error.message).toContain("host offline");
    expect((await call({ targetProjectId: "other" }, "foreign")).error.message).toContain("does not belong");
    expect(spawned).toEqual([]); expect(sent).toEqual([]);
  });

  it.each([{ oldMinutes: 301 }, { oldMinutes: 1, cacheExpired: true }])("replaces a stale recipient in its section before delivering: %j", async (options) => {
    const { bb, db, call, spawned, placed, sent, events } = await setup(options);
    const result = await call({ recipientThreadId: "old", toAgent: "lane-pilot-pm" });
    expect(result.deliveredTo, JSON.stringify(result)).toBe("child");
    expect(spawned[0]).toMatchObject({ projectId: "other", parentThreadId: "parent", environment: { hostId: "section-host", workspace: { path: "/analytics" } } });
    expect(placed).toEqual([{ threadId: "child", projectId: "other", folderId: "folder" }]);
    expect(events).toEqual(["spawn", "place", "send"]);
    expect(sent.every((row) => row.threadId === "child" && row.senderThreadId === "parent")).toBe(true);
    const again = await call({ recipientThreadId: "old", toAgent: "lane-pilot-pm" });
    expect(again.deliveredTo, JSON.stringify(again)).toBe("child");
    expect(spawned).toHaveLength(1);
    // A new resolver instance reads the persisted mapping; no shared in-memory cache is needed.
    const reloaded = createRecipientResolver({ bb, db, isDisposed: () => false } as never);
    expect(await reloaded({ projectId, fromThreadId: threadId, toThreadId: "old" })).toBe("child");
    expect(spawned).toHaveLength(1);
  });

  it("keeps a recently opened recipient when no provider expiry is reported", async () => {
    const { call, spawned, sent } = await setup({ oldMinutes: 299 });
    expect((await call({ recipientThreadId: "old" })).deliveredTo).toBe("old");
    expect(spawned).toEqual([]); expect(sent[0]!.threadId).toBe("old");
  });

  it("fails without sending when freshness cannot be read", async () => {
    const { call, spawned, sent } = await setup({ unreadable: true });
    expect((await call({ recipientThreadId: "old" })).error.message).toContain("lookup unavailable");
    expect(spawned).toEqual([]); expect(sent).toEqual([]);
  });

  it("sends a question to the replacement, deduplicates the old address and accepts only its reply", async () => {
    const { harness, spawned, sent } = await setup({ oldMinutes: 301 });
    const ask = async () => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_relay", { action: "ask", threadId: "old", question: "What does the report show?" }, { threadId, projectId })));
    const first = await ask();
    expect(first.toThreadId, JSON.stringify(first)).toBe("child");
    expect((await ask()).alreadyWaiting).toBe(true); expect(spawned).toHaveLength(1); expect(sent).toHaveLength(1);
    const reply = async (caller: string) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_relay", { action: "reply", askId: first.id, answer: "Report checked" }, { threadId: caller, projectId: "other" })));
    expect((await reply("old")).error.message).toContain("only the asked thread");
    expect((await reply("child")).answeredAt).toBeTypeOf("number");
    expect(sent[1]).toMatchObject({ threadId: "parent", senderThreadId: "child" });
  });

  it.each([{ archived: true }, { neverOpened: true, oldMinutes: 301 }])("replaces unavailable historical sessions: %j", async (options) => {
    const { call, spawned } = await setup(options);
    expect((await call({ recipientThreadId: "old" })).deliveredTo).toBe("child");
    expect(spawned).toHaveLength(1);
  });

  it("keeps a new never-opened child and refuses unreadable cache observations", async () => {
    const fresh = await setup({ neverOpened: true, oldMinutes: 1 });
    expect((await fresh.call({ recipientThreadId: "old" })).deliveredTo).toBe("old");
    expect(fresh.spawned).toEqual([]);
    await dispose?.(); dispose = undefined;
    const broken = await setup({ cacheFails: true });
    expect((await broken.call({ recipientThreadId: "old" })).error.message).toContain("cache events unavailable");
    expect(broken.sent).toEqual([]); expect(broken.spawned).toEqual([]);
  });

  it("keeps explicit project-root placement despite an environment folder binding", async () => {
    const { call, spawned, placed, events } = await setup({ oldMinutes: 301, explicitRoot: true });
    const result = await call({ recipientThreadId: "old" });
    expect(result.deliveredTo, JSON.stringify(result)).toBe("child");
    expect(spawned[0]!.environment).toMatchObject({ hostId: "target-host", workspace: { path: "/target" } });
    expect(placed).toEqual([{ threadId: "child", projectId: "other", folderId: null }]);
    expect(events).toEqual(["spawn", "place", "send"]);
  });

  it("does not spawn again after uncertain replacement setup", async () => {
    const { call, spawned, sent } = await setup({ oldMinutes: 301, placementFails: true });
    expect((await call({ recipientThreadId: "old" })).error.message).toContain("placement failed");
    expect((await call({ recipientThreadId: "old" })).error.message).toContain("setup");
    expect(spawned).toHaveLength(1); expect(sent).toEqual([]);
  });

  it("does not let a non-PM ask create a replacement", async () => {
    const { harness, spawned, sent } = await setup({ oldMinutes: 301 });
    const result = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_relay", { action: "ask", threadId: "old", question: "Report?" }, { threadId: "writer", projectId })));
    expect(result.error.message).toContain("does not belong");
    expect(spawned).toEqual([]); expect(sent).toEqual([]);
  });

  it("keeps an uncertain question and does not resend after a lost acknowledgement", async () => {
    const { bb, db, harness, spawned, sent } = await setup({ oldMinutes: 301, lostAck: true });
    const ask = async () => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_relay", { action: "ask", threadId: "old", question: "Report?" }, { threadId, projectId })));
    expect((await ask()).error).toMatchObject({ code: "relay_delivery_unknown", retryable: false, sideEffects: "unknown" });
    expect(await ask()).toMatchObject({ toThreadId: "child", requestedThreadId: "old", alreadyWaiting: true, deliveryUnknown: true, answeredAt: null });
    expect(await relayFor({ bb, db, isDisposed: () => false, log: () => {} }).threadSettled("child")).toBe(0);
    expect(await ask()).toMatchObject({ deliveryUnknown: true, answeredAt: null });
    expect(spawned).toHaveLength(1); expect(sent).toHaveLength(1);
  });

  it("uses strictly more than five hours, not five hours or a rounded hour", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const h = await setup({ oldMinutes: 300 });
      expect((await h.call({ recipientThreadId: "old" })).deliveredTo).toBe("old");
      expect(h.spawned).toEqual([]);
    } finally { clock.mockRestore(); }
  });
});
