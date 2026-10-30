import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mountNativeWiring } from "../src/rooms/core/server/native-wiring";
import { prepareClaudeGuardHost } from "../src/rooms/host-worker/host-handlers";
import { createOwnerPresence } from "../src/rooms/owner-presence/server";
import { sdkDouble } from "./fixtures/sdk-double";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Role = string | null;

function wiring(options: {
  dataDir: string;
  roleOf: (threadId: string) => Role;
  kvGet?: (key: string) => unknown;
}) {
  const calls: string[] = [];
  const resolvers = new Map<string, (thread: { threadId: string | null; hostId: string; projectId: string }) => Promise<Array<{ name: string; value: string; reason: string }>>>();
  const hooks = new Map<string, (ctx: unknown) => unknown>();
  const bb = {
    log: { debug() {}, warn() {}, info() {} },
    ui: { registerMentionProvider() {} },
    experimental_hooks: { on(name: string, fn: (ctx: unknown) => unknown) { hooks.set(name, fn); } },
    providers: { experimental_contributeEnv(id: string, resolve: (thread: { threadId: string | null; hostId: string; projectId: string }) => Promise<Array<{ name: string; value: string; reason: string }>>) { resolvers.set(id, resolve); } },
    storage: { kv: { get: async (key: string) => options.kvGet?.(key) ?? null, set: async () => undefined, delete: async () => undefined } },
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => {
          const role = options.roleOf(threadId);
          return role ? { role } : {};
        },
        get: async () => null,
        retry: async () => undefined,
      },
      environments: { get: async () => null },
    },
    events: { on() {} },
  };
  const host = {
    call: async (method: string, input: { role: string; cwd?: string }) => {
      calls.push(method);
      if (method !== "prepareClaudeGuard") throw new Error(`unexpected host call ${method}`);
      return prepareClaudeGuardHost(input, { experimental_paths: { dataDir: options.dataDir } } as never);
    },
  };
  mountNativeWiring({ bb, db: {}, nativeHost: host, state: { disposed: false } } as never);
  const resolve = resolvers.get("claude-code");
  if (!resolve) throw new Error("claude-code env resolver was not registered");
  return { resolve, calls, hooks, bb };
}

async function claudeOnPath(root: string) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const cli = join(bin, "claude");
  await writeFile(cli, "#!/bin/sh\nexit 0\n");
  await chmod(cli, 0o755);
  return bin;
}

function settingsCommand(script: string, dataDir: string): string {
  const settingsPath = script.match(/--settings '([^']+)'/)?.[1];
  if (!settingsPath?.startsWith(dataDir)) throw new Error(`settings path is not under the host data dir: ${settingsPath}`);
  return settingsPath;
}

async function hookCommand(settingsPath: string, dataDir: string): Promise<string> {
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
  };
  const command = settings.hooks.PreToolUse.flatMap((group) => group.matcher === "*" ? group.hooks : []).map((hook) => hook.command).find((line) => line.includes("guard_shell.py"));
  if (!command) throw new Error("no bundled guard hook");
  if (command.includes(".agents/hooks/guard_shell.py")) throw new Error(command);
  if (!command.includes(dataDir)) throw new Error(command);
  return command;
}

function runHook(command: string, agentType: string, shell: string) {
  return spawnSync("sh", ["-c", command], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: shell }, cwd: "/tmp" }),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_HOOK_CLIENT: "claude", LANE_PILOT_AGENT_TYPE: agentType, LANE_PILOT_ROLE: agentType === "lane-pilot-pm" ? "pm" : agentType },
  });
}

