import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { claimActivation, createAttempt, createTask, findOpenNativeRun, getActivation, getRun, listUnreportedTaskOutcomes, openDatabase, savePrototypeConfig, transitionAttempt } from "../src/rooms/storage/database";
import { insertPhase, savePhase } from "../src/rooms/phase/store";
import { createWorkflowTriggers } from "../src/rooms/workflow/server/workflow-triggers";
import { nativeSelectionMarker } from "../src/rooms/native-agent/native-session";
import { switchChatAgent } from "../src/rooms/native-agent/server/chat-agent-switch";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** The project's PM chat as the workflow triggers read it (a scheduled report, a workflow start). */
const pmOf = (ctx: never) => createWorkflowTriggers(ctx, { workflowEngine: {} as never }, { loadStore: async () => ({}) as never } as never).pmOf("project_a");

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

it("a specialist chat moved to another specialist keeps its run, prepares the new launcher and does not take the cached one", async () => {
  const t = await setup();
  const { token } = await t.call("prepare_native_session", { projectId: "project_a", agentId: "copy-lead" });
  await t.hook(context("thr_spec2", nativeSelectionMarker(token)));
  const runId = findOpenNativeRun(openDatabase(t.fake.bb), "project_a", "thr_spec2");
  expect(await t.launcher("thr_spec2")).toBe("/launcher/copy-lead");
  t.stops.length = 0;
  t.prepareCalls.length = 0;

  await t.call("switch_chat_agent", { threadId: "thr_spec2", agentId: "design-lead" });
  expect(t.stops).toEqual(["thr_spec2"]);
  expect(await t.hook(context("thr_spec2", "continue"))).toEqual({ action: "proceed" });
  expect(t.prepareCalls).toEqual(["design-lead"]);
  expect(await t.launcher("thr_spec2")).toBe("/launcher/design-lead");
  expect(findOpenNativeRun(openDatabase(t.fake.bb), "project_a", "thr_spec2")).toBe(runId);
  expect(t.state.role).toBe("pm");
});

/** A PM chat bound to dev-orchestrator with an open run and the project's activation on it. */
async function pmChat(threadId: string) {
  const t = await setup();
  const { token } = await t.call("prepare_native_session", { projectId: "project_a", agentId: "dev-orchestrator" });
  await t.hook(context(threadId, nativeSelectionMarker(token)));
  const db = openDatabase(t.fake.bb);
  const runId = findOpenNativeRun(db, "project_a", threadId)!;
  claimActivation(db, { projectId: "project_a", pmThreadId: threadId, runId });
  t.stops.length = 0;
  t.prepareCalls.length = 0;
  return { t, db, runId };
}

it("a PM chat moved to a specialist hands the door back: the run is closed, the activation and the PM role are gone, and the next message reaches the specialist", async () => {
  const { t, db, runId } = await pmChat("thr_pm");
  const ctx = { bb: t.fake.bb, db, ownedAgents: async () => ({}) } as never;
  expect(await pmOf(ctx)).toMatchObject({ pmThreadId: "thr_pm", runId });

  await t.call("switch_chat_agent", { threadId: "thr_pm", agentId: "copy-lead" });
  // The door is closed at once, in every place that reads «the PM chat»: the run row, the activation, the chat's metadata.
  expect(t.stops).toEqual(["thr_pm"]);
  expect(getRun(db, runId)?.closed_at).not.toBeNull();
  expect(findOpenNativeRun(db, "project_a", "thr_pm")).toBeNull();
  expect(getActivation(db, "project_a")).toBeUndefined();
  expect(t.state.role).toBeNull();
  expect(t.metadata.at(-1)).toMatchObject({ remove: ["role", "lanePilotRunId"] });
  expect(await pmOf(ctx)).toBeNull();
  // The choice shows at once and nothing else is bound until the owner sends.
  expect(await t.call("chat_agent_state", { threadId: "thr_pm" })).toMatchObject({ eligible: true, current: { agentId: "copy-lead", pending: true } });

  expect(await t.hook(context("thr_pm", "now edit this"))).toEqual({ action: "proceed" });
  expect(t.prepareCalls).toEqual(["copy-lead"]);
  expect(await t.launcher("thr_pm")).toBe("/launcher/copy-lead");
  expect(await t.call("native_thread", { threadId: "thr_pm" })).toMatchObject({ agentType: "copy-lead" });
  // The specialist's chat has a run of its own (its tools need one) but it is not the project's PM: the old run stays closed and nothing resolves it as the PM chat.
  const own = findOpenNativeRun(db, "project_a", "thr_pm");
  expect(own).not.toBe(runId);
  expect(getRun(db, runId)?.closed_at).not.toBeNull();
  expect(await pmOf(ctx)).toBeNull();
});

it("tasks of the run it left tell no one: a result of the closed run is not sent to the chat that became a specialist", async () => {
  const { t, db, runId } = await pmChat("thr_pm");
  createTask(db, { id: "t1", runId, kind: "bb", contract: {} });
  createAttempt(db, { id: "a1", runId, taskId: "t1" });
  transitionAttempt(db, "a1", "canceled", { reason: "x" } as never);
  expect(listUnreportedTaskOutcomes(db, 0).map((row) => row.pmThreadId)).toEqual(["thr_pm"]);

  await t.call("switch_chat_agent", { threadId: "thr_pm", agentId: "copy-lead" });
  expect(listUnreportedTaskOutcomes(db, 0)).toEqual([]);
});

