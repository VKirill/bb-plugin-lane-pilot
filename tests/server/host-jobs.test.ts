import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { createCore } from "../../src/server/core";
import { createHostJobs } from "../../src/server/host-jobs";

type Reply = { state:"running" | "succeeded" | "failed" | "cancelled" | "lost"; result?:unknown; error:string | null; progress:{ updatedAt:number } };

/** A host with scripted job replies, and a clock that only moves when the poll loop sleeps. */
function setup(replies:Reply[], extra:{ disposed?:() => boolean; startError?:string } = {}) {
  const calls:Array<{ method:string; input:Record<string, unknown> }> = [];
  const store = new Map<string, unknown>();
  const sleeps:number[] = [];
  let clock = 1_000_000;
  const script = [...replies];
  const jobs = createHostJobs({
    call: async (method, input) => {
      calls.push({ method, input:input as Record<string, unknown> });
      if (method === "jobStart") {
        if (extra.startError) throw new Error(extra.startError);
        return { hostId:"h", jobId:"job_abcdefghij1" };
      }
      if (method === "jobStatus") return script.length > 1 ? script.shift()! : script[0]!;
      return { hostId:"h", jobId:"job_abcdefghij1", cancelled:true };
    },
    kv: { get: async <T>(key:string) => store.get(key) as T | undefined, set: async (key, value) => { store.set(key, value); }, delete: async (key) => { store.delete(key); } },
    disposed: extra.disposed ?? (() => false),
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  return { jobs, calls, store, sleeps, advance: (ms:number) => { clock += ms; }, clock: () => clock };
}
const reply = (state:Reply["state"], extra:Partial<Reply> = {}, at = 1_000_000):Reply => ({ state, error:null, progress:{ updatedAt:at }, ...extra });
/** The KV entries a server leaves when the plugin reloads while it polls a job. */
async function interrupted(kind:Parameters<ReturnType<typeof setup>["jobs"]["run"]>[0], input:unknown) {
  const t = setup([reply("running")], { disposed:() => true });
  await expect(t.jobs.run(kind, input, options, never)).rejects.toThrow(/plugin is reloading/);
  expect(t.store.size).toBe(1);
  return [...t.store];
}
const never = async () => { throw new Error("the direct call must not run"); };
const options = { hostId:"h", timeoutMs:30_000 };

describe("host calls as background jobs", () => {
  it("starts the job, polls with growing waits, returns the result and forgets the id", async () => {
    const t = setup([reply("running"), reply("running"), reply("running"), reply("succeeded", { result:{ status:"merged" } })]);
    const out = await t.jobs.run("gitIntegrate", { basePath:"/b" }, options, never);
    expect(out).toEqual({ status:"merged" });
    expect(t.calls.map((call) => call.method)).toEqual(["jobStart", "jobStatus", "jobStatus", "jobStatus", "jobStatus"]);
    expect(t.calls[0]!.input).toMatchObject({ requestedHostId:"h", kind:"gitIntegrate", input:{ basePath:"/b" } });
    expect(t.sleeps).toEqual([500, 750, 1125]);
    expect(t.store.size).toBe(0);
  });

  it("waits longer than the caller's own timeout for work the caller sized for a short call", async () => {
    const t = setup([reply("running")]);
    const run = t.jobs.run("detect", {}, { hostId:"h", timeoutMs:30_000 }, never);
    await expect(run).rejects.toThrow(/timed out after 180 s/);
    expect(t.calls.at(-1)!.method).toBe("jobCancel");
    expect(t.store.size).toBe(0);
  });

  it("carries on with the job a reload left behind instead of starting another", async () => {
    const entries = await interrupted("gitPrepareWorktree", { w:1 });
    const t = setup([reply("running"), reply("succeeded", { result:{ linked:[] } })]);
    for (const [key, value] of entries) t.store.set(key, value);
    expect(await t.jobs.run("gitPrepareWorktree", { w:1 }, options, never)).toEqual({ linked:[] });
    expect(t.calls.map((call) => call.method)).not.toContain("jobStart");
    expect(t.store.size).toBe(0);
  });

  it("reuses a job that finished just before the restart, but not an old one", async () => {
    const entries = await interrupted("gitIntegrate", { m:1 });
    const recent = setup([reply("succeeded", { result:"merged" }, 1_000_000 - 60_000)]);
    for (const [key, value] of entries) recent.store.set(key, value);
    expect(await recent.jobs.run("gitIntegrate", { m:1 }, options, never)).toBe("merged");
    expect(recent.calls.map((call) => call.method)).toEqual(["jobStatus"]);

    const old = setup([reply("succeeded", { result:"stale" }, 1_000_000 - 3_600_000), reply("succeeded", { result:"new" })]);
    for (const [key, value] of entries) old.store.set(key, value);
    expect(await old.jobs.run("gitIntegrate", { m:1 }, options, never)).toBe("new");
    expect(old.calls.map((call) => call.method)).toEqual(["jobStatus", "jobStart", "jobStatus"]);
  });

  it("never hands a finished check to another call with the same input (the second merge's post-merge check)", async () => {
    // The first call was cut by a reload and left its finished green job behind.
    const first = setup([reply("running")], { disposed:() => true });
    await first.jobs.run("runSandboxedCommand", { c:"npm test" }, options, never, "post-merge:a1:sha1").catch(() => undefined);
    const entries = [...first.store];
    const finished = reply("succeeded", { result:{ exitCode:0 } });

    // Another merge (other commit) with the same command starts its own job and does not read the first job's answer.
    const second = setup([finished, reply("succeeded", { result:{ exitCode:1 } })]);
    for (const [key, value] of entries) second.store.set(key, value);
    expect(await second.jobs.run("runSandboxedCommand", { c:"npm test" }, options, never, "post-merge:a2:sha2")).toEqual({ exitCode:0 });
    expect(second.calls.map((call) => call.method)).toContain("jobStart");

    // The same call after the reload takes its own finished job again.
    const same = setup([finished]);
    for (const [key, value] of entries) same.store.set(key, value);
    expect(await same.jobs.run("runSandboxedCommand", { c:"npm test" }, options, never, "post-merge:a1:sha1")).toEqual({ exitCode:0 });
    expect(same.calls.map((call) => call.method)).toEqual(["jobStatus"]);
  });

  it("does not reuse a finished sandbox check that carries no call key", async () => {
    const entries = await interrupted("runSandboxedCommand", { c:"npm test" });
    const t = setup([reply("succeeded", { result:{ exitCode:0 } })]);
    for (const [key, value] of entries) t.store.set(key, value);
    await t.jobs.run("runSandboxedCommand", { c:"npm test" }, options, never);
    expect(t.calls.map((call) => call.method)).toEqual(["jobStatus", "jobStart", "jobStatus"]);
  });

  it("throws a failed job's own message so callers keep classifying failures by it", async () => {
    const t = setup([reply("failed", { error:"sandbox_backend_unavailable: Seatbelt launch was denied by the host" })]);
    await expect(t.jobs.run("runSandboxedCommand", {}, options, never)).rejects.toThrow("sandbox_backend_unavailable: Seatbelt launch was denied by the host");
    expect(t.store.size).toBe(0);
  });

  it("says a lost or cancelled job is lost or cancelled", async () => {
    await expect(setup([reply("lost", { error:"the job process is gone without a result" })]).jobs.run("install", {}, options, never)).rejects.toThrow(/job lost/);
    await expect(setup([reply("cancelled", { error:"cancelled" })]).jobs.run("install", {}, options, never)).rejects.toThrow(/job cancelled/);
  });

  it("gives up at the deadline and cancels the job", async () => {
    const t = setup([reply("running")]);
    await expect(t.jobs.run("runBrowserQa", {}, { hostId:"h", timeoutMs:100_000 }, never)).rejects.toThrow(/timed out after 160 s/);
    expect(t.calls.at(-1)).toMatchObject({ method:"jobCancel", input:{ jobId:"job_abcdefghij1" } });
  });

  it("falls back to the ordinary call on a host that has no jobs yet", async () => {
    const t = setup([], { startError:'unknown host method "jobStart"' });
    expect(await t.jobs.run("detect", {}, options, async () => "direct")).toBe("direct");
  });

  it("keeps the job's id when the host cannot answer, so the retry finds the same job", async () => {
    const t = setup([reply("running")], { disposed:() => true });
    await t.jobs.run("detect", { a:1 }, options, never).catch(() => undefined);
    const [key, entry] = [...t.store][0]!;
    const down = createHostJobs({
      call: async () => { throw new Error("host offline"); },
      kv: { get: async <T>() => entry as T, set: async () => undefined, delete: async () => { t.store.delete(key); } },
      disposed: () => false,
    });
    await expect(down.run("detect", { a:1 }, options, never)).rejects.toThrow("host offline");
    expect(t.store.size).toBe(1);
  });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("the host client of the plugin server", () => {
  it("runs the long kinds as jobs and everything else as plain calls", async () => {
    vi.stubEnv("LANE_PILOT_HOST_JOBS", "1");
    const methods:string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      experimental_callHostRpc: async (call) => {
        methods.push(call.method);
        if (call.method === "jobStart") return { hostId:"h", jobId:"job_abcdefghij1" };
        if (call.method === "jobStatus") return { hostId:"h", jobId:"job_abcdefghij1", state:"succeeded", progress:{ startedAt:1, updatedAt:Date.now(), elapsedSec:1, lastLine:"" }, result:{ hostId:"h", linked:[] }, error:null };
        return { hostId:"h", path:"/", freeBytes:1, totalBytes:2 };
      },
    });
    const core = createCore(bb, openDatabase(bb));
    expect(await core.host.call("gitPrepareWorktree" as never, { requestedHostId:"h", basePath:"/b", worktreePath:"/w" } as never, { hostId:"h" } as never)).toEqual({ hostId:"h", linked:[] });
    expect(methods).toEqual(["jobStart", "jobStatus"]);
    methods.length = 0;
    // A short call stays a call; the sandbox check is a job only when the caller asks (the post-merge check).
    await core.host.call("diskFree" as never, { requestedHostId:"h", path:"/" } as never, { hostId:"h" } as never);
    await core.host.call("runSandboxedCommand" as never, { requestedHostId:"h", workspacePath:"/w", cwd:"/w", command:"true" } as never, { hostId:"h", timeoutMs:30_000 } as never).catch(() => undefined);
    expect(methods).toEqual(["diskFree", "runSandboxedCommand"]);
    methods.length = 0;
    await core.host.call("runSandboxedCommand" as never, { requestedHostId:"h", workspacePath:"/w", cwd:"/w", command:"true" } as never, { hostId:"h", timeoutMs:30_000, job:true } as never);
    expect(methods).toEqual(["jobStart", "jobStatus"]);
    await harness.lifecycle.dispose();
  });
});
