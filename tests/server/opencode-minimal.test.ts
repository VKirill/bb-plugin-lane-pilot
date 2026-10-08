import { describe, expect, it, vi } from "vitest";
import { createOpencodeMinimalEnv, mountOpencodeMinimal, OPENCODE_PROVIDER_ID } from "../../src/server/opencode-minimal";

function setup(options: { role?: string | null; model?: string | null; host?: (method: string, input: unknown) => unknown } = {}) {
  const calls: Array<{ method: string; input: Record<string, unknown>; hostId: string }> = [];
  const host = {
    call: vi.fn(async (method: string, input: Record<string, unknown>, opts: { hostId: string }) => {
      calls.push({ method, input, hostId: opts.hostId });
      if (options.host) return options.host(method, input);
      return { result: { configHome: "/data/opencode-min/abc", kept: ["./plugins/opencode-lane.ts"], left: ["cursor-acp"] } };
    }),
  };
  const bb = {
    sdk: {
      threads: {
        getPluginMetadata: async () => (options.role === null ? null : { role: options.role ?? "plan-critic" }),
        defaultExecutionOptions: async () => (options.model === null ? null : { providerId: "acp-opencode", model: options.model ?? "router9/ag/gemini-3.8-flash-high" }),
      },
    },
  };
  let clock = 1_000;
  const resolve = createOpencodeMinimalEnv({ bb, host } as never, () => clock);
  return { resolve, calls, host, tick: (ms: number) => { clock += ms; } };
}

describe("OpenCode helpers get a minimal config home", () => {
  it("adds XDG_CONFIG_HOME for a thread Lane Pilot started, asking the thread's machine with its model", async () => {
    const { resolve, calls } = setup();
    const entries = await resolve({ threadId: "thr_1", hostId: "host_ovh" });
    expect(entries).toEqual([{ name: "XDG_CONFIG_HOME", value: "/data/opencode-min/abc", reason: expect.stringContaining("minimal config") }]);
    expect(entries[0]!.reason).toContain("left out cursor-acp");
    expect(calls).toEqual([{ method: "prepareOpencodeMinimal", input: { requestedHostId: "host_ovh", model: "router9/ag/gemini-3.8-flash-high" }, hostId: "host_ovh" }]);
  });

  it("leaves the owner's own OpenCode chats alone", async () => {
    const { resolve, calls } = setup({ role: null });
    expect(await resolve({ threadId: "thr_own", hostId: "host_ovh" })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("adds nothing when the machine has nothing to leave out, cannot answer, or does not know the call yet", async () => {
    expect(await setup({ host: () => ({ result: null }) }).resolve({ threadId: "t", hostId: "h" })).toEqual([]);
    expect(await setup({ host: () => { throw new Error("unknown host method prepareOpencodeMinimal"); } }).resolve({ threadId: "t", hostId: "h" })).toEqual([]);
  });

  it("asks a machine once a minute per provider of the model, not on every turn", async () => {
    const { resolve, calls, tick } = setup();
    await resolve({ threadId: "t1", hostId: "h" });
    await resolve({ threadId: "t2", hostId: "h" });
    expect(calls).toHaveLength(1);
    tick(61_000);
    await resolve({ threadId: "t3", hostId: "h" });
    expect(calls).toHaveLength(2);
    await resolve({ threadId: "t4", hostId: "other" });
    expect(calls).toHaveLength(3);
  });

  it("registers for the OpenCode provider", () => {
    const registered: string[] = [];
    mountOpencodeMinimal({ bb: { providers: { experimental_contributeEnv: (id: string) => registered.push(id) }, sdk: { threads: {} } }, host: { call: vi.fn() } } as never);
    expect(registered).toEqual([OPENCODE_PROVIDER_ID]);
    expect(OPENCODE_PROVIDER_ID).toBe("acp-opencode");
  });
});
