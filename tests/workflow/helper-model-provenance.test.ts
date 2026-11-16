import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowAgents, withResolvedModel, type HelperRequest } from "../../src/rooms/workflow/server/workflow-agent";
import { fullAccessSpawn } from "../../src/rooms/platform/server";

vi.mock("../../src/rooms/platform/server", async (original) => ({
  ...(await original<typeof import("../../src/rooms/platform/server")>()),
  fullAccessSpawn: vi.fn(async () => ({ id: "thr-new" })),
  findThreadsByMetadata: vi.fn(async () => null),
  projectFolder: vi.fn(async () => ({ hostId: "host-a", path: "/workspace" })),
}));
vi.mock("../../src/rooms/runs/server", async (original) => ({
  ...(await original<typeof import("../../src/rooms/runs/server")>()),
  requireHelperSpawn: () => ({ mode: "optional", policy: null }),
  helperChildPlacement: async () => ({ projectId: "project" }),
  requiredPolicyField: () => ({}),
}));

const base = (rt: unknown, extra: Record<string, unknown> = {}) => ({
  rt,
  workflowRunId: "workflow-run",
  stepKey: "step#1",
  nodeId: "step",
  spawnKey: "spawn",
  role: "analyst",
  title: "A helper",
  prompt: "Do the work",
  fields: [],
  ...extra,
}) as unknown as HelperRequest;

function world(settings: Record<string, unknown> = {}) {
  const bb = {
    log: { warn: vi.fn() },
    storage: { kv: { get: async () => null, set: async () => undefined } },
    sdk: {
      threads: {
        get: async () => ({ id: "pm", environmentId: "env", status: "idle" }),
        send: vi.fn(async () => ({})),
        output: async () => ({ output: "```json\n{}\n```" }),
      },
      events: { list: async () => ({ events: [] }) },
      environments: { get: async () => ({ id: "env", hostId: "host-a", path: "/workspace" }) },
      hosts: { list: async () => [] },
    },
  };
  const rt = {
    pmThreadId: "pm", projectId: "project", runId: "run",
    ctx: {
      bb,
      host: { call: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      db: { prepare: () => ({ get: () => undefined }) },
      log: () => undefined,
      isDisposed: () => false,
      effectiveProjectSettings: async () => ({ values: settings }),
      ownedAgents: async () => ({}),
    },
  };
  return { bb, rt };
}

beforeEach(() => vi.clearAllMocks());

describe("generic workflow helper model provenance", () => {
  it("retains resolver source, diagnostics, and selected host without settings", async () => {
    const { rt } = world();
    const resolved = await withResolvedModel(base(rt));
    expect(resolved.modelResolution).toEqual({
      role: "analyst",
      requested: {},
      resolved: {
        providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", serviceTier: null,
        source: "role-default", sourceKey: null, inherited: true, issues: [], hostId: "host-a",
      },
    });
    expect(resolved.modelResolution).not.toHaveProperty("settings");
  });

  it("captures a provider-start fallback while preserving the original request", async () => {
    vi.mocked(fullAccessSpawn).mockReset()
      .mockRejectedValueOnce(new Error("vk_required_session_policy_unenforceable"))
      .mockResolvedValueOnce({ id: "thr-fallback" } as never);
    const { rt } = world({ "role_model.analyst": { model: "gpt-6.1-sol" } });
    await createWorkflowAgents().run(base(rt, { provider: "codex", model: "gpt-6.1-sol", reasoning: "medium" })).catch(() => undefined);
    const args = vi.mocked(fullAccessSpawn).mock.calls.at(-1)?.[1] as { pluginMetadata?: Record<string, unknown> } | undefined;
    expect(args?.pluginMetadata?.modelResolution).toMatchObject({
      role: "analyst",
      requested: { providerId: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" },
      reason: "provider_start_failure",
      resolved: { providerId: "claude-code", model: "claude-opus-5-5", hostId: "host-a" },
    });
  });

  it("captures a provider-limit fallback while preserving the original request", async () => {
    vi.mocked(fullAccessSpawn).mockReset()
      .mockResolvedValueOnce({ id: "thr-limit" } as never)
      .mockResolvedValueOnce({ id: "thr-fallback" } as never);
    const { rt, bb } = world();
    (bb.sdk.threads as unknown as { events: { list: unknown } }).events = { list: vi.fn(async ({ threadId }: { threadId: string }) => [
      { type: "turn/started", threadId, seq: 1 },
      { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
    ]) };
    bb.sdk.threads.output = vi.fn()
      .mockResolvedValueOnce({ output: "Upgrade your plan to continue" })
      .mockResolvedValueOnce({ output: "```json\n{}\n```" });
    await createWorkflowAgents().run(base(rt, { provider: "codex", model: "gpt-6.1-sol", reasoning: "medium" })).catch(() => undefined);
    const args = vi.mocked(fullAccessSpawn).mock.calls.at(-1)?.[1] as { pluginMetadata?: Record<string, unknown> } | undefined;
    expect(args?.pluginMetadata?.modelResolution).toMatchObject({
      role: "analyst",
      requested: { providerId: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" },
      reason: "provider_limit",
      resolved: { providerId: "claude-code", model: "claude-opus-5-5", hostId: "host-a" },
    });
  });

  it("does not write a new passport when continuing an existing thread", async () => {
    const { rt, bb } = world();
    await createWorkflowAgents().run(base(rt, { resolved: true, intoThread: "thr-existing", provider: "codex", model: "gpt-6.1-sol" })).catch(() => undefined);
    expect(fullAccessSpawn).not.toHaveBeenCalled();
    expect(vi.mocked(bb.sdk.threads.send)).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr-existing" }));
  });
});
