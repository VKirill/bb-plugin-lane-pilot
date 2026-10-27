import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { findOpenNativeRun, getRun, openDatabase, savePrototypeConfig } from "../src/rooms/storage/database";
import { nativeSelectionMarker } from "../src/rooms/native-agent/native-session";
import { switchChatAgent } from "../src/rooms/native-agent/server/chat-agent-switch";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

type Chat = { status: string; providerId: string; role: string | null };

function context(threadId: string, text: string, providerId = "claude-code") {
  return makeMessageDispatchHookContext({
    thread: { id: threadId, projectId: "project_a", providerId },
    project: { id: "project_a" },
    host: { id: "host_a" },
    environment: { hostId: "host_a", projectId: "project_a", path: "/workspace", id: "env_native" },
    requestedExecution: { providerId },
    input: { text, blocks: [{ type: "text", text, mentions: [] }] },
  });
}

async function setup(chat: Partial<Chat> = {}) {
  const state: Chat = { status: "idle", providerId: "claude-code", role: null, ...chat };
  const stops: string[] = [];
  const prepareCalls: string[] = [];
  const metadata: Array<{ set?: Record<string, unknown>; remove?: string[] }> = [];
  const fake = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      hosts: { get: async () => ({ id: "host_a", status: "connected" }) },
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "project_a", providerId: state.providerId, status: state.status, environmentId: "env_native" }),
        getPluginMetadata: async () => (state.role ? { role: state.role } : {}),
        updatePluginMetadata: async (args: { set?: Record<string, unknown>; remove?: string[] }) => {
          metadata.push(args);
          if (args.set?.role) state.role = String(args.set.role);
          if (args.remove?.includes("role")) state.role = null;
        },
        stop: async ({ threadId }: { threadId: string }) => { stops.push(threadId); return { ok: true }; },
        listRunning: async () => [],
      },
      projects: { get: async () => ({ id: "project_a", sources: [{ hostId: "host_a", path: "/workspace", isDefault: true }] }) },
      environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, path: "/workspace", hostId: "host_a" }) },
      plugins: {
        experimental_discoverRpc: async () => [{ method: "pending" }, { method: "thread" }],
        callRpc: async ({ outputSchema }: { outputSchema: { parse: (value: unknown) => unknown } }) => outputSchema.parse(null),
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "nativeInstall") return { status: "enabled", sourceSha: "a".repeat(40), ownedFiles: 1, preservedFiles: 0 };
      if (method === "prepareNativeClaude") {
        const agentId = String((input as { agentId: string }).agentId);
        prepareCalls.push(agentId);
        return { env: [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: `/launcher/${agentId}`, reason: `Lane Pilot native: ${agentId}` }], agentId, claudePath: "/claude", sessionAgents: false };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  await plugin(fake.bb);
  savePrototypeConfig(openDatabase(fake.bb), {
    projectId: "project_a", hostId: "host_a", pmWorkspacePath: "/workspace", writerWorkspacePath: "/workspace",
    pmProviderId: "claude-code", pmModel: "claude", writerProviderId: "claude-code", writerModel: "claude",
  });
  cleanup.push(() => fake.harness.lifecycle.dispose());
  const call = (method: string, input: unknown) => fake.harness.behavior.callRpc(method as never, input as never) as Promise<any>;
  const hook = fake.harness.registrations.hooks["message.dispatch"]!;
  const launcher = async (threadId: string) =>
    (await fake.harness.behavior.resolveProviderEnv("claude-code", { threadId, hostId: "host_a", projectId: "project_a" }))
      .find((row) => row.name === "BB_CLAUDE_CODE_EXECUTABLE")?.value ?? null;
  return { fake, state, stops, prepareCalls, metadata, call, hook, launcher };
}

