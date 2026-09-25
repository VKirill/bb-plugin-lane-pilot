import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { getActivation, getRun, openDatabase, savePrototypeConfig } from "../src/database";
import { nativeSelectionMarker } from "../src/native-session";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function context(threadId: string, text: string, hostId = "host_a", path = "/workspace") {
  return makeMessageDispatchHookContext({
    thread: { id: threadId, projectId: "project_a", providerId: "claude-code" },
    project: { id: "project_a" },
    host: { id: hostId },
    environment: { hostId, projectId: "project_a", path, id: "env_native" },
    requestedExecution: { providerId: "claude-code" },
    input: { text, blocks: [{ type: "text", text, mentions: [] }] },
  });
}

async function setup(input?: {
  pending?: unknown;
  thread?: unknown;
  environmentPath?: string;
  failPrepareWithCwd?: boolean;
}) {
  const rpcCalls: Array<{ method: string; input: unknown }> = [];
  const prepareCalls: Array<{ cwd: string | null; agentId: string; agentsJson: string | null }> = [];
  const metadata: Array<{ threadId: string; set: Record<string, unknown> }> = [];
  const fake = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      hosts: { get: async () => ({ id: "host_a", status: "connected" }) },
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: "env_native" }),
        getPluginMetadata: async () => ({}),
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set: Record<string, unknown> }) => {
          metadata.push({ threadId, set });
        },
      },
      projects: {
        get: async () => ({
          id: "project_a",
          sources: [{ hostId: "host_a", path: "/workspace", isDefault: true }],
        }),
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          if (!input?.environmentPath) throw new Error("environment not attached");
          return { id: environmentId, path: input.environmentPath, hostId: "host_a" };
        },
      },
      plugins: {
        experimental_discoverRpc: async () => [{ method: "pending" }, { method: "thread" }],
        callRpc: async ({ method, input: rpcInput, outputSchema }: {
          method: string;
          input?: unknown;
          outputSchema: { parse: (value: unknown) => unknown };
        }) => {
          rpcCalls.push({ method, input: rpcInput });
          if (method === "clearPending") throw new Error("must not clear CLI Agents pending");
          if (method === "pending") return outputSchema.parse(input?.pending ?? null);
          if (method === "thread") return outputSchema.parse(input?.thread ?? null);
          throw new Error(`unexpected rpc ${method}`);
        },
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "discoverClaudeAgents") throw new Error("discovery belongs to message.dispatch, not prepare");
      if (method === "prepareNativeClaude") {
        const cwd = (input as { cwd?: string }).cwd ?? null;
        const agentId = String((input as { agentId: string }).agentId);
        const agentsJson = (input as { agentsJson: string | null }).agentsJson ?? null;
        prepareCalls.push({ cwd, agentId, agentsJson });
        if (input?.failPrepareWithCwd && cwd) throw new Error("late prepare failed");
        return {
          env: [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/launcher", reason: `Lane Pilot native: ${agentId}` }],
          agentId,
          claudePath: "/Users/me/.local/bin/claude",
          sessionAgents: false,
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  await plugin(fake.bb);
  savePrototypeConfig(openDatabase(fake.bb), {
    projectId: "project_a",
    hostId: "host_a",
    pmWorkspacePath: "/workspace",
    writerWorkspacePath: "/workspace",
    pmProviderId: "claude-code",
    pmModel: "claude",
    writerProviderId: "claude-code",
    writerModel: "claude",
  });
  cleanup.push(() => fake.harness.lifecycle.dispose());
  return { ...fake, rpcCalls, prepareCalls, metadata };
}

it("binds unique tokens per tab and never uses project pending", async () => {
  const fake = await setup();
  const first = await fake.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "lane-stack:dev-orchestrator",
  }) as { token: string; agentId: string; label: string; profileMode: string };
  const second = await fake.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "dev-orchestrator",
  }) as { token: string };
  expect(first.agentId).toBe("dev-orchestrator");
  expect(first.label).toBe("Development coordinator");
  expect(first.profileMode).toBe("installed");
  expect(first.token).not.toBe(second.token);
  const hook = fake.harness.registrations.hooks["message.dispatch"]!;
  expect(await hook(context("thr_a", nativeSelectionMarker(first.token)))).toEqual({ action: "proceed" });
  const secondSend = await hook(context("thr_b", nativeSelectionMarker(second.token)));
  expect(secondSend).toMatchObject({ action: "reject" });
  expect((secondSend as { message: string }).message).toContain("already active");
  expect(await fake.harness.behavior.callRpc("native_thread", { threadId: "thr_a" })).toMatchObject({
    token: first.token,
    agentType: "dev-orchestrator",
  });
  expect(await fake.harness.behavior.callRpc("native_thread", { threadId: "thr_b" })).toBeNull();
  const activation = getActivation(openDatabase(fake.bb), "project_a");
  expect(activation).toMatchObject({ pm_thread_id: "thr_a" });
  expect(getRun(openDatabase(fake.bb), activation!.run_id)).toMatchObject({ kind: "cli", state: "running" });
  expect(fake.metadata[0]).toMatchObject({ threadId: "thr_a", set: { role: "pm", lanePilotRunId: activation!.run_id } });
  expect(fake.rpcCalls.some((row) => row.method === "clearPending")).toBe(false);
});

