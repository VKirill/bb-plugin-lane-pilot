import { describe, expect, it, vi } from "vitest";
import { BB_SHIM_PROVIDER_IDS, createBbShimEnv, mountBbShim } from "../../src/server/helper-bb-shim";
import { mountOpencodeMinimal } from "../../src/server/opencode-minimal";

// Audit 2026-10-08 round 3, P0-2: Codex, OpenCode and Cursor threads of Lane Pilot get the bb guard wrappers first on PATH.
const SHIM = { dir: "/data/bb-shim", path: "/data/bb-shim:/usr/local/bin:/usr/bin" };

function setup(callHost: () => Promise<unknown> = async () => SHIM, options: { role?: string | null; metadataFails?: boolean } = {}) {
  const warns: string[] = [];
  const bb = {
    log: { warn: (line: string) => warns.push(line), info: () => undefined },
    sdk: { threads: {
      getPluginMetadata: async () => { if (options.metadataFails) throw new Error("metadata unavailable"); return options.role === null ? {} : { role: options.role ?? "writer" }; },
      defaultExecutionOptions: async () => ({ model: "router9/x" }),
    } },
  };
  const host = { call: vi.fn(callHost) };
  let clock = 1_000;
  return { contribute: createBbShimEnv({ bb, host } as never, () => clock), host, warns, advance: (ms: number) => { clock += ms; } };
}

describe("the bb guard wrappers of a Codex, OpenCode or Cursor thread", () => {
  it("puts the machine's wrapper PATH on a writer or helper thread", async () => {
    for (const role of ["writer", "pm-reader", "plan-critic", "code-critic", "specialist", "self-repair", "docs-nightly"]) {
      const { contribute, host } = setup(undefined, { role });
      const entries = await contribute({ threadId: "thr_1", hostId: "ovh" });
      expect(entries).toEqual([expect.objectContaining({ name: "PATH", value: SHIM.path })]);
      expect(entries[0]!.reason).toContain(role);
      expect(host.call).toHaveBeenCalledWith("prepareBbShim", { requestedHostId: "ovh" }, expect.objectContaining({ hostId: "ovh" }));
    }
  });

  it("leaves the owner's own chats and the PM alone", async () => {
    const owners = setup(undefined, { role: null });
    expect(await owners.contribute({ threadId: "thr_1", hostId: "ovh" })).toEqual([]);
    const pm = setup(undefined, { role: "pm" });
    expect(await pm.contribute({ threadId: "thr_2", hostId: "ovh" })).toEqual([]);
    expect(owners.host.call).not.toHaveBeenCalled();
    expect(pm.host.call).not.toHaveBeenCalled();
  });

  it("shares one preparation per machine and remembers it for a minute", async () => {
    const { contribute, host, advance } = setup();
    await Promise.all(Array.from({ length: 6 }, (_, index) => contribute({ threadId: `thr_${index}`, hostId: "ovh" })));
    expect(host.call).toHaveBeenCalledTimes(1);
    await contribute({ threadId: "thr_late", hostId: "mini" });
    expect(host.call).toHaveBeenCalledTimes(2);
    await contribute({ threadId: "thr_again", hostId: "ovh" });
    expect(host.call).toHaveBeenCalledTimes(2);
    advance(61_000);
    await contribute({ threadId: "thr_later", hostId: "ovh" });
    expect(host.call).toHaveBeenCalledTimes(3);
  });

  it("refuses to start the thread when the machine cannot prepare the wrappers, and tries again next time", async () => {
    let healthy = false;
    const { contribute } = setup(async () => { if (!healthy) throw new Error("EACCES: permission denied, mkdir"); return SHIM; });
    await expect(contribute({ threadId: "thr_1", hostId: "ovh" })).rejects.toThrow(/bb_shim_failed:ovh: EACCES/);
    healthy = true;
    expect((await contribute({ threadId: "thr_2", hostId: "ovh" }))[0]?.value).toBe(SHIM.path);
  });

  it("lets a thread on a host that does not know the call yet start, and logs it", async () => {
    const { contribute, warns } = setup(async () => { throw new Error("unknown host method prepareBbShim"); });
    expect(await contribute({ threadId: "thr_1", hostId: "old" })).toEqual([]);
    expect(warns.join("\n")).toContain("does not know prepareBbShim");
  });

  it("starts without the wrappers, and says so, when the thread's metadata cannot be read", async () => {
    const { contribute, warns, host } = setup(undefined, { metadataFails: true });
    expect(await contribute({ threadId: "thr_1", hostId: "ovh" })).toEqual([]);
    expect(warns.join("\n")).toContain("without the bb guard wrappers");
    expect(host.call).not.toHaveBeenCalled();
  });
});

describe("which providers get the wrappers", () => {
  function mounted(mount: (ctx: never) => void) {
    const registered = new Map<string, (context: { threadId: string; hostId: string }) => unknown>();
    const bb = {
      log: { warn: () => undefined, info: () => undefined },
      providers: { experimental_contributeEnv: (id: string, resolve: never) => { registered.set(id, resolve); } },
      sdk: { threads: { getPluginMetadata: async () => ({ role: "writer" }), defaultExecutionOptions: async () => ({ model: "router9/x" }) } },
      background: { schedule: () => undefined },
      onDispose: () => undefined,
    };
    const host = { call: vi.fn(async (method: string) => method === "prepareBbShim" ? SHIM : { result: { configHome: "/data/opencode-min/abc", kept: [], left: [] } }) };
    mount({ bb, host } as never);
    return { registered, host };
  }

  it("Codex and Cursor through their own resolver", async () => {
    const { registered } = mounted(mountBbShim);
    expect([...registered.keys()].sort()).toEqual([...BB_SHIM_PROVIDER_IDS].sort());
    expect(BB_SHIM_PROVIDER_IDS).toEqual(expect.arrayContaining(["codex", "acp-cursor"]));
    expect(await registered.get("codex")!({ threadId: "thr_1", hostId: "ovh" })).toEqual([expect.objectContaining({ name: "PATH", value: SHIM.path })]);
  });

  it("OpenCode through the one resolver it has, next to its minimal config", async () => {
    const { registered, host } = mounted(mountOpencodeMinimal);
    expect([...registered.keys()]).toEqual(["acp-opencode"]);
    const entries = await registered.get("acp-opencode")!({ threadId: "thr_1", hostId: "ovh" }) as Array<{ name: string; value: string }>;
    expect(entries.map((entry) => entry.name).sort()).toEqual(["PATH", "XDG_CONFIG_HOME"]);
    expect(entries.find((entry) => entry.name === "PATH")!.value).toBe(SHIM.path);
    expect(host.call.mock.calls.map((call) => call[0]).sort()).toEqual(["prepareBbShim", "prepareOpencodeMinimal"]);
  });
});