it("a plain chat switched to Lane Pilot releases its session and becomes a PM chat bound to a run on its next message", async () => {
  const t = await setup();
  expect(await t.call("chat_agent_state", { threadId: "thr_plain" })).toEqual({ projectId: "project_a", eligible: true, reason: null, current: null });
  expect(await t.call("switch_chat_agent", { threadId: "thr_plain", agentId: "dev-orchestrator" })).toMatchObject({ agentId: "dev-orchestrator" });
  expect(t.stops).toEqual(["thr_plain"]);
  // The choice shows at once; nothing is bound until the owner sends.
  expect(await t.call("native_thread", { threadId: "thr_plain" })).toMatchObject({ agentType: "dev-orchestrator" });
  expect(await t.call("chat_agent_state", { threadId: "thr_plain" })).toMatchObject({ current: { agentId: "dev-orchestrator", pending: true } });
  expect(findOpenNativeRun(openDatabase(t.fake.bb), "project_a", "thr_plain")).toBeNull();
  expect(await t.launcher("thr_plain")).toBeNull();

  expect(await t.hook(context("thr_plain", "hello"))).toEqual({ action: "proceed" });
  const runId = findOpenNativeRun(openDatabase(t.fake.bb), "project_a", "thr_plain")!;
  expect(getRun(openDatabase(t.fake.bb), runId)).toMatchObject({ kind: "cli", pm_thread_id: "thr_plain" });
  expect(t.metadata[0]).toMatchObject({ set: { role: "pm", lanePilotRunId: runId } });
  expect(t.prepareCalls).toEqual(["dev-orchestrator"]);
  expect(await t.launcher("thr_plain")).toBe("/launcher/dev-orchestrator");
  expect(await t.call("chat_agent_state", { threadId: "thr_plain" })).toMatchObject({ current: { agentId: "dev-orchestrator", pending: false } });
  // The switch was spent: the next message takes the cached launcher without another host call.
  const prepared = t.prepareCalls.length;
  expect(await t.hook(context("thr_plain", "again"))).toEqual({ action: "proceed" });
  expect(t.prepareCalls).toHaveLength(prepared);
});

it("a bound chat moved to a specialist keeps its run, prepares the new launcher and does not take the cached one", async () => {
  const t = await setup();
  const { token } = await t.call("prepare_native_session", { projectId: "project_a", agentId: "dev-orchestrator" });
  await t.hook(context("thr_pm", nativeSelectionMarker(token)));
  const runId = findOpenNativeRun(openDatabase(t.fake.bb), "project_a", "thr_pm");
  expect(await t.launcher("thr_pm")).toBe("/launcher/dev-orchestrator");
  t.stops.length = 0;
  t.prepareCalls.length = 0;

  await t.call("switch_chat_agent", { threadId: "thr_pm", agentId: "copy-lead" });
  expect(t.stops).toEqual(["thr_pm"]);
  expect(await t.hook(context("thr_pm", "now edit this"))).toEqual({ action: "proceed" });
  expect(t.prepareCalls).toEqual(["copy-lead"]);
  expect(await t.launcher("thr_pm")).toBe("/launcher/copy-lead");
  expect(await t.call("native_thread", { threadId: "thr_pm" })).toMatchObject({ agentType: "copy-lead" });
  expect(findOpenNativeRun(openDatabase(t.fake.bb), "project_a", "thr_pm")).toBe(runId);
});

it("switching to the agent the chat already runs changes nothing", async () => {
  const t = await setup();
  const { token } = await t.call("prepare_native_session", { projectId: "project_a", agentId: "dev-orchestrator" });
  await t.hook(context("thr_same", nativeSelectionMarker(token)));
  await t.call("switch_chat_agent", { threadId: "thr_same", agentId: "dev-orchestrator" });
  expect(t.stops).toEqual([]);
  expect(await t.call("chat_agent_state", { threadId: "thr_same" })).toMatchObject({ current: { pending: false } });
});

