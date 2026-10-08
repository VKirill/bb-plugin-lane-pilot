import { describe, expect, it, vi } from "vitest";
import { createOpencodeMinimalEnv } from "../../src/server/opencode-minimal";

// B8 (audit 2026-10-08 round 2): helpers of a fan-out call the contributor together; a failed preparation used to be cached as
// «nothing to do» for 60 s and the helpers went on with the machine's full config, silently.
const PREPARED = { configHome: "/data/opencode-min/abc", kept: ["./plugins/opencode-lane.ts"], left: ["cursor-acp"] };

function setup(callHost: (calls: number) => Promise<unknown>, options: { role?: string | null; metadataFails?: boolean } = {}) {
  let calls = 0;
  const warns: string[] = [];
  const bb = {
    log: { warn: (line: string) => warns.push(line), info: () => undefined },
    sdk: { threads: {
      getPluginMetadata: async () => { if (options.metadataFails) throw new Error("metadata unavailable"); return options.role === null ? {} : { role: options.role ?? "writer" }; },
      defaultExecutionOptions: async () => ({ model: "router9/x" }),
    } },
  };
  const host = { call: vi.fn(async () => { calls += 1; return await callHost(calls); }) };
  let clock = 1_000;
  const contribute = createOpencodeMinimalEnv({ bb, host } as never, () => clock, async () => undefined);
  return { contribute, host, warns, advance: (ms: number) => { clock += ms; } };
}

describe("the minimal OpenCode config of a helper", () => {
  it("shares one preparation between helpers that ask at the same moment, and remembers a success for a minute", async () => {
    let release: (value: unknown) => void = () => undefined;
    const { contribute, host, advance } = setup((calls) => calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ result: PREPARED }));
    const asks = Array.from({ length: 8 }, (_, index) => contribute({ threadId: `thr_${index}`, hostId: "ovh" }));
    await vi.waitFor(() => expect(host.call).toHaveBeenCalledTimes(1));
    release({ result: PREPARED });
    const answers = await Promise.all(asks);
    expect(answers.every((entries) => entries[0]?.name === "XDG_CONFIG_HOME" && entries[0].value === PREPARED.configHome)).toBe(true);
    expect(host.call).toHaveBeenCalledTimes(1);
    await contribute({ threadId: "thr_late", hostId: "ovh" });
    expect(host.call).toHaveBeenCalledTimes(1);
    advance(61_000);
    await contribute({ threadId: "thr_later", hostId: "ovh" });
    expect(host.call).toHaveBeenCalledTimes(2);
  });

  it("tries again after a failure and uses the answer that comes", async () => {
    const { contribute, host } = setup(async (calls) => { if (calls < 3) throw new Error("rename ENOENT"); return { result: PREPARED }; });
    expect((await contribute({ threadId: "thr_1", hostId: "ovh" }))[0]?.value).toBe(PREPARED.configHome);
    expect(host.call).toHaveBeenCalledTimes(3);
  });

  it("refuses to start the helper with a clear reason when the preparation keeps failing, and does not cache the failure", async () => {
    let healthy = false;
    const { contribute, host, warns } = setup(async () => { if (!healthy) throw new Error("rename ENOENT"); return { result: PREPARED }; });
    await expect(contribute({ threadId: "thr_1", hostId: "ovh" })).rejects.toThrow(/opencode_minimal_config_failed:ovh: rename ENOENT \(after 3 tries\)/);
    expect(host.call).toHaveBeenCalledTimes(3);
    expect(warns.join("\n")).toContain("not started with the machine's full config");
    healthy = true;
    expect((await contribute({ threadId: "thr_2", hostId: "ovh" }))[0]?.value).toBe(PREPARED.configHome);
  });

  it("leaves the machine's config alone when the machine says there is nothing to leave out, and for threads that are not Lane Pilot's", async () => {
    const nothing = setup(async () => ({ result: null }));
    expect(await nothing.contribute({ threadId: "thr_1", hostId: "ovh" })).toEqual([]);
    const owners = setup(async () => ({ result: PREPARED }), { role: null });
    expect(await owners.contribute({ threadId: "thr_own", hostId: "ovh" })).toEqual([]);
    expect(owners.host.call).not.toHaveBeenCalled();
  });

  it("says so in the log when it cannot tell whether a thread is a helper", async () => {
    const { contribute, warns } = setup(async () => ({ result: PREPARED }), { metadataFails: true });
    expect(await contribute({ threadId: "thr_1", hostId: "ovh" })).toEqual([]);
    expect(warns.join("\n")).toContain("could not tell whether OpenCode thread thr_1 is a helper");
  });
});
