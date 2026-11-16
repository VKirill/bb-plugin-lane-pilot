import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { createRun, findOpenNativeRun, getRun, getActivation, loadPrototypeConfig, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { listHandoffs } from "@lane-pilot/handoff";
import { tokensFrom } from "../../src/rooms/native-agent/native-session";

const projectId = "source", threadId = "parent", runId = "run-parent";
let dispose: (() => Promise<void> | void) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

async function setup(options: { sources?: Array<{ hostId: string; path: string }>; spawnFails?: boolean; placementFails?: boolean; sendFails?: boolean; lostAck?: boolean } = {}) {
  const spawned: Array<Record<string, any>> = [], sent: Array<Record<string, any>> = [], placed: Array<Record<string, string>> = [];
  const events: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
    projects: { get: async ({ projectId: id }: { projectId: string }) => ({ id, sources: options.sources ?? [{ hostId: "target-host", path: "/target" }] }) },
    threads: {
      updatePluginMetadata: async () => ({}),
      defaultExecutionOptions: async () => ({ providerId: "claude-code", model: "claude-opus-5-5" }),
      spawn: async (args: Record<string, any>) => { if (options.spawnFails) throw new Error("host offline"); spawned.push(args); events.push("spawn"); return { id: "child", environmentId: "env-child" }; },
      send: async (args: Record<string, any>) => { if (options.sendFails) throw new Error("send refused"); sent.push(args); events.push("send"); if (options.lostAck) throw new Error("ECONNRESET after acceptance"); return { ok: true }; },
    },
    plugins: { callRpc: async ({ method, input }: { method: string; input: Record<string, string> }) => {
      if (method === "pending" || method === "thread") return null;
      if (method === "thread_place") { if (options.placementFails) throw new Error("placement refused"); placed.push(input); events.push("place"); return { ok: true }; }
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
});