it("a PM chat whose writers are at work refuses the move to a specialist, and to off, and changes nothing", async () => {
  const { t, db, runId } = await pmChat("thr_pm");
  createTask(db, { id: "t1", runId, kind: "bb", contract: {} });
  createAttempt(db, { id: "a1", runId, taskId: "t1" });
  const before = { metadata: t.metadata.length, stops: [...t.stops] };

  await expect(t.call("switch_chat_agent", { threadId: "thr_pm", agentId: "copy-lead" })).rejects.toThrow(/at work.*Wait until they end or cancel them/);
  await expect(t.call("switch_chat_agent", { threadId: "thr_pm", agentId: null })).rejects.toThrow(/at work/);
  expect(findOpenNativeRun(db, "project_a", "thr_pm")).toBe(runId);
  expect(getActivation(db, "project_a")).toMatchObject({ run_id: runId });
  expect(t.state.role).toBe("pm");
  expect(await t.call("native_thread", { threadId: "thr_pm" })).toMatchObject({ agentType: "dev-orchestrator" });
  expect(await t.call("chat_agent_state", { threadId: "thr_pm" })).toMatchObject({ current: { agentId: "dev-orchestrator", pending: false } });
  expect({ metadata: t.metadata.length, stops: t.stops }).toEqual(before);

  // The task ends: the same switch goes through.
  transitionAttempt(db, "a1", "canceled", { reason: "x" } as never);
  await t.call("switch_chat_agent", { threadId: "thr_pm", agentId: "copy-lead" });
  expect(findOpenNativeRun(db, "project_a", "thr_pm")).toBeNull();
});

it("a PM chat with a live phase or a live workflow run refuses the move and says which", async () => {
  const phase = await pmChat("thr_pm");
  insertPhase(phase.db, { id: "ph_1", projectId: "project_a", pmThreadId: "thr_pm", title: "Login", goal: "g", runId: phase.runId, at: Date.now() });
  await expect(phase.t.call("switch_chat_agent", { threadId: "thr_pm", agentId: "copy-lead" })).rejects.toThrow(/phase «Login»/);
  expect(findOpenNativeRun(phase.db, "project_a", "thr_pm")).toBe(phase.runId);
  savePhase(phase.db, "ph_1", { state: "stopped", at: Date.now() });
  await phase.t.call("switch_chat_agent", { threadId: "thr_pm", agentId: "copy-lead" });
  expect(findOpenNativeRun(phase.db, "project_a", "thr_pm")).toBeNull();

  const graph = await pmChat("thr_pm2");
  graph.db.prepare(`INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,created_at,updated_at)
    VALUES ('wfrun_x','code-review',1,'x','{}','project_a',?, 'running',1,1)`).run(graph.runId);
  await expect(graph.t.call("switch_chat_agent", { threadId: "thr_pm2", agentId: null })).rejects.toThrow(/workflow run/);
  expect(findOpenNativeRun(graph.db, "project_a", "thr_pm2")).toBe(graph.runId);
});

it("a chat bound to a bundled specialist is not taken for the project's PM chat, whatever its metadata says", async () => {
  const t = await setup();
  const db = openDatabase(t.fake.bb);
  const { token } = await t.call("prepare_native_session", { projectId: "project_a", agentId: "copy-lead" });
  await t.hook(context("thr_spec", nativeSelectionMarker(token)));
  expect(t.state.role).toBe("pm");
  expect(findOpenNativeRun(db, "project_a", "thr_spec")).not.toBeNull();
  const ctx = { bb: t.fake.bb, db } as never;
  expect(await pmOf(ctx)).toBeNull();
  // A chat Lane Pilot started itself (no binding) is a PM chat as before.
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_lp' WHERE kind='cli' AND pm_thread_id='thr_spec'").run();
  expect(await pmOf(ctx)).toMatchObject({ pmThreadId: "thr_lp" });
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
  const { token } = await t.call("prepare_native_session", { projectId: "project_a", agentId: "copy-lead" });
  await t.hook(context("thr_busy", nativeSelectionMarker(token)));
  const db = openDatabase(t.fake.bb);
  const runId = findOpenNativeRun(db, "project_a", "thr_busy")!;
  // A pick of another agent is waiting for the next message.
  await t.call("switch_chat_agent", { threadId: "thr_busy", agentId: "design-lead" });
  const before = { stops: [...t.stops], metadata: t.metadata.length };
  expect(await t.call("chat_agent_state", { threadId: "thr_busy" })).toMatchObject({ current: { agentId: "design-lead", pending: true } });

  const ctx = { bb: t.fake.bb, db, ownedAgents: async () => ({}) } as never;
  await expect(switchChatAgent(ctx, { threadId: "thr_busy", agentId: null }, async () => { throw new Error("tasks are at work"); })).rejects.toThrow(/tasks are at work/);
  expect(await t.call("chat_agent_state", { threadId: "thr_busy" })).toMatchObject({ current: { agentId: "design-lead", pending: true } });
  expect(await t.call("native_thread", { threadId: "thr_busy" })).not.toBeNull();
  expect(findOpenNativeRun(db, "project_a", "thr_busy")).toBe(runId);
  expect(t.state.role).toBe("pm");
  expect({ stops: t.stops, metadata: t.metadata.length }).toEqual(before);
});
