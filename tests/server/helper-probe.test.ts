import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit 2026-10-08 round 3, P0-7: `bb lane-pilot helper-probe` starts a helper the way the pm-read stage does and checks it answered.
const spawn = vi.fn();
const waitIdle = vi.fn();
vi.mock("../../src/server/pm-spawn", () => ({ fullAccessSpawn: (bb: unknown, args: unknown) => spawn(bb, args) }));
vi.mock("@lane-pilot/thread-observe", () => ({ waitThreadIdle: (...args: unknown[]) => waitIdle(...args) }));
vi.mock("../../src/server/run-routing", () => ({
  requireHelperSpawn: () => ({ mode: "roles", policy: { required: true } }),
  requiredPolicyField: (_bb: unknown, _snapshot: unknown, providerId: string, role: string) => ({ sessionPolicy: `${providerId}:${role}` }),
  helperChildPlacement: async () => ({ parentThreadId: "thr_pm", projectId: "proj_1" }),
}));
vi.mock("../../src/rooms/storage/database", () => ({
  loadPrototypeConfig: (_db: unknown, projectId: string) => projectId === "proj_1" ? { hostId: "host_1", writerWorkspacePath: "/work/p" } : null,
  getRun: (_db: unknown, runId: string) => runId === "lprun_1" ? { id: "lprun_1", project_id: "proj_1", pm_thread_id: "thr_pm" } : undefined,
}));

const { createHelperProbe } = await import("../../src/server/helper-probe");

function setup(options: { available?: boolean; models?: Array<{ id: string; model: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }> }>; output?: unknown } = {}) {
  const calls: string[] = [];
  const bb = { sdk: {
    providers: {
      list: async () => [{ id: "acp-opencode", available: options.available ?? true }],
      models: async () => ({ models: options.models ?? [{ id: "glm", model: "zai/glm", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "low" }] }] }),
    },
    threads: {
      output: async () => ({ output: options.output === undefined ? "OK" : options.output }),
      stop: async () => { calls.push("stop"); },
      archive: async () => { calls.push("archive"); },
    },
  } };
  return { probe: createHelperProbe({ bb, db: {} } as never).startHelperProbe, calls };
}

beforeEach(() => {
  spawn.mockReset().mockResolvedValue({ id: "thr_probe" });
  waitIdle.mockReset().mockResolvedValue(undefined);
});

describe("the helper probe", () => {
  it("spawns a pm-reader the way the pm-read stage does and reports the answer", async () => {
    const { probe, calls } = setup();
    const result = await probe("proj_1", "lprun_1", "acp-opencode", "zai/glm");
    expect(result).toMatchObject({ ok: true, started: true, answered: true, threadId: "thr_probe", output: "OK", reason: null, providerId: "acp-opencode" });
    const args = spawn.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).toMatchObject({
      providerId: "acp-opencode", model: "zai/glm", reasoningLevel: "low", sessionPolicy: "acp-opencode:pm-reader",
      environment: { type: "host", hostId: "host_1", workspace: { type: "unmanaged", path: "/work/p" } },
      pluginMetadata: expect.objectContaining({ role: "pm-reader", stageId: "pm-read", lanePilotRunId: "lprun_1", parentPmThreadId: "thr_pm", helperProbe: true }),
    });
    expect(calls).toEqual(["stop", "archive"]);
  });

  it("says the helper did not start when the provider refuses the spawn, and names the reason", async () => {
    spawn.mockRejectedValue(new Error("opencode_minimal_config_failed:host_1: unknown input requestedHostId"));
    const { probe } = setup();
    const result = await probe("proj_1", "lprun_1", "acp-opencode", "zai/glm");
    expect(result).toMatchObject({ ok: false, started: false, answered: false, threadId: null });
    expect(result.reason).toContain("opencode_minimal_config_failed");
  });

  it("says it started but did not answer when the thread never goes idle or answers nothing", async () => {
    waitIdle.mockRejectedValue(new Error("helper_probe_timeout"));
    const timedOut = await setup().probe("proj_1", "lprun_1", "acp-opencode", "zai/glm");
    expect(timedOut).toMatchObject({ ok: false, started: true, answered: false, threadId: "thr_probe", reason: "helper_probe_timeout" });
    waitIdle.mockResolvedValue(undefined);
    const empty = await setup({ output: "  " }).probe("proj_1", "lprun_1", "acp-opencode", "zai/glm");
    expect(empty).toMatchObject({ ok: false, started: true, answered: false, reason: "helper_probe_output_empty" });
  });

  it("refuses an unknown run, an unconfigured project, a provider that is not available and a model it does not offer", async () => {
    expect((await setup().probe("proj_1", "lprun_other", "acp-opencode", "zai/glm")).reason).toMatch(/helper_probe_run_unusable/);
    expect((await setup().probe("proj_none", "lprun_1", "acp-opencode", "zai/glm")).reason).toMatch(/helper_probe_project_not_configured/);
    expect((await setup({ available: false }).probe("proj_1", "lprun_1", "acp-opencode", "zai/glm")).reason).toMatch(/helper_probe_provider_unavailable/);
    expect((await setup().probe("proj_1", "lprun_1", "acp-opencode", "no-such-model")).reason).toMatch(/helper_probe_model_unavailable/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
