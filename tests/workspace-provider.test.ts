import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/contracts";
import { HARNESS_VERSION, createAttempt, createRun, createTask, getAttempt, openDatabase, setRunThread } from "../src/database";
import { LANE_WORKTREE_PROVIDER_ID, LANE_WORKTREE_RETIRE_GRACE_MS, laneWorktreeInputs, registerLaneWorktreeProvider } from "../src/server/environment-provider";
import { STICKY_WINDOW_MS } from "../src/server/writer/sticky";
import { createWriterSpawn } from "../src/server/writer/spawn";
import { PROVIDER_FAILURES_BEFORE_DISABLE, createProviderGate, providerListed, providerSwitchOn, waitProviderEnvironment } from "../src/workspace/provider-gate";

const config = (folder: string): PrototypeConfig => ({
  projectId: "P", hostId: "h", pmWorkspacePath: folder, writerWorkspacePath: folder,
  pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
});
const task = (folder: string, id = "t1"): TaskV2 => ({
  schema_version: 2, id, title: "Write in the folder", risk: "high", lane: "writer",
  project_cwd: folder, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["index.ts"], owns_paths: ["index.ts"], never_touch: [], depends_on: [],
  objective: "edit", acceptance: ["files exist"], verify: "none", verification: [],
});

// ---------------------------------------------------------------- the provider itself

type HostCall = { method: string; input: Record<string, unknown> };

function providerEnv(answer: (call: HostCall) => unknown) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const calls: HostCall[] = [];
  const host = { call: async (method: string, input: Record<string, unknown>) => { const call = { method, input }; calls.push(call); return answer(call); } };
  const infos: string[] = [];
  const ctx = { bb, db, host };
  const registered = registerLaneWorktreeProvider(ctx as never);
  const provider = harness.registrations.environmentProviders.get(LANE_WORKTREE_PROVIDER_ID);
  return { db, calls, infos, registered, provider: provider!, bb };
}

const base = "/repo";
const worktree = "/home/me/.lane-pilot/worktrees/a1/repo";
const signal = new AbortController().signal;
const report = { step() {}, log() {} };
function createContext(inputs: Record<string, unknown>) {
  return { inputs, host: { id: "h" }, signal, report, attempt: 1, pathKey: "k", rebuild: false, previous: null, suggestedBranchName: "x",
    thread: {}, project: {}, projectCheckout: null, gitRemote: null, experimental_claimPath: async () => true } as never;
}
function removeContext(over: Record<string, unknown>) {
  return { environment: null, hostId: "h", path: worktree, pathKey: "k", resource: null, attempt: 1, report, signal, ...over } as never;
}