it("uses the real host path and leaves an ordinary thread without env", async () => {
  const fake = await setup();
  const { token } = await fake.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "dev-orchestrator",
  }) as { token: string };
  const hook = fake.harness.registrations.hooks["message.dispatch"]!;
  expect(await hook(context("thr_path", nativeSelectionMarker(token), "host_a", "/real/checkout"))).toEqual({
    action: "proceed",
  });
  expect(fake.prepareCalls).toEqual([{ cwd: "/real/checkout", agentId: "dev-orchestrator", agentsJson: null }]);
  expect(await hook(context("thr_plain", "hello"))).toEqual({ action: "proceed" });
  expect(
    await fake.harness.behavior.resolveProviderEnv("claude-code", {
      threadId: "thr_plain",
      hostId: "host_a",
      projectId: "project_a",
    }),
  ).toEqual([]);
  expect(
    await fake.harness.behavior.resolveProviderEnv("claude-code", {
      threadId: "thr_path",
      hostId: "host_a",
      projectId: "project_a",
    }),
  ).toHaveLength(1);
});

it("resumes the same agent_type without a second mention", async () => {
  const fake = await setup();
  const { token } = await fake.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "dev-orchestrator",
  }) as { token: string };
  const hook = fake.harness.registrations.hooks["message.dispatch"]!;
  await hook(context("thr_resume", nativeSelectionMarker(token)));
  expect(await hook(context("thr_resume", "continue"))).toEqual({ action: "proceed" });
  expect(await fake.harness.behavior.callRpc("native_thread", { threadId: "thr_resume" })).toMatchObject({
    agentType: "dev-orchestrator",
  });
});

it("rejects a missing profile before contributing env", async () => {
  const fake = await setup();
  fake.harness.behavior; // keep
  const host = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      hosts: { get: async () => ({ id: "host_a", status: "connected" }) },
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: "env_native" }),
        updatePluginMetadata: async () => undefined,
      },
      projects: {
        get: async () => ({
          id: "project_a",
          sources: [{ hostId: "host_a", path: "/workspace", isDefault: true }],
        }),
      },
      plugins: {
        experimental_discoverRpc: async () => [{ method: "pending" }],
        callRpc: async ({ method, outputSchema }: { method: string; outputSchema: { parse: (v: unknown) => unknown } }) =>
          outputSchema.parse(null),
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "discoverClaudeAgents") {
        return { agents: [{ id: "dev-orchestrator", source: "user" }], version: "t", sessionAgents: true, pluginDir: true, supported: true };
      }
      if (method === "prepareNativeClaude") throw new Error(`Agent ${(input as { agentId: string }).agentId} is not installed in ${(input as { cwd: string }).cwd}.`);
      throw new Error(method);
    },
  });
  await plugin(host.bb);
  savePrototypeConfig(openDatabase(host.bb), {
    projectId: "project_a",
    hostId: "host_a",
    pmWorkspacePath: "/workspace",
    writerWorkspacePath: "/workspace",
    pmProviderId: "claude-code",
    pmModel: "claude",
    writerProviderId: "claude-code",
    writerModel: "claude",
  });
  cleanup.push(() => host.harness.lifecycle.dispose());
  const { token } = await host.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "dev-orchestrator",
  }) as { token: string };
  const result = await host.harness.registrations.hooks["message.dispatch"]!(
    context("thr_missing", nativeSelectionMarker(token)),
  );
  expect(result).toMatchObject({ action: "reject" });
  expect((result as { message: string }).message).toContain("not installed");
  expect(
    await host.harness.behavior.resolveProviderEnv("claude-code", {
      threadId: "thr_missing",
      hostId: "host_a",
      projectId: "project_a",
    }),
  ).toEqual([]);
});

