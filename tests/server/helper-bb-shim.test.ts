import { describe, expect, it, vi } from "vitest";
import { BB_SHIM_PROVIDER_IDS, createBbShimEnv, createRoleMarkerEnv, mountBbShim } from "../../src/rooms/native-agent/server/helper-bb-shim";
import { nativeContributedEnv } from "../../src/rooms/native-agent/native-dispatch";

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
      expect(entries).toEqual([expect.objectContaining({ name: "LANE_PILOT_ROLE", value: role }), expect.objectContaining({ name: "PATH", value: SHIM.path })]);
      expect(entries[1]!.reason).toContain(role);
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
    expect((await contribute({ threadId: "thr_2", hostId: "ovh" }))[1]?.value).toBe(SHIM.path);
  });

  it("lets a thread on a host that does not know the call yet start, and logs it", async () => {
    const { contribute, warns } = setup(async () => { throw new Error("unknown host method prepareBbShim"); });
    // The lane marker still goes out: the machine's lane plugins must know it is a Lane Pilot thread.
    expect(await contribute({ threadId: "thr_1", hostId: "old" })).toEqual([expect.objectContaining({ name: "LANE_PILOT_ROLE", value: "writer" })]);
    expect(warns.join("\n")).toContain("does not know prepareBbShim");
  });

  it("starts without the wrappers, and says so, when the thread's metadata cannot be read", async () => {
    const { contribute, warns, host } = setup(undefined, { metadataFails: true });
    expect(await contribute({ threadId: "thr_1", hostId: "ovh" })).toEqual([]);
    expect(warns.join("\n")).toContain("without the bb guard wrappers");
    expect(host.call).not.toHaveBeenCalled();
  });
});

// Night repair 2026-10-27 (class log:ebdc80fdb6ec, 194 warnings a day): BB's model catalog (core resolveCatalogLaunch) runs every provider
// env resolver with threadId null, projectId null to fingerprint the catalog launch. No thread starts there, so there is nothing to mark
// or wrap; asking for the metadata of thread null only got HTTP 404 and a warning that a thread starts without the guard wrappers.
describe("a provider launch with no thread (BB's model catalog)", () => {
  const catalogLaunch = { threadId: null, projectId: null, hostId: "host_rwrxyi39aw" } as never;
  const notFound = vi.fn(async () => { throw new Error("HTTP 404: Thread not found"); });

  it("Codex, OpenCode and Cursor contribute nothing, quietly, and ask neither BB nor the machine", async () => {
    const warns: string[] = [];
    const host = { call: vi.fn(async () => SHIM) };
    const contribute = createBbShimEnv({ bb: { log: { warn: (line: string) => warns.push(line), info: () => undefined }, sdk: { threads: { getPluginMetadata: notFound } } }, host } as never);
    expect(await contribute(catalogLaunch, "opencode2")).toEqual([]);
    expect(warns).toEqual([]);
    expect(notFound).not.toHaveBeenCalled();
    expect(host.call).not.toHaveBeenCalled();
  });

  it("Claude Code's lane marker contributes nothing and does not ask BB", async () => {
    const getPluginMetadata = vi.fn(async () => { throw new Error("HTTP 404: Thread not found"); });
    expect(await createRoleMarkerEnv({ bb: { sdk: { threads: { getPluginMetadata } } } } as never)(catalogLaunch)).toEqual([]);
    expect(getPluginMetadata).not.toHaveBeenCalled();
  });

  it("Claude Code's native session env contributes nothing and reads no thread state", async () => {
    const kvGet = vi.fn(async () => null);
    const host = { call: vi.fn(async () => ({ env: [], agentId: "x" })) };
    expect(await nativeContributedEnv({ storage: { kv: { get: kvGet } }, sdk: { threads: { get: notFound } } } as never, host as never, catalogLaunch)).toEqual([]);
    expect(kvGet).not.toHaveBeenCalled();
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
        const host = { call: vi.fn(async () => SHIM) };
    mount({ bb, host } as never);
    return { registered, host };
  }

  it("Codex, OpenCode and Cursor through their own resolver", async () => {
    const { registered } = mounted(mountBbShim);
    expect([...registered.keys()].sort()).toEqual([...BB_SHIM_PROVIDER_IDS].sort());
    expect(BB_SHIM_PROVIDER_IDS).toEqual(expect.arrayContaining(["codex", "opencode2", "acp-cursor", "devin"]));
    expect(await registered.get("codex")!({ threadId: "thr_1", hostId: "ovh" })).toEqual([expect.objectContaining({ name: "LANE_PILOT_ROLE", value: "writer" }), expect.objectContaining({ name: "PATH", value: SHIM.path })]);
  });

  it("a Claude Code thread Lane Pilot started gets the lane marker alone, no PATH shim; the PM and the owner's chats get nothing", async () => {
    const marker = (role: string | null) => createRoleMarkerEnv({ bb: { sdk: { threads: { getPluginMetadata: async () => (role ? { role } : {}) } } } } as never);
    expect(await marker("code-critic")({ threadId: "thr_2", hostId: "mini" })).toEqual([expect.objectContaining({ name: "LANE_PILOT_ROLE", value: "code-critic" })]);
    expect(await marker("pm")({ threadId: "thr_3", hostId: "mini" })).toEqual([]);
    expect(await marker(null)({ threadId: "thr_4", hostId: "mini" })).toEqual([]);
  });
});