describe("the lane-pilot-worktree environment provider", () => {
  it("registers with a path key per attempt, a grace past the sticky window and strict inputs", () => {
    const { registered, provider } = providerEnv(() => ({}));
    expect(registered).toBe(true);
    expect(provider.policy.pathKeys).toBe("per-attempt");
    expect(provider.policy.retireGraceMs).toBe(LANE_WORKTREE_RETIRE_GRACE_MS);
    expect(LANE_WORKTREE_RETIRE_GRACE_MS).toBeGreaterThan(STICKY_WINDOW_MS);
    expect(laneWorktreeInputs.safeParse({ basePath: "repo", name: "a1" }).success).toBe(false);
    expect(laneWorktreeInputs.safeParse({ basePath: base, name: "a/1" }).success).toBe(false);
    expect(laneWorktreeInputs.safeParse({ basePath: base, name: "a1", path: worktree }).success).toBe(true);
  });

  it("registers nothing on a BB without environment providers", () => {
    const infos: string[] = [];
    const registered = registerLaneWorktreeProvider({ bb: { log: { info: (line: string) => infos.push(line), warn() {} } }, db: {}, host: {} } as never);
    expect(registered).toBe(false);
    expect(infos.join("\n")).toContain("no environment providers");
  });

  it("adopts the worktree Lane Pilot made before the thread started, without making another", async () => {
    const { calls, provider } = providerEnv((call) => call.method === "runCommand" ? { exitCode: 0, stdout: "lane/a1\n", stderr: "" } : {});
    const created = await provider.create(createContext({ basePath: base, name: "a1", path: worktree }));
    expect(created).toEqual({ status: "created", path: worktree, ownsPath: true, resource: { basePath: base, name: "a1", path: worktree } });
    expect(calls.map((call) => call.method)).toEqual(["runCommand"]);
  });

  it("makes the worktree again when it is gone, with the host's own layout logic (a subfolder keeps its prefix)", async () => {
    const nested = "/home/ubuntu/.lane-pilot/worktrees/a1/site/apps/web/site";
    const { calls, provider } = providerEnv((call) => call.method === "runCommand" ? { exitCode: 128, stdout: "", stderr: "fatal" }
      : call.method === "gitCreateWorktree" ? { status: "ready", path: nested, branch: "lane/a1", reason: null } : {});
    const created = await provider.create(createContext({ basePath: "/srv/site/apps/web/site", name: "a1", path: nested }));
    expect(created).toMatchObject({ status: "created", path: nested, ownsPath: true });
    expect(calls.find((call) => call.method === "gitCreateWorktree")?.input).toMatchObject({ basePath: "/srv/site/apps/web/site", name: "a1" });
    expect(calls.map((call) => call.method)).toContain("gitPrepareWorktree");
  });

  it("reports a worktree the host could not make as a failed create", async () => {
    const { provider } = providerEnv((call) => call.method === "gitCreateWorktree" ? { status: "failed", path: null, branch: null, reason: "not a git checkout" } : {});
    expect(await provider.create(createContext({ basePath: base, name: "a1" }))).toEqual({ status: "failed", message: "attempt_worktree_failed:not a git checkout" });
  });

  it("saves what the writer left, then removes the worktree", async () => {
    const { calls, provider } = providerEnv((call) => call.method === "gitWorktreeSnapshot" ? { status: "saved" } : call.method === "gitRemoveWorktree" ? { removed: true } : {});
    const removed = await provider.remove(removeContext({ resource: { basePath: base, name: "a1", path: worktree } }));
    expect(removed).toEqual({ status: "removed" });
    expect(calls.map((call) => call.method)).toEqual(["gitWorktreeSnapshot", "gitRemoveWorktree"]);
    expect(calls[1]!.input).toMatchObject({ basePath: base, worktreePath: worktree });
  });

  it("keeps the worktree and says so when its changes cannot be saved, so BB retries instead of losing them", async () => {
    const { calls, provider } = providerEnv((call) => call.method === "gitWorktreeSnapshot" ? { status: "failed", reason: "disk full" } : {});
    const removed = await provider.remove(removeContext({ resource: { basePath: base, name: "a1", path: worktree } }));
    expect(removed).toMatchObject({ status: "failed" });
    expect(calls.map((call) => call.method)).toEqual(["gitWorktreeSnapshot"]);
  });

  it("finds the base folder in what the thread asked for when the create never answered", async () => {
    const { calls, provider } = providerEnv((call) => call.method === "gitWorktreeSnapshot" ? { status: "clean" } : { removed: true });
    const environment = { environmentProviderSelection: { inputs: { basePath: base, name: "a1", path: worktree }, machine: { type: "existing", hostId: "h" } } };
    expect(await provider.remove(removeContext({ path: null, environment }))).toEqual({ status: "removed" });
    expect(calls.map((call) => call.method)).toEqual(["gitWorktreeSnapshot", "gitRemoveWorktree"]);
  });

  it("counts a worktree that is already gone as removed, and an environment that never got one", async () => {
    const gone = providerEnv((call) => call.method === "gitWorktreeSnapshot" ? { status: "missing" } : {});
    expect(await gone.provider.remove(removeContext({ resource: { basePath: base, name: "a1", path: worktree } }))).toEqual({ status: "removed" });
    expect(gone.calls.map((call) => call.method)).toEqual(["gitWorktreeSnapshot"]);
    const never = providerEnv(() => ({}));
    expect(await never.provider.remove(removeContext({ path: null }))).toEqual({ status: "removed" });
    expect(never.calls).toEqual([]);
  });

  it("leaves a worktree an attempt went on with after the provider failed to start its thread (the fallback)", async () => {
    const env = providerEnv(() => ({}));
    createRun(env.db, "run", "P", "cli", base);
    createTask(env.db, { id: "t1", runId: "run", kind: "bb", contract: task(base) });
    createAttempt(env.db, { id: "a1", runId: "run", taskId: "t1" });
    env.db.prepare("UPDATE lane_pilot_attempt SET workspace_path=?, environment_id=NULL WHERE id='a1'").run(worktree);
    expect(await env.provider.remove(removeContext({ resource: { basePath: base, name: "a1", path: worktree } }))).toEqual({ status: "removed" });
    expect(env.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- the per-machine gate

function memoryGate(version = "1.0.0") {
  const store = new Map<string, unknown>();
  const warnings: string[] = [];
  const kv = { get: async (key: string) => store.get(key) as never, set: async (key: string, value: unknown) => { store.set(key, value); } };
  const make = (v: string) => createProviderGate({ kv: kv as never, serialized: (work) => work(), version: v, warn: (line) => warnings.push(line) });
  return { gate: make(version), make, warnings };
}

describe("the provider gate", () => {
  it("is on unless workspace.provider says off", () => {
    for (const on of [undefined, null, "", "auto", true, "true", "yes"]) expect(providerSwitchOn(on), String(on)).toBe(true);
    for (const off of ["off", false, "false", 0, "0"]) expect(providerSwitchOn(off), String(off)).toBe(false);
  });

  it("switches the provider off on a machine after three failures in a row, with one warning that names the machine", async () => {
    const { gate, warnings } = memoryGate();
    for (let n = 1; n < PROVIDER_FAILURES_BEFORE_DISABLE; n += 1) {
      expect(await gate.failed("h", "environment_error:x")).toBe(false);
      expect(await gate.usable("h")).toBe(true);
    }
    expect(await gate.failed("h", "environment_timeout:provisioning")).toBe(true);
    expect(await gate.usable("h")).toBe(false);
    expect(await gate.usable("other")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/failed 3 times in a row on host h/);
    expect(await gate.failed("h", "again")).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it("counts only failures in a row: a success starts again", async () => {
    const { gate } = memoryGate();
    await gate.failed("h", "x"); await gate.failed("h", "x");
    await gate.succeeded("h");
    await gate.failed("h", "x"); await gate.failed("h", "x");
    expect(await gate.usable("h")).toBe(true);
  });

  it("stays off until the plugin version changes", async () => {
    const { gate, make } = memoryGate("1.0.0");
    for (let n = 0; n < PROVIDER_FAILURES_BEFORE_DISABLE; n += 1) await gate.failed("h", "x");
    expect(await gate.usable("h")).toBe(false);
    expect(await make("1.0.0").usable("h")).toBe(false);
    expect(await make("1.0.1").usable("h")).toBe(true);
  });

  it("lists the provider only where this BB offers it", async () => {
    const rows = [{ id: "git-worktree" }, { id: LANE_WORKTREE_PROVIDER_ID, availability: { status: "available" } }];
    expect(await providerListed(async () => rows, LANE_WORKTREE_PROVIDER_ID, "P", "h")).toBe(true);
    expect(await providerListed(async () => [{ id: "git-worktree" }], LANE_WORKTREE_PROVIDER_ID, "P", "h")).toBe(false);
    expect(await providerListed(async () => [{ id: LANE_WORKTREE_PROVIDER_ID, availability: { status: "unavailable" } }], LANE_WORKTREE_PROVIDER_ID, "P", "h")).toBe(false);
    expect(await providerListed(async () => { throw new TypeError("no such API"); }, LANE_WORKTREE_PROVIDER_ID, "P", "h")).toBe(false);
    expect(await providerListed(() => { throw new TypeError("no such API"); }, LANE_WORKTREE_PROVIDER_ID, "P", "h")).toBe(false);
  });
});

describe("waiting for the provider's environment", () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
  const wait = (environment: unknown, thread: unknown = { environmentId: "env-1", status: "idle" }, extra: object = {}) => waitProviderEnvironment({
    threadId: "thr", expectedPath: worktree, getThread: async () => thread, getEnvironment: async () => environment, ...clock(), timeoutMs: 5_000, ...extra,
  });

  it("is ready when the environment is ready on the worktree that was asked for", async () => {
    expect(await wait({ status: "ready", path: worktree })).toEqual({ ok: true, environmentId: "env-1" });
  });
  it("fails on an environment in error or destroyed, naming BB's message", async () => {
    expect(await wait({ status: "error", statusMessage: "provider said no" })).toEqual({ ok: false, reason: "environment_error:provider said no" });
    expect(await wait({ status: "destroyed" })).toMatchObject({ ok: false });
  });
  it("fails on a worktree other than the one asked for", async () => {
    expect(await wait({ status: "ready", path: "/elsewhere" })).toMatchObject({ ok: false, reason: expect.stringContaining("environment_path_mismatch") });
  });
  it("gives up at the deadline, and on a thread that failed before it had an environment", async () => {
    expect(await wait({ status: "provisioning" })).toEqual({ ok: false, reason: "environment_timeout:provisioning" });
    expect(await wait(null, { status: "error" })).toEqual({ ok: false, reason: "thread_error_before_environment" });
  });
  it("keeps asking while the environment is being made", async () => {
    let asks = 0;
    const result = await waitProviderEnvironment({ threadId: "thr", expectedPath: worktree, getThread: async () => ({ environmentId: "env-1" }),
      getEnvironment: async () => (++asks < 3 ? { status: "provisioning" } : { status: "ready", path: worktree }), ...clock() });
    expect(result).toEqual({ ok: true, environmentId: "env-1" });
    expect(asks).toBe(3);
  });
});

// ---------------------------------------------------------------- the writer spawn

type World = {
  folder?: string; prefix?: string; worktreeFolder?: string; kind?: "bb" | "cli"; projectRoot?: boolean; otherRoot?: string; noGit?: boolean;
  providers?: unknown[] | "no-api"; settings?: Record<string, unknown>; createReason?: string;
  environment?: (spawnNo: number) => unknown; spawn?: (args: { environment: { type: string } }, spawnNo: number) => unknown;
};

function world(options: World = {}) {
  const folder = options.folder ?? "/repo/apps/bot";
  const made = options.worktreeFolder ?? "/home/me/.lane-pilot/worktrees/a1/bot/apps/bot";
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", options.kind ?? "cli", folder);
  setRunThread(db, "run", "pm");
  createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task(folder) });
  for (const id of ["a1", "a2", "a3", "a4"]) createAttempt(db, { id, runId: "run", taskId: "t1" });
  const hostCalls: string[] = [];
  const spawned: Array<Record<string, unknown>> = [];
  const stopped: string[] = [];
  const archived: string[] = [];
  const infos: string[] = [];
  const warns: string[] = [];
  let spawnNo = 0;
  const listProviders = async () => options.providers ?? [{ id: LANE_WORKTREE_PROVIDER_ID }];
  const sdk: Record<string, unknown> = {
    projects: { get: async () => ({ sources: options.otherRoot ? [{ hostId: "h", path: options.otherRoot }] : options.projectRoot ? [{ hostId: "h", path: folder }] : [] }) },
    providers: {
      list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }],
      models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }),
    },
    files: { read: async () => ({ content: null }) },
    threads: {
      get: async (args: { threadId: string }) => args.threadId.startsWith("writer") ? { id: args.threadId, status: "idle", environmentId: `env-${args.threadId}` }
        : args.threadId === "holder-1" ? { id: "holder-1", status: "idle", environmentId: "env-holder" } : { id: "pm", projectId: "P", status: "idle" },
      spawn: async (args: Record<string, unknown>) => {
        spawned.push(args); spawnNo += 1;
        const custom = options.spawn?.(args as never, spawnNo);
        if (custom) return custom;
        return { id: (args.pluginMetadata as { role?: string } | undefined)?.role === "workspace-provisioner" ? "holder-1" : `writer-${spawnNo}`, environmentId: `env-writer-${spawnNo}` };
      },
      stop: async (args: { threadId: string }) => { stopped.push(args.threadId); },
      archive: async (args: { threadId: string }) => { archived.push(args.threadId); },
    },
    environments: {
      listProviders,
      get: async (args: { environmentId: string }) => options.environment ? options.environment(Number(args.environmentId.replace(/\D/g, "")))
        : args.environmentId === "env-holder" ? { id: "env-holder", status: "ready", hostId: "h", path: "/bb/managed/repo", managed: true, workspaceProvisionType: "managed-worktree" }
        : { id: args.environmentId, status: "ready", path: made },
    },
  };
  if (options.providers === "no-api") delete sdk.environments;
  const ctx = {
    bb: { storage: bb.storage, log: { info: (line: string) => infos.push(line), warn: (line: string) => warns.push(line) }, sdk },
    db,
    serializedKv: <T>(work: () => Promise<T>) => work(),
    host: {
      call: async (method: string, input: { command?: string }) => {
        hostCalls.push(method);
        if (method === "runCommand") {
          const command = input.command ?? "";
          if (command === "git rev-parse --is-inside-work-tree") return options.noGit ? { hostId: "h", exitCode: 128, stdout: "", stderr: "fatal: not a git repository" } : { hostId: "h", exitCode: 0, stdout: "true\n", stderr: "" };
          return { hostId: "h", exitCode: 0, stdout: command === "git rev-parse --show-prefix" ? (options.prefix ?? "apps/bot/\n") : "[]", stderr: "" };
        }
        if (method === "gitCreateWorktree") {
          return options.createReason ? { status: "failed", path: null, branch: null, reason: options.createReason } : { status: "ready", path: made, branch: "lane/a1", reason: null };
        }
        return {};
      },
    },
    effectiveProjectSettings: async () => ({ values: { "jev.LANE_JEV_EFFORT": false, "memory.enabled": false, "adoc.040": "auto", ...options.settings } }),
  };
  const services = { providerBreaker: { decide: () => ({ allow: true }) }, ruleScan: { chainForRun: async () => [] }, reconcileAttemptThread: async () => "writer-recovered", recoverLostHolderThread: async () => null };
  const writer = createWriterSpawn(ctx as never, services as never);
  const start = (attemptId = "a1") => writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "t1", attemptId, config: config(folder), task: task(folder), plan: "edit", pmThreadId: "pm" });
  return { db, bb, hostCalls, spawned, stopped, archived, infos, warns, start, made, folder };
}