it("turning the agent off finishes the chat's run, drops the door and the launcher, and the chat is plain again", async () => {
  const t = await setup();
  const { token } = await t.call("prepare_native_session", { projectId: "project_a", agentId: "dev-orchestrator" });
  await t.hook(context("thr_off", nativeSelectionMarker(token)));
  const runId = findOpenNativeRun(openDatabase(t.fake.bb), "project_a", "thr_off")!;
  expect(t.state.role).toBe("pm");

  await t.call("switch_chat_agent", { threadId: "thr_off", agentId: null });
  expect(t.stops).toEqual(["thr_off"]);
  expect(t.state.role).toBeNull();
  expect(t.metadata.at(-1)).toMatchObject({ remove: ["role", "lanePilotRunId"] });
  expect(getRun(openDatabase(t.fake.bb), runId)?.closed_at).not.toBeNull();
  expect(findOpenNativeRun(openDatabase(t.fake.bb), "project_a", "thr_off")).toBeNull();
  expect(await t.call("native_thread", { threadId: "thr_off" })).toBeNull();
  expect(await t.launcher("thr_off")).toBeNull();
  expect(await t.hook(context("thr_off", "plain now"))).toEqual({ action: "proceed" });
  expect(t.prepareCalls).toEqual(["dev-orchestrator"]);
});

it("turning off a chat that only picked an agent drops the pick without touching the session", async () => {
  const t = await setup({ status: "pending" });
  await t.call("switch_chat_agent", { threadId: "thr_new", agentId: "copy-lead" });
  expect(t.stops).toEqual([]);
  await t.call("switch_chat_agent", { threadId: "thr_new", agentId: null });
  expect(await t.call("native_thread", { threadId: "thr_new" })).toBeNull();
  expect(await t.hook(context("thr_new", "hi"))).toEqual({ action: "proceed" });
  expect(findOpenNativeRun(openDatabase(t.fake.bb), "project_a", "thr_new")).toBeNull();
});

it("refuses a chat that is replying, on another provider, or fixed by Lane Pilot", async () => {
  const running = await setup({ status: "active" });
  await expect(running.call("switch_chat_agent", { threadId: "thr_x", agentId: "copy-lead" })).rejects.toThrow(/Wait until the reply ends/);
  expect(running.stops).toEqual([]);
  const codex = await setup({ providerId: "codex" });
  expect(await codex.call("chat_agent_state", { threadId: "thr_x" })).toMatchObject({ eligible: false, reason: "provider" });
  await expect(codex.call("switch_chat_agent", { threadId: "thr_x", agentId: "copy-lead" })).rejects.toThrow(/Claude Code/);
  const writer = await setup({ role: "writer" });
  expect(await writer.call("chat_agent_state", { threadId: "thr_x" })).toMatchObject({ eligible: false, reason: "helper" });
  const spawned = await setup({ role: "pm" });
  expect(await spawned.call("chat_agent_state", { threadId: "thr_x" })).toMatchObject({ eligible: false, reason: "lane_started" });
  await expect(spawned.call("switch_chat_agent", { threadId: "thr_x", agentId: null })).rejects.toThrow(/started this chat itself/);
});

it("turning Lane Pilot off in a chat whose tasks are at work refuses and changes nothing: the pending pick, the binding and the run stay", async () => {
  const t = await setup();
  const { token } = await t.call("prepare_native_session", { projectId: "project_a", agentId: "dev-orchestrator" });
  await t.hook(context("thr_busy", nativeSelectionMarker(token)));
  const db = openDatabase(t.fake.bb);
  const runId = findOpenNativeRun(db, "project_a", "thr_busy")!;
  // A pick of another agent is waiting for the next message.
  await t.call("switch_chat_agent", { threadId: "thr_busy", agentId: "copy-lead" });
  const before = { stops: [...t.stops], metadata: t.metadata.length };
  expect(await t.call("chat_agent_state", { threadId: "thr_busy" })).toMatchObject({ current: { agentId: "copy-lead", pending: true } });

  const ctx = { bb: t.fake.bb, db, ownedAgents: async () => ({}) } as never;
  await expect(switchChatAgent(ctx, { threadId: "thr_busy", agentId: null }, async () => { throw new Error("tasks are at work"); })).rejects.toThrow(/tasks are at work/);
  expect(await t.call("chat_agent_state", { threadId: "thr_busy" })).toMatchObject({ current: { agentId: "copy-lead", pending: true } });
  expect(await t.call("native_thread", { threadId: "thr_busy" })).not.toBeNull();
  expect(findOpenNativeRun(db, "project_a", "thr_busy")).toBe(runId);
  expect(t.state.role).toBe("pm");
  expect({ stops: t.stops, metadata: t.metadata.length }).toEqual(before);
});
