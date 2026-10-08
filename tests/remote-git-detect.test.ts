import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";
import { createRun, openDatabase, saveProjectSetting, setRunThread } from "../src/database";
import { IntegrationGateRunner } from "../src/server/integration-gate";
import type { ServerCore } from "../src/server/core";
import type { Services } from "../src/server/services";

// B2 / bug 2 (review 2026-10-07): the integration gate ran its command, `git bisect` and file reads on the HUB at the
// project's path, and errands/specialists ran `git status` there. A project on another host has no such path on the hub.
// Everything below uses a project path that exists nowhere on this machine and a host that records what it is asked.

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ file: unknown; args: unknown; cwd: unknown }> }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const track = <T extends (...args: never[]) => unknown>(fn: T) => ((...args: unknown[]) => {
    const options = args.find((arg) => typeof arg === "object" && arg !== null && !Array.isArray(arg)) as { cwd?: unknown } | undefined;
    spawned.calls.push({ file: args[0], args: args[1], cwd: options?.cwd });
    return (fn as unknown as (...rest: unknown[]) => unknown)(...args);
  }) as unknown as T;
  return { ...real, spawn: track(real.spawn), spawnSync: track(real.spawnSync), execFile: track(real.execFile), execFileSync: track(real.execFileSync), execSync: track(real.execSync), exec: track(real.exec) };
});

const REMOTE = "/remote-host-only/projects/shop";
const touchedRemotePath = () => spawned.calls.filter((call) => String(call.cwd ?? "").startsWith(REMOTE) || JSON.stringify(call.args ?? []).includes(REMOTE));

type HostCall = { method: string; input: Record<string, unknown>; options: { hostId: string } };