it("rejects CLI Agents pending at send without clearing it or blocking prepare", async () => {
  const fake = await setup({
    pending: {
      projectId: "project_a",
      hostId: "host_a",
      providerId: "claude-code",
      agentId: "reviewer",
      token: "00000000-0000-0000-0000-000000000099",
    },
  });
  const { token } = await fake.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "dev-orchestrator",
  }) as { token: string };
  const result = await fake.harness.registrations.hooks["message.dispatch"]!(
    context("thr_cli", nativeSelectionMarker(token)),
  );
  expect(result).toMatchObject({ action: "reject" });
  expect((result as { message: string }).message).toContain("does not delete pending");
  expect(fake.rpcCalls.some((row) => row.method === "clearPending")).toBe(false);
});

it("rejects a Lane token or bound thread on a non-Claude provider and leaves ordinary Codex alone", async () => {
  const fake = await setup();
  const { token } = await fake.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "dev-orchestrator",
  }) as { token: string };
  const hook = fake.harness.registrations.hooks["message.dispatch"]!;
  const mentioned = makeMessageDispatchHookContext({
    thread: { id: "thr_codex", projectId: "project_a", providerId: "codex" },
    project: { id: "project_a" },
    host: { id: "host_a" },
    environment: { hostId: "host_a", projectId: "project_a", path: "/workspace", id: "env_native" },
    requestedExecution: { providerId: "codex" },
    input: { text: nativeSelectionMarker(token), blocks: [{ type: "text", text: nativeSelectionMarker(token), mentions: [] }] },
  });
  const mentionedResult = await hook(mentioned);
  expect(mentionedResult).toMatchObject({ action: "reject" });
  expect((mentionedResult as { message: string }).message).toMatch(/Claude Code/);
  expect(await hook(makeMessageDispatchHookContext({
    thread: { id: "thr_plain_codex", projectId: "project_a", providerId: "codex" },
    project: { id: "project_a" },
    host: { id: "host_a" },
    environment: { hostId: "host_a", projectId: "project_a", path: "/workspace", id: "env_plain" },
    requestedExecution: { providerId: "codex" },
    input: { text: "ordinary task", blocks: [{ type: "text", text: "ordinary task", mentions: [] }] },
  }))).toEqual({ action: "proceed" });
  expect(await hook(context("thr_bound", nativeSelectionMarker(token)))).toEqual({ action: "proceed" });
  const rebound = await hook(makeMessageDispatchHookContext({
    thread: { id: "thr_bound", projectId: "project_a", providerId: "codex" },
    project: { id: "project_a" },
    host: { id: "host_a" },
    environment: { hostId: "host_a", projectId: "project_a", path: "/workspace", id: "env_native" },
    requestedExecution: { providerId: "codex" },
    input: { text: "continue", blocks: [{ type: "text", text: "continue", mentions: [] }] },
  }));
  expect(rebound).toMatchObject({ action: "reject" });
  expect((rebound as { message: string }).message).toMatch(/Claude Code/);
});

function coldStart(threadId: string, text: string) {
  return makeMessageDispatchHookContext({
    thread: { id: threadId, projectId: "project_a", providerId: "claude-code", status: "pending" },
    project: { id: "project_a" },
    host: { id: "host_a" },
    environment: null,
    environmentIntent: {
      kind: "provider",
      environmentProviderId: "project-checkout",
      machine: { type: "existing", hostId: "host_a" },
      inputs: { path: "/checkout/selected", sourceId: "src_1" },
    },
    requestedExecution: { providerId: "claude-code" },
    input: { text, blocks: [{ type: "text", text, mentions: [] }] },
  });
}