const providerEnvironment = (path: string, basePath: string, name = "a1") => ({
  type: "provider", environmentProviderId: LANE_WORKTREE_PROVIDER_ID, machine: { type: "existing", hostId: "h" }, inputs: { basePath, name, path },
});
const unmanaged = (path: string) => ({ type: "host", hostId: "h", workspace: { type: "unmanaged", path } });
const holders = (spawned: Array<Record<string, unknown>>) => spawned.filter((args) => (args.pluginMetadata as { role?: string } | undefined)?.role === "workspace-provisioner");

describe("a writer attempt on the worktree provider", () => {
  it("starts a subfolder of a larger repo on a provider environment over the worktree Lane Pilot made, with no holder thread", async () => {
    const w = world();
    const result = await w.start();
    expect(result).toMatchObject({ ok: true, workspacePath: w.made, threadId: "writer-1" });
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]!.environment).toEqual(providerEnvironment(w.made, w.folder));
    expect(w.hostCalls.filter((method) => method === "gitCreateWorktree")).toHaveLength(1);
    expect(w.hostCalls).toContain("gitPrepareWorktree");
    expect(holders(w.spawned)).toEqual([]);
    expect(getAttempt(w.db, "a1")).toMatchObject({ workspace_path: w.made, environment_id: "env-writer-1", holder_thread_id: null, state: "running" });
  });

  it("does the same for a section with its own repository inside a project without git", async () => {
    const w = world({ kind: "bb", otherRoot: "/project-root" });
    expect(await w.start()).toMatchObject({ ok: true, workspacePath: w.made });
    expect(w.spawned[0]!.environment).toEqual(providerEnvironment(w.made, w.folder));
    expect(holders(w.spawned)).toEqual([]);
  });

  it("does the same for the project's own repository root, where BB's managed worktree and its holder thread were used", async () => {
    const w = world({ folder: "/repo", kind: "bb", projectRoot: true, prefix: "\n", worktreeFolder: "/home/me/.lane-pilot/worktrees/a1/repo" });
    expect(await w.start()).toMatchObject({ ok: true, workspacePath: "/home/me/.lane-pilot/worktrees/a1/repo" });
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]!.environment).toEqual(providerEnvironment("/home/me/.lane-pilot/worktrees/a1/repo", "/repo"));
    expect(holders(w.spawned)).toEqual([]);
  });

  it("does the same for a nested OVH-like path: the subfolder inside the worktree is where the writer starts", async () => {
    const nested = "/home/ubuntu/.lane-pilot/worktrees/a1/site/apps/web/site";
    const w = world({ folder: "/srv/site/apps/web/site", worktreeFolder: nested, prefix: "apps/web/site/\n" });
    expect(await w.start()).toMatchObject({ ok: true, workspacePath: nested });
    expect(w.spawned[0]!.environment).toEqual(providerEnvironment(nested, "/srv/site/apps/web/site"));
  });

  it("never offers the provider to a folder without git: the writer edits the live files in place", async () => {
    const w = world({ noGit: true });
    const result = await w.start();
    expect(result).toMatchObject({ ok: true, workspacePath: w.folder });
    expect(w.hostCalls).not.toContain("gitCreateWorktree");
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]!.environment).toEqual(unmanaged(w.folder));
    expect(getAttempt(w.db, "a1")?.environment_id).toBeNull();
  });

  it("resumes a bound attempt on the provider over its recorded worktree without making another", async () => {
    const w = world();
    w.db.prepare("UPDATE lane_pilot_attempt SET workspace_path=?, workspace_decision_json=? WHERE id='a1'").run(w.made, JSON.stringify({ strategy: "provision_attempt_worktree" }));
    expect(await w.start()).toMatchObject({ ok: true, workspacePath: w.made });
    expect(w.hostCalls).not.toContain("gitCreateWorktree");
    expect(w.spawned[0]!.environment).toEqual(providerEnvironment(w.made, w.folder));
  });
});