describe("claude threads Lane Pilot starts get the bundled guard", () => {
  it("launches a helper and a PM with the guard hook, and a helper git commit is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-guard-"));
    roots.push(root);
    const bin = await claudeOnPath(root);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
    try {
      const dataDir = join(root, "data");
      const { resolve, calls } = wiring({
        dataDir,
        roleOf: (threadId) => threadId === "thr_pm" ? "pm" : threadId === "thr_helper" ? "errand" : null,
      });
      const helper = await resolve({ threadId: "thr_helper", hostId: "local", projectId: "p" });
      const again = await resolve({ threadId: "thr_helper", hostId: "local", projectId: "p" });
      expect(calls).toEqual(["prepareClaudeGuard"]);
      expect(again.find((entry) => entry.name === "BB_CLAUDE_CODE_EXECUTABLE")?.value).toBe(helper.find((entry) => entry.name === "BB_CLAUDE_CODE_EXECUTABLE")?.value);
      const launcher = helper.find((entry) => entry.name === "BB_CLAUDE_CODE_EXECUTABLE")?.value;
      expect(launcher?.startsWith(dataDir)).toBe(true);
      const script = await readFile(launcher!, "utf8");
      expect(script).toContain("unset BB_CLAUDE_CODE_EXECUTABLE");
      expect(script).toContain("LANE_PILOT_AGENT_TYPE='errand'");
      expect(script).not.toContain("--agent");
      const helperHook = await hookCommand(settingsCommand(script, dataDir), dataDir);
      const denied = runHook(helperHook, "errand", "git commit -m test");
      expect(denied.stdout).toMatch(/\[helper-guard\]/);
      expect(denied.stdout).toMatch(/"permissionDecision": "deny"/);

      const pm = await resolve({ threadId: "thr_pm", hostId: "local", projectId: "p" });
      expect(pm.find((entry) => entry.name === "LANE_PILOT_AGENT_TYPE")?.value).toBe("lane-pilot-pm");
      expect(pm.find((entry) => entry.name === "LANE_PILOT_ROLE")?.value).toBe("pm");
      const pmScript = await readFile(pm.find((entry) => entry.name === "BB_CLAUDE_CODE_EXECUTABLE")!.value, "utf8");
      expect(pmScript).toContain("LANE_PILOT_AGENT_TYPE='lane-pilot-pm'");
      const pmHook = await hookCommand(settingsCommand(pmScript, dataDir), dataDir);
      const pmCommit = runHook(pmHook, "lane-pilot-pm", "git commit -m test");
      expect(pmCommit.stdout).not.toMatch(/\[helper-guard\]/);
    } finally {
      process.env.PATH = previous;
    }
  });

  it("leaves the owner's chat and a native session on their own executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-guard-"));
    roots.push(root);
    const bin = await claudeOnPath(root);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
    try {
      const { resolve, calls } = wiring({
        dataDir: join(root, "data"),
        roleOf: (threadId) => threadId === "thr_native" ? "pm" : null,
        kvGet: (key) => key === "native-thread:thr_native" ? { token: "t" } : key === "native-env:thr_native" ? [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/native/claude", reason: "native" }] : null,
      });
      expect(await resolve({ threadId: "thr_owner", hostId: "local", projectId: "p" })).toEqual([]);
      expect(await resolve({ threadId: null, hostId: "local", projectId: "p" })).toEqual([]);
      const native = await resolve({ threadId: "thr_native", hostId: "local", projectId: "p" });
      expect(native).toEqual([expect.objectContaining({ name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/native/claude" })]);
      expect(calls).toEqual([]);
    } finally {
      process.env.PATH = previous;
    }
  });

  it("refuses to start a lane thread when the host cannot write the guard", async () => {
    const resolvers = new Map<string, (thread: { threadId: string; hostId: string }) => Promise<unknown>>();
    const bb = {
      log: { debug() {}, warn() {}, info() {} },
      ui: { registerMentionProvider() {} },
      experimental_hooks: { on() {} },
      providers: { experimental_contributeEnv(id: string, fn: (thread: { threadId: string; hostId: string }) => Promise<unknown>) { resolvers.set(id, fn); } },
      storage: { kv: { get: async () => null } },
      sdk: { threads: { getPluginMetadata: async () => ({ role: "errand" }), get: async () => null, retry: async () => undefined }, environments: { get: async () => null } },
      events: { on() {} },
    };
    mountNativeWiring({
      bb,
      db: {},
      nativeHost: { call: async () => { throw new Error("disk full"); } },
      state: { disposed: false },
    } as never);
    await expect(resolvers.get("claude-code")!({ threadId: "thr_helper", hostId: "ovh" })).rejects.toThrow(/claude_guard_failed:ovh: disk full/);
  });

  it("records owner presence from the dispatch hook and ignores a lane thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-guard-"));
    roots.push(root);
    const resolvers = new Map<string, unknown>();
    const hooks = new Map<string, (ctx: unknown) => unknown>();
    // The SDK double (tests/fixtures/sdk-double.ts) stands in for threads and storage.kv on this real room path.
    const double = sdkDouble({ threads: [{ id: "thr_owner" }, { id: "thr_pm", pluginMetadata: { role: "pm" } }] });
    const bb = {
      log: { debug() {}, warn() {}, info() {} },
      ui: { registerMentionProvider() {} },
      experimental_hooks: { on(name: string, fn: (ctx: unknown) => unknown) { hooks.set(name, fn); } },
      providers: { experimental_contributeEnv(id: string, fn: unknown) { resolvers.set(id, fn); } },
      storage: double.bb.storage,
      sdk: { ...double.bb.sdk, threads: { ...double.bb.sdk.threads, retry: async () => undefined } },
      events: { on() {} },
    };
    const api = createOwnerPresence({ bb, log: () => undefined } as never).ownerPresence;
    mountNativeWiring({ bb, db: {}, nativeHost: { call: async () => { throw new Error("no"); } }, state: { disposed: false } } as never);
    const hook = hooks.get("message.dispatch");
    if (!hook) throw new Error("message.dispatch was not registered");
    const base = { input: { blocks: [] }, project: { id: "p" }, host: { id: "h1", name: "mini" }, environment: null };
    hook({ ...base, initiator: "user", senderThreadId: null, thread: { id: "thr_owner" }, requestedExecution: { providerId: "codex" } });
    hook({ ...base, initiator: "user", senderThreadId: null, thread: { id: "thr_pm" }, requestedExecution: { providerId: "claude-code" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.holds("codex")).toMatch(/^owner_present:codex/);
    expect(api.holds("claude-code")).toBeNull();
  });
});