it("prepares the launcher from project-checkout intent when environment is still null", async () => {
  const fake = await setup();
  const { token } = await fake.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "dev-orchestrator",
  }) as { token: string };
  const hook = fake.harness.registrations.hooks["message.dispatch"]!;
  expect(await hook(coldStart("thr_cold", nativeSelectionMarker(token)))).toEqual({ action: "proceed" });
  expect(fake.prepareCalls).toEqual([{ cwd: "/checkout/selected", agentId: "dev-orchestrator", agentsJson: null }]);
  const activation = getActivation(openDatabase(fake.bb), "project_a");
  expect(activation).toMatchObject({ pm_thread_id: "thr_cold" });
  expect(getRun(openDatabase(fake.bb), activation!.run_id)).toMatchObject({
    kind: "cli",
    writer_environment_id: null,
  });
  expect(await hook(coldStart("thr_cold", nativeSelectionMarker(token)))).toEqual({ action: "proceed" });
  expect(getActivation(openDatabase(fake.bb), "project_a")?.run_id).toBe(activation!.run_id);
  expect(
    await fake.harness.behavior.resolveProviderEnv("claude-code", {
      threadId: "thr_cold",
      hostId: "host_a",
      projectId: "project_a",
    }),
  ).toHaveLength(1);
});

it("rejects a Lane token when neither environment nor project-checkout path is present", async () => {
  const fake = await setup();
  const { token } = await fake.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "dev-orchestrator",
  }) as { token: string };
  const result = await fake.harness.registrations.hooks["message.dispatch"]!(
    makeMessageDispatchHookContext({
      thread: { id: "thr_no_intent", projectId: "project_a", providerId: "claude-code" },
      project: { id: "project_a" },
      host: { id: "host_a" },
      environment: null,
      environmentIntent: null,
      requestedExecution: { providerId: "claude-code" },
      input: { text: nativeSelectionMarker(token), blocks: [{ type: "text", text: nativeSelectionMarker(token), mentions: [] }] },
    }),
  );
  expect(result).toMatchObject({ action: "reject" });
  expect((result as { message: string }).message).toMatch(/project-checkout/);
  expect(getActivation(openDatabase(fake.bb), "project_a")).toBeUndefined();
});

function samepathStart(threadId: string, text: string) {
  return makeMessageDispatchHookContext({
    thread: { id: threadId, projectId: "project_a", providerId: "claude-code", status: "pending" },
    project: { id: "project_a" },
    host: { id: "host_a" },
    environment: null,
    environmentIntent: {
      kind: "provider",
      environmentProviderId: "project-checkout",
      machine: { type: "existing", hostId: "host_a" },
      inputs: {},
    },
    requestedExecution: { providerId: "claude-code" },
    input: { text, blocks: [{ type: "text", text, mentions: [] }] },
  });
}

it("prepares a host-only launcher for samepath before provision and keeps it if late prepare fails", async () => {
  const fake = await setup({ environmentPath: "/checkout/actual", failPrepareWithCwd: true });
  const { token } = await fake.harness.behavior.callRpc("prepare_native_session", {
    projectId: "project_a",
    agentId: "dev-orchestrator",
  }) as { token: string };
  const hook = fake.harness.registrations.hooks["message.dispatch"]!;
  expect(await hook(samepathStart("thr_samepath", nativeSelectionMarker(token)))).toEqual({ action: "proceed" });
  expect(fake.prepareCalls).toEqual([{ cwd: null, agentId: "dev-orchestrator", agentsJson: null }]);
  expect(getActivation(openDatabase(fake.bb), "project_a")).toMatchObject({ pm_thread_id: "thr_samepath" });
  const first = await fake.harness.behavior.resolveProviderEnv("claude-code", {
    threadId: "thr_samepath",
    hostId: "host_a",
    projectId: "project_a",
  });
  expect(first.some((row) => row.name === "BB_CLAUDE_CODE_EXECUTABLE")).toBe(true);
  expect(first[0]?.value).toBe("/launcher");
  expect(fake.prepareCalls).toEqual([
    { cwd: null, agentId: "dev-orchestrator", agentsJson: null },
    { cwd: "/checkout/actual", agentId: "dev-orchestrator", agentsJson: null },
  ]);
});