describe("a writer attempt that falls back to the old worktree path", () => {
  it("uses the old path at once when this BB has no environment providers, with one log line and no error counted", async () => {
    const w = world({ providers: "no-api" });
    expect(await w.start()).toMatchObject({ ok: true, workspacePath: w.made });
    expect(w.spawned[0]!.environment).toEqual(unmanaged(w.made));
    expect(w.infos.filter((line) => /worktree provider not used/.test(line))).toHaveLength(1);
    expect(getAttempt(w.db, "a1")?.environment_id).toBeNull();
    expect(w.warns).toEqual([]);
  });

  it("uses the old path when the provider is not among the ones BB lists (registration failed)", async () => {
    const w = world({ providers: [{ id: "git-worktree" }] });
    expect(await w.start()).toMatchObject({ ok: true });
    expect(w.spawned[0]!.environment).toEqual(unmanaged(w.made));
  });

  it("uses the old path, silently, when workspace.provider is off", async () => {
    const w = world({ settings: { "workspace.provider": "off" } });
    expect(await w.start()).toMatchObject({ ok: true });
    expect(w.spawned[0]!.environment).toEqual(unmanaged(w.made));
    expect(w.infos.filter((line) => /worktree provider/.test(line))).toEqual([]);
  });

  it("uses the old path when Lane Pilot's own worktree cannot be made", async () => {
    const w = world({ folder: "/repo", kind: "bb", projectRoot: true, prefix: "\n", createReason: "not a git checkout", providers: [{ id: LANE_WORKTREE_PROVIDER_ID }, { id: "git-worktree" }] });
    expect(await w.start()).toMatchObject({ ok: true, threadId: "writer-2" });
    // the managed path (holder thread) is the old answer for a project root
    expect(holders(w.spawned)).toHaveLength(1);
    expect(w.infos.join("\n")).toContain("no worktree for the provider");
  });

  it("starts again on the old path over the same worktree when the environment goes to error: not failed, not charged", async () => {
    const w = world({ environment: (spawnNo) => spawnNo === 1 ? { status: "error", statusMessage: "provider create said no" } : { status: "ready" } });
    const result = await w.start();
    expect(result).toMatchObject({ ok: true, workspacePath: w.made, threadId: "writer-2" });
    expect(w.spawned.map((args) => (args.environment as { type: string }).type)).toEqual(["provider", "host"]);
    expect(w.spawned[1]!.environment).toEqual(unmanaged(w.made));
    expect(w.stopped).toEqual(["writer-1"]);
    expect(w.archived).toEqual(["writer-1"]);
    expect(w.hostCalls.filter((method) => method === "gitCreateWorktree")).toHaveLength(1);
    expect(getAttempt(w.db, "a1")).toMatchObject({ state: "running", thread_id: "writer-2", environment_id: null, workspace_path: w.made });
    expect(w.infos.filter((line) => /worktree provider error/.test(line))).toHaveLength(1);
    expect(w.infos.join("\n")).not.toMatch(/\bfailed\b/);
  });

  it("starts again on the old path when BB refuses the provider at the spawn", async () => {
    const w = world({ spawn: (args, spawnNo) => { if (spawnNo === 1) throw new Error('The "lane-pilot-worktree" environment provider is not registered'); return null; } });
    expect(await w.start()).toMatchObject({ ok: true, workspacePath: w.made });
    expect(w.spawned.map((args) => (args.environment as { type: string }).type)).toEqual(["provider", "host"]);
  });

  it("does not hide a spawn error that is not the provider's", async () => {
    const w = world({ spawn: () => { throw new Error("socket hang up"); } });
    const result = await w.start();
    expect(w.spawned).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, threadId: "writer-recovered" });
    expect(getAttempt(w.db, "a1")?.state).toBe("spawn_unknown");
  });

  it("switches the provider off on the machine after three provider errors in a row: the fourth attempt does not try it", async () => {
    const w = world({ environment: (spawnNo) => spawnNo % 2 === 1 ? { status: "error", statusMessage: "no" } : { status: "ready" } });
    for (const id of ["a1", "a2", "a3"]) expect(await w.start(id), id).toMatchObject({ ok: true });
    expect(w.warns).toHaveLength(1);
    expect(w.warns[0]).toMatch(new RegExp(`failed 3 times in a row on host h.*until the plugin version changes`));
    const before = w.spawned.length;
    expect(await w.start("a4")).toMatchObject({ ok: true });
    expect(w.spawned).toHaveLength(before + 1);
    expect(w.spawned.at(-1)!.environment).toEqual(unmanaged(w.made));
    expect(await w.bb.storage.kv.get("workspace-provider:host:h")).toEqual({ version: HARNESS_VERSION, failures: 3, disabled: true });
    expect(w.infos.some((line) => /switched off on this machine/.test(line))).toBe(true);
  });

  it("a successful provider attempt clears the count", async () => {
    const w = world({ environment: (spawnNo) => spawnNo === 1 ? { status: "error" } : { status: "ready", path: "/home/me/.lane-pilot/worktrees/a1/bot/apps/bot" } });
    await w.start("a1");
    expect(await w.bb.storage.kv.get("workspace-provider:host:h")).toMatchObject({ failures: 1, disabled: false });
    await w.start("a2");
    expect(await w.bb.storage.kv.get("workspace-provider:host:h")).toMatchObject({ failures: 0, disabled: false });
  });
});