describe("the integration gate runs on the project's host", () => {
  let db: ReturnType<typeof openDatabase>;
  let sent: Array<{ threadId: string; text: string }>;
  let hostCalls: HostCall[];
  let answers: Record<string, (input: Record<string, unknown>) => unknown>;
  let core: ServerCore;

  beforeEach(() => {
    spawned.calls.length = 0;
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    db = openDatabase(bb);
    db.prepare(`INSERT INTO lane_pilot_run (id, project_id, pm_thread_id, state, created_at, updated_at) VALUES ('run-1', 'proj-1', 'pm-1', 'running', 0, 0)`).run();
    saveProjectSetting(db, "proj-1", "integration.gate_command", "npm run gate");
    sent = [];
    hostCalls = [];
    answers = {};
    core = {
      db,
      bb: {
        sdk: {
          threads: { send: async (input: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: input.threadId, text: input.input[0]?.text ?? "" }); return { id: "m" }; } },
          files: { write: async () => ({ ok: true }) },
        },
        storage: { kv: { get: async () => null, set: async () => null } },
      },
      log: () => {},
      host: { call: async (method: string, input: Record<string, unknown>, options: { hostId: string }) => {
        hostCalls.push({ method, input, options });
        const answer = answers[method];
        if (!answer) throw new Error(`unexpected host call ${method}`);
        return answer(input);
      } },
    } as unknown as ServerCore;
  });

  const run = (runner: IntegrationGateRunner) => runner.maybeRunGate({ runId: "run-1", projectId: "proj-1", pmThreadId: "pm-1", basePath: REMOTE, configHostId: "ovh", trigger: "drain" });
  const merged = (taskId: string, sha: string, produced: string[]) => ({ taskId, commitSha: sha, threadId: `thr-${taskId}`, attemptId: `att-${taskId}`, produced });
  const gate = (exitCode: number, head: string | null, stderr = "", stdout = "") => ({ hostId: "ovh", exitCode, stdout, stderr, head });

  it("runs the gate command on the host named by the config, with the project path, and spawns nothing here", async () => {
    answers.gateRun = () => gate(0, "a".repeat(40));
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask(merged("t1", "b".repeat(40), ["src/a.ts"]));

    const res = await run(runner);

    expect(res).toMatchObject({ ran: true, passed: true });
    expect(hostCalls).toHaveLength(1);
    expect(hostCalls[0]).toMatchObject({ method: "gateRun", options: { hostId: "ovh" }, input: { requestedHostId: "ovh", basePath: REMOTE, command: "npm run gate" } });
    expect(touchedRemotePath()).toEqual([]);
  });

  it("reads a failing file's imports through the host, and names the culprit without touching the local disk", async () => {
    answers.gateRun = () => gate(1, "c".repeat(40), "", " FAIL tests/shop.test.ts\n");
    answers.readBoundedFile = () => ({ content: "import { price } from '../src/price';\n" });
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask(merged("price", "d".repeat(40), ["src/price.ts"]));
    runner.noteMergedTask(merged("cart", "e".repeat(40), ["src/cart.ts"]));

    const res = await run(runner);

    expect(res).toMatchObject({ ran: true, passed: false, culpritTaskId: "price" });
    expect(hostCalls.find((call) => call.method === "readBoundedFile")).toMatchObject({ input: { projectCwd: REMOTE, relativePath: "tests/shop.test.ts" }, options: { hostId: "ovh" } });
    expect(sent.some((message) => message.threadId === "thr-price" && message.text.includes("integration gate failed after merging your task price"))).toBe(true);
    expect(touchedRemotePath()).toEqual([]);
  });

  it("bisects as one host job when the files do not name one task, and spawns no git here", async () => {
    answers.gateRun = (input) => gate(input.command === "npm run gate" ? 0 : 1, "1".repeat(40));
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask(merged("t0", "0".repeat(40), ["src/old.ts"]));
    expect((await run(runner)).passed).toBe(true);

    answers.gateRun = () => gate(1, "3".repeat(40), "Error: gate is red", "");
    answers.gateBisect = () => ({ hostId: "ovh", status: "found", commit: "2".repeat(40), reason: null });
    runner.noteMergedTask(merged("t1", "1".repeat(40), ["src/one.ts"]));
    runner.noteMergedTask(merged("t2", "2".repeat(40), ["src/two.ts"]));
    runner.noteMergedTask(merged("t3", "3".repeat(40), ["src/three.ts"]));

    const res = await run(runner);

    expect(res).toMatchObject({ ran: true, passed: false, culpritTaskId: "t2" });
    const bisect = hostCalls.filter((call) => call.method === "gateBisect");
    expect(bisect).toHaveLength(1);
    expect(bisect[0]).toMatchObject({ options: { hostId: "ovh" }, input: { basePath: REMOTE, command: "npm run gate", goodSha: "1".repeat(40), badSha: "3".repeat(40) } });
    expect(hostCalls.map((call) => call.method)).not.toContain("runCommand");
    expect(touchedRemotePath()).toEqual([]);
  });

  it("a gate red from the environment names no culprit, searches none and sends no fix turn", async () => {
    answers.gateRun = () => gate(1, "5".repeat(40), `Error: EACCES: permission denied, rmSync '${REMOTE}/apps/web/.output/public'`);
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask(merged("only", "6".repeat(40), ["src/a.ts"]));
    runner.noteMergedTask(merged("other", "7".repeat(40), ["src/b.ts"]));

    const res = await run(runner);

    expect(res).toMatchObject({ ran: true, passed: false, culpritTaskId: null });
    expect(hostCalls.map((call) => call.method)).toEqual(["gateRun"]);
    expect(sent.map((message) => message.threadId)).toEqual(["pm-1"]);
    expect(sent[0]!.text).toContain("because of the machine");
    expect(sent[0]!.text).toContain("EACCES");
    expect(sent[0]!.text).not.toContain("Traced to");
    // The merges are still counted: the gate has judged no code yet.
    expect(runner.getPendingMergeCount()).toBe(2);
  });

  it("a red test that merely logs EACCES still finds its culprit", async () => {
    answers.gateRun = () => gate(1, "8".repeat(40), "Error: EACCES: permission denied, open '/root/x'", " FAIL tests/a.test.ts\n Tests  1 failed | 2 passed (3)");
    answers.readBoundedFile = () => ({ content: "" });
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask(merged("a", "9".repeat(40), ["tests/a.test.ts"]));

    expect(await run(runner)).toMatchObject({ passed: false, culpritTaskId: "a" });
  });

  it("a gate the host could not run says nothing about main: no receipt, no message, merges stay counted", async () => {
    answers.gateRun = () => { throw new Error("host is not connected"); };
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask(merged("t1", "b".repeat(40), ["src/a.ts"]));

    expect(await run(runner)).toEqual({ ran: false });
    expect(sent).toEqual([]);
    expect(runner.getPendingMergeCount()).toBe(1);
  });
});

describe("errands and specialists read the checkout's status on its host", () => {
  let dispose: (() => Promise<void> | void) | null = null;
  afterEach(async () => { await dispose?.(); dispose = null; });

  it("an errand helper's stray file in a checkout that exists only on the host is found through the host", async () => {
    spawned.calls.length = 0;
    const projectId = "remote-project";
    const pmThreadId = "remote-pm";
    const runId = "remote-run";
    const statusCalls: Array<{ hostId: string; cwd: string; command: string }> = [];
    let status = "";
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: (async (call: { method: string; input: { requestedHostId: string; cwd: string; command: string } }) => {
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        statusCalls.push({ hostId: call.input.requestedHostId, cwd: call.input.cwd, command: call.input.command });
        return { hostId: call.input.requestedHostId, exitCode: 0, stdout: status, stderr: "" };
      }) as never,
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : {},
          spawn: async () => ({ id: "remote-child" }),
          get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, environmentId: "env-remote", sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }),
          events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
          output: async () => ({ output: "done\nERRAND: done" }),
        },
        environments: { get: async () => ({ id: "env-remote", hostId: "ovh", path: REMOTE, status: "ready" }) },
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    createRun(db, runId, projectId, "cli");
    setRunThread(db, runId, pmThreadId);
    const call = async (name: string, params: Record<string, unknown>) =>
      JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>;

    status = " M README.md\n";
    await call("lane_pilot_errand", { task: "Please check the billing console for me" });
    status = " M README.md\n?? stray-from-helper.txt\n";
    const waited = await call("lane_pilot_wait_errand", { threadId: "remote-child", timeoutSec: 5 });

    expect(waited).toMatchObject({ state: "blocked", reason: "repo_edited", files: ["stray-from-helper.txt"] });
    expect(statusCalls).toEqual([
      { hostId: "ovh", cwd: REMOTE, command: "git status --porcelain -uall" },
      { hostId: "ovh", cwd: REMOTE, command: "git status --porcelain -uall" },
    ]);
    expect(touchedRemotePath()).toEqual([]);
  });
});

describe("the spy that proves it", () => {
  it("sees a process started at a project path, so an empty list above means none was started", async () => {
    spawned.calls.length = 0;
    const { spawnAsync } = await import("@lane-pilot/kit");
    await spawnAsync("true", [], { cwd: REMOTE });
    expect(touchedRemotePath()).toHaveLength(1);
  });
});

// Source guard: nothing the hub's server code runs may start a process or open a file at a project's path. self-repair
// reads the hub's own log file; every other module reaches a project only through a host call.
describe("the plugin server never touches a project path itself", () => {
  const ALLOWED_FS = new Set(["self-repair.ts"]);
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("has no child_process, spawn-async or node:fs import under src/server", () => {
    const root = resolve(__dirname, "../src/server");
    const offenders = files(root).flatMap((file) => {
      const source = strip(readFileSync(file, "utf8"));
      const name = file.slice(root.length + 1);
      const bad = [/from\s+["']node:child_process["']/, /from\s+["'](?:\.\.?\/)+spawn-async["']/, ...(ALLOWED_FS.has(name.split("/").pop()!) ? [] : [/from\s+["'](?:node:)?fs(?:\/promises)?["']/])]
        .filter((pattern) => pattern.test(source));
      return bad.length ? [`${name}: ${bad.map(String).join(", ")}`] : [];
    });
    expect(offenders).toEqual([]);
  });
});
