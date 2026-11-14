// Region 19 · Install, update, remove — batch a (n1464 … n1497). Every test runs the real install / remove code against a temp home
// folder or a scratch database and checks the files and rows afterwards, the person's own bytes included. Nothing here touches the
// real home: every path is under a temp directory passed in.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadWorkflowStore, isOffered } from "../../packages/workflow-engine/src";
import type { Workflow } from "../../packages/workflow-engine/src";
import plugin from "../../server";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { createCore } from "../../src/rooms/core/server/core";
import { migrations } from "../../src/rooms/migrations";
import { NATIVE_HOOK_SOURCES } from "../../src/rooms/contracts/server";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { removeClaudeLaneLeftovers, stripClaudeLaneSettings } from "../../src/rooms/native-install/claude-lane-leftovers";
import { applyInstalledGuard, ownedPmGuardPath } from "../../src/rooms/native-install/guard-apply";
import { experimental_vkLifecycle } from "../../src/rooms/native-install/native-install-lifecycle";
import { nativeInstallOperation, removeClaudeLaneLeftoversHost } from "../../src/rooms/native-install/native-install-host";
import { hashBytes, planJson, safeTarget, transitionOwned, type NativeInstallManifest } from "../../src/rooms/native-install/native-install-owned";
import { materializeNativeHookSession } from "../../src/rooms/native-agent/native-session-hooks";
import { sessionOverrideAgentsJson, CLI_AGENT_DEFINITION_FIELDS } from "../../src/rooms/native-agent/native-agent-definition";
import { compileMainAgentProfile } from "../../src/rooms/native-agent/agent-profile";
import { nativeAgentCliId } from "../../src/rooms/contracts/native-agent-id";
import { employeeRoleLines, recordRoleLine, withRoleLines } from "../../src/rooms/native-agent/employee-lessons";
import { excludeBookkeeping } from "../../src/rooms/verification/server/bookkeeping-exclude";
import { pmResumeInstructions } from "../../src/rooms/learning/pm-rules";
import { createRun, loadProjectSettings, openDatabase, savePrototypeConfig, setRunThread } from "../../src/rooms/plugin-db";
import { runWorkflowTool } from "../../src/rooms/workflow/server/workflow-tools";
import type { WorkflowToolDeps } from "../../src/rooms/workflow/server/workflow-tools";
import type { Services } from "../../server";

const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function temp(prefix: string): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home };
}
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Every file under `dir` (relative path -> bytes hash); symlinks are listed by their target. */
function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) Object.assign(out, tree(path, base));
    else out[relative(base, path)] = sha(path);
  }
  return out;
}
const without = (all: Record<string, string>, prefix: string) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith(prefix)));
type Settings = { theme?: string; hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>; statusLine?: unknown };

/** A home the old Claude Lane installer left behind next to the person's own files. */
function laneHome(home: string) {
  const person = {
    settings: `{\n  // the person's own note\n  "theme": "owner",\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/guardian-code.sh" }, { "type": "command", "command": "python3 ${home}/.agents/hooks/guard_shell.py" }] }\n    ],\n    "Stop": [\n      { "hooks": [{ "type": "command", "command": "python3 ${home}/.agents/hooks/sma_hooks.py" }] },\n      { "hooks": [{ "type": "command", "command": "node /opt/gitnexus/hook.js" }] }\n    ]\n  }\n}\n`,
    codex: `# person's codex note\nmodel = "gpt"\n\n[plugins."codex-lane@claude-lane-stack"]\nenabled = true\n\n[skills]\n# person skills note\npath = "/home/p/skills"\n`,
    memory: "person notes\n", skill: "canon\n", state: "state\n", ownBin: "#!/bin/sh\necho mine\n", ownAgent: "my own agent\n",
  };
  put(join(home, ".claude/settings.json"), person.settings);
  put(join(home, ".codex/config.toml"), person.codex);
  put(join(home, ".agents/hooks/guard_shell.py"), "# lane guard\n");
  put(join(home, ".agents/hooks/sma_hooks.py"), "# lane hooks\n");
  put(join(home, ".agents/bin/lane-ctl"), "#!/bin/sh\n");
  put(join(home, ".agents/bin/lane-foo"), "#!/bin/sh\n");
  put(join(home, ".agents/bin/lane-memory"), "#!/bin/sh\n");
  put(join(home, ".agents/bin/mytool"), person.ownBin);
  put(join(home, ".local/share/claude-lane-stack-installed/install.sh"), "# old installer\n");
  for (const name of ["lane-writer.md", "lane-critic.md", "lane-reviewer.md"]) put(join(home, ".config/opencode/agents", name), `# ${name}\n`);
  put(join(home, ".config/opencode/agents/custom.md"), person.ownAgent);
  put(join(home, ".agents/memory/MEMORY.md"), person.memory);
  put(join(home, ".agents/skills/shared/SKILL.md"), person.skill);
  put(join(home, ".agents/state/keep"), person.state);
  return person;
}

describe("removal of the old Claude Lane leftovers", () => {
  it("[sma:k_rm_cmd] one apply cuts the lane hooks out of settings and codex config, moves the lane files aside and leaves every line of the person's own", async () => {
    const { home } = temp("lp-r19-cmd-");
    const person = laneHome(home);
    const report = await removeClaudeLaneLeftovers({ home, apply: true });
    expect(report.apply).toBe(true);
    expect(report.changed).toBe(true);
    const settings = readFileSync(join(home, ".claude/settings.json"), "utf8");
    expect(settings).toContain("// the person's own note");
    const parsed = JSON.parse(settings.replace(/\/\/.*\n/, "")) as Settings;
    expect(parsed.theme).toBe("owner");
    expect(parsed.hooks!.PreToolUse![0]!.hooks.map((hook) => hook.command)).toEqual(["bash /usr/local/bin/guardian-code.sh"]);
    expect(parsed.hooks!.Stop!.map((group) => group.hooks.map((hook) => hook.command))).toEqual([["node /opt/gitnexus/hook.js"]]);
    const codex = readFileSync(join(home, ".codex/config.toml"), "utf8");
    expect(codex).not.toContain("codex-lane");
    // The blank line that followed the removed table belongs to the next one and stays with it.
    expect(codex).toBe(`# person's codex note\nmodel = "gpt"\n\n\n[skills]\n# person skills note\npath = "/home/p/skills"\n`);
    // The lane files are moved aside, never deleted: the originals are in the dated backup.
    expect(existsSync(join(home, ".agents/bin/lane-ctl"))).toBe(false);
    expect(readFileSync(join(report.backupDir!, ".agents__bin__lane-ctl"), "utf8")).toBe("#!/bin/sh\n");
    expect(readFileSync(join(home, ".agents/bin/mytool"), "utf8")).toBe(person.ownBin);
    expect(readFileSync(join(home, ".config/opencode/agents/custom.md"), "utf8")).toBe(person.ownAgent);
    const again = await removeClaudeLaneLeftovers({ home, apply: true });
    expect(again.changed).toBe(false);
    expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe(settings);
  });

  it("[sma:k_rm_plan] a dry run lists the settings entries, codex lines and the moves and changes no byte in the home", async () => {
    const { home } = temp("lp-r19-plan-");
    laneHome(home);
    const before = tree(home);
    const plan = await removeClaudeLaneLeftovers({ home });
    expect(plan.apply).toBe(false);
    expect(plan.backupDir).toBeNull();
    expect(plan.settings).toEqual([`python3 ${home}/.agents/hooks/guard_shell.py`, `python3 ${home}/.agents/hooks/sma_hooks.py`]);
    expect(plan.codex.length).toBeGreaterThan(0);
    expect(plan.moved).toContain(join(home, ".agents/hooks"));
    expect(plan.moved).toContain(join(home, ".agents/bin/lane-ctl"));
    expect(tree(home)).toEqual(before);
  });

  it("[sma:k_rm_confirm] only an explicit apply true removes anything: no flag, false, a truthy string and an apply of undefined all leave the home as it was", async () => {
    const { home } = temp("lp-r19-confirm-");
    laneHome(home);
    const before = tree(home);
    for (const apply of [undefined, false, "yes" as unknown as boolean, 1 as unknown as boolean]) {
      const report = await removeClaudeLaneLeftovers({ home, apply });
      expect(report.apply, String(apply)).toBe(false);
      expect(report.moved.length, String(apply)).toBeGreaterThan(0);
      expect(tree(home), String(apply)).toEqual(before);
    }
    const applied = await removeClaudeLaneLeftovers({ home, apply: true });
    expect(applied.apply).toBe(true);
    expect(existsSync(join(home, ".agents/bin/lane-ctl"))).toBe(false);
  });

  it("[sma:k_v_deleteme] the host verb prints a dry-run plan, and --apply (and only it) makes the machine apply", async () => {
    const { home } = temp("lp-r19-verb-");
    laneHome(home);
    const asked: Array<{ method: string; apply: unknown; host: unknown }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: (async (call: { method: string; input: { apply?: boolean; requestedHostId?: string } }) => {
        asked.push({ method: call.method, apply: call.input.apply, host: call.input.requestedHostId });
        // The machine side is the real code of the host handler, pointed at the temp home.
        return await (await import("../../src/rooms/native-install/claude-lane-leftovers")).removeClaudeLaneLeftovers({ home, apply: call.input.apply === true });
      }) as never,
    });
    registerCli(createCore(bb, openDatabase(bb)), {} as Services, migrations);
    const before = tree(home);
    const dry = await harness.behavior.runCli(["remove-claude-lane-leftovers", "host-a"]);
    expect(dry.exitCode).toBe(0);
    const plan = JSON.parse(dry.stdout) as { apply: boolean; changed: boolean; moved: string[] };
    expect(plan.apply).toBe(false);
    expect(plan.moved.length).toBeGreaterThan(0);
    expect(tree(home)).toEqual(before);
    const done = JSON.parse((await harness.behavior.runCli(["remove-claude-lane-leftovers", "host-a", "--apply"])).stdout) as { apply: boolean };
    expect(done.apply).toBe(true);
    expect(existsSync(join(home, ".agents/bin/lane-ctl"))).toBe(false);
    expect(asked).toEqual([
      { method: "removeClaudeLaneLeftovers", apply: false, host: "host-a" },
      { method: "removeClaudeLaneLeftovers", apply: true, host: "host-a" },
    ]);
    expect((await harness.behavior.runCli(["remove-claude-lane-leftovers", "--apply"])).exitCode).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("[sma:k_lib_deleteme] the targets are the hooks folder, every lane-* and named bin, the old checkout and the three conveyor agents; a bin and an agent of the person stay", async () => {
    const { home } = temp("lp-r19-targets-");
    laneHome(home);
    const report = await removeClaudeLaneLeftovers({ home, apply: true });
    expect([...report.moved].sort()).toEqual([
      join(home, ".agents/bin/lane-ctl"), join(home, ".agents/bin/lane-foo"), join(home, ".agents/bin/lane-memory"),
      join(home, ".agents/hooks"),
      join(home, ".config/opencode/agents/lane-critic.md"), join(home, ".config/opencode/agents/lane-reviewer.md"), join(home, ".config/opencode/agents/lane-writer.md"),
      join(home, ".local/share/claude-lane-stack-installed"),
    ].sort());
    expect(readdirSync(join(home, ".agents/bin"))).toEqual(["mytool"]);
    expect(readdirSync(join(home, ".config/opencode/agents"))).toEqual(["custom.md"]);
    // The old paths a session started before the cleanup still calls hold a shim (guard forwards, the rest exit 0).
    expect(readFileSync(join(home, ".agents/hooks/sma_hooks.py"), "utf8")).toContain("sys.exit(0)");
  });

  it("[sma:k_rm_keep] the memory corpus, the shared skills and the state folder are byte for byte what they were", async () => {
    const { home } = temp("lp-r19-keep-");
    laneHome(home);
    const kept = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => /^\.agents\/(memory|skills|state)\//.test(name)));
    const before = kept(tree(home));
    expect(Object.keys(before)).toHaveLength(3);
    await removeClaudeLaneLeftovers({ home, apply: true });
    expect(kept(tree(home))).toEqual(before);
    expect(readFileSync(join(home, ".agents/memory/MEMORY.md"), "utf8")).toBe("person notes\n");
  });

  it("[sma:k_st_engine] the old installer's checkout is moved into the dated backup, whole, and the path is free for the managed install", async () => {
    const { home } = temp("lp-r19-engine-");
    laneHome(home);
    const report = await removeClaudeLaneLeftovers({ home, apply: true });
    const checkout = join(home, ".local/share/claude-lane-stack-installed");
    expect(report.moved).toContain(checkout);
    expect(existsSync(checkout)).toBe(false);
    expect(readFileSync(join(report.backupDir!, ".local__share__claude-lane-stack-installed/install.sh"), "utf8")).toBe("# old installer\n");
  });

  it("[sma:k_rm_hooks] only the entries that run a file of ~/.agents/hooks go, in every spelling of the home; foreign hooks, an emptied group and an emptied event are handled", () => {
    const home = "/home/p";
    const text = JSON.stringify({
      theme: "owner",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [
          { type: "command", command: `python3 ${home}/.agents/hooks/guard_shell.py` },
          { type: "command", command: "python3 ~/.agents/hooks/a.py" },
          { type: "command", command: "python3 $HOME/.agents/hooks/b.py" },
          { type: "command", command: "python3 ${HOME}/.agents/hooks/c.py" },
          { type: "command", command: "bash /usr/local/bin/guardian-code.sh" },
          { type: "command", command: `python3 ${home}/.agents/hooks-other/d.py` },
        ] }],
        SessionStart: [{ hooks: [{ type: "command", command: `python3 ${home}/.agents/hooks/sma_hooks.py` }] }],
        Stop: [{ hooks: [{ type: "command", command: "node /opt/gitnexus/hook.js" }] }],
      },
    });
    const out = stripClaudeLaneSettings(text, home);
    expect(out.removed).toHaveLength(5);
    const parsed = JSON.parse(out.text) as Settings;
    expect(parsed.theme).toBe("owner");
    expect(parsed.hooks!.PreToolUse![0]!.hooks.map((hook) => hook.command)).toEqual(["bash /usr/local/bin/guardian-code.sh", `python3 ${home}/.agents/hooks-other/d.py`]);
    expect(parsed.hooks!.SessionStart).toBeUndefined();
    expect(parsed.hooks!.Stop![0]!.hooks[0]!.command).toBe("node /opt/gitnexus/hook.js");
    // Nothing of ours in the text: it comes back byte for byte.
    const clean = JSON.stringify({ theme: "owner", hooks: { Stop: [{ hooks: [{ type: "command", command: "node /opt/x.js" }] }] } }, null, 2);
    expect(stripClaudeLaneSettings(clean, home)).toEqual({ text: clean, removed: [], written: [], suggested: [] });
  });

  it("[sma:k_rm_blocks] the managed block is cut out and the person's lines come back byte for byte; a torn marker, a lone start or a lone end, refuses and writes nothing", async () => {
    const { root, home } = temp("lp-r19-blocks-");
    const managed = join(root, "managed");
    mkdirSync(managed, { recursive: true });
    const manifest = (): NativeInstallManifest => ({
      schemaVersion: 1, home, sourceSha: "a".repeat(40), state: "prepared",
      files: [], json: [], blocks: [{ path: "CLAUDE.md", text: "where memory is" }], preserved: [], createdConfigs: [], createdDirs: [],
    });
    const mine = "# my project\n\nline one\nline two without newline";
    put(join(home, "CLAUDE.md"), mine);
    await transitionOwned(managed, manifest(), "enable");
    const withBlock = readFileSync(join(home, "CLAUDE.md"), "utf8");
    expect(withBlock).toBe(`${mine}\n# lane-pilot:managed:start\nwhere memory is\n# lane-pilot:managed:end\n`);
    await transitionOwned(managed, manifest(), "remove");
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe(`${mine}\n`);
    for (const torn of [
      "person line\n# lane-pilot:managed:start\norphaned without an end\n",
      "person line\norphaned without a start\n# lane-pilot:managed:end\n",
    ]) {
      put(join(home, "CLAUDE.md"), torn);
      await expect(transitionOwned(managed, manifest(), "enable")).rejects.toThrow("preserved: CLAUDE.md");
      expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe(torn);
      await expect(transitionOwned(managed, manifest(), "remove")).rejects.toThrow("preserved: CLAUDE.md");
      expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe(torn);
    }
  });

  it("[sma:k_rm_self] removing the plugin runs a remove on every registered machine: the owned files and keys go, the person's file and key stay, the registry row is dropped", async () => {
    const { root, home } = temp("lp-r19-self-");
    const managed = join(root, "managed");
    put(join(managed, "payload/tool"), "owned");
    put(join(home, "settings.jsonc"), '// keep comment\n{"foreign": true}\n');
    put(join(home, ".agents/bin/personal"), "mine");
    const manifest: NativeInstallManifest = {
      schemaVersion: 1, home, sourceSha: "c".repeat(40), state: "prepared",
      files: [{ path: ".agents/lane-pilot/bin/tool", payload: "payload/tool", mode: 0o755, hash: hashBytes("owned") }],
      json: await planJson(home, "settings.jsonc", { hooks: { Start: ["lane"] } }),
      blocks: [], preserved: [], createdConfigs: [], createdDirs: [],
    };
    await transitionOwned(managed, manifest, "enable");
    expect(readFileSync(join(home, ".agents/lane-pilot/bin/tool"), "utf8")).toBe("owned");
    const store = new Map<string, unknown>([["native-install:host:h1", { hostId: "h1" }]]);
    const kv = {
      list: async (prefix: string) => [...store.keys()].filter((key) => key.startsWith(prefix)),
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: unknown) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
    };
    const calls: Array<{ method: string; action: unknown; hostId: string }> = [];
    await experimental_vkLifecycle({
      action: "remove", kv: kv as never, signal: new AbortController().signal,
      callHost: async (args) => {
        calls.push({ method: args.method, action: (args.input as { action: string }).action, hostId: args.hostId });
        return nativeInstallOperation({ root: managed, home, action: (args.input as { action: "remove" }).action });
      },
    });
    expect(calls).toEqual([{ method: "nativeInstall", action: "remove", hostId: "h1" }]);
    expect(existsSync(join(home, ".agents/lane-pilot/bin/tool"))).toBe(false);
    expect(existsSync(managed)).toBe(false);
    expect(readFileSync(join(home, "settings.jsonc"), "utf8")).toContain("// keep comment");
    expect(readFileSync(join(home, "settings.jsonc"), "utf8")).toContain('"foreign": true');
    expect(readFileSync(join(home, "settings.jsonc"), "utf8")).not.toContain('"Start"');
    expect(readFileSync(join(home, ".agents/bin/personal"), "utf8")).toBe("mine");
    expect([...store.keys()]).toEqual([]);
    // A machine that cannot remove stops the removal and keeps its row: files are never left orphaned.
    store.set("native-install:host:h2", { hostId: "h2" });
    await expect(experimental_vkLifecycle({
      action: "remove", kv: kv as never, signal: new AbortController().signal,
      callHost: async () => { throw new Error("machine offline"); },
    })).rejects.toThrow("machine offline");
    expect([...store.keys()]).toEqual(["native-install:host:h2"]);
  });
});

describe("the per-machine install", () => {
  it("[sma:k_in_npx] an install into an empty home writes the guard from the bundle, repeats to the same bytes and leaves the person's files byte for byte", async () => {
    const { root, home } = temp("lp-r19-npx-");
    put(join(home, ".claude/settings.json"), '{ "theme": "owner" }\n');
    put(join(home, "CLAUDE.md"), "my notes\n");
    const before = tree(home);
    const result = await nativeInstallOperation({ root: join(root, "managed"), home, action: "install" });
    expect(result.status).toBe("enabled");
    expect(sha(ownedPmGuardPath(home))).toBe(sha(GUARD));
    const after = tree(home);
    expect(without(after, ".agents/")).toEqual(before);
    const again = await nativeInstallOperation({ root: join(root, "managed"), home, action: "install" });
    expect(again.status).toBe("enabled");
    expect(tree(home)).toEqual(after);
  });

  it("[sma:k_in_engine] the status reads what is on disk: absent before the install, enabled after it, absent again when the guard is gone", async () => {
    const { root, home } = temp("lp-r19-status-");
    const managed = join(root, "managed");
    expect((await nativeInstallOperation({ root: managed, home, action: "status" })).status).toBe("absent");
    await nativeInstallOperation({ root: managed, home, action: "install" });
    expect((await nativeInstallOperation({ root: managed, home, action: "status" })).status).toBe("enabled");
    rmSync(ownedPmGuardPath(home));
    expect((await nativeInstallOperation({ root: managed, home, action: "status" })).status).toBe("absent");
  });

  it("[sma:k_in_done] a confirmed install returns and stores the receipt of what the machine did; without the yes nothing is stored; a failing machine is reported and nothing is stored", async () => {
    const calls: Array<{ method: string; action?: unknown }> = [];
    let fail = false;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: ((call: { method: string; input: { action?: string } }) => {
        calls.push({ method: call.method, action: call.input.action });
        if (fail) throw new Error("machine refused the install");
        return { status: "enabled", sourceSha: null, ownedFiles: 0, preservedFiles: 0 };
      }) as never,
    });
    (bb.server as unknown as { experimental_vkPluginLifecycle?: boolean }).experimental_vkPluginLifecycle = true;
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId: "p-done", hostId: "host-done", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer",
      pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test",
    });
    await plugin(bb);
    const blocked = await harness.behavior.callRpc("stack_install", { projectId: "p-done", confirmExternalOps: false }) as { status: string };
    expect(blocked.status).toBe("blocked");
    expect(loadProjectSettings(db, "p-done")["install.lastReceipt"]).toBeUndefined();
    const ok = await harness.behavior.callRpc("stack_install", { projectId: "p-done", confirmExternalOps: true }) as { status: string; native: { status: string } };
    expect(ok).toMatchObject({ action: "install", status: "ok", native: { status: "enabled" } });
    const saved = JSON.parse(String(loadProjectSettings(db, "p-done")["install.lastReceipt"])) as { action: string; status: string; native: { status: string } };
    expect(saved).toMatchObject({ action: "install", status: "ok", native: { status: "enabled" } });
    expect(calls.filter((call) => call.method === "nativeInstall").map((call) => call.action)).toContain("install");
    // The next attempt on a machine that fails: the caller sees the error and the last good receipt is not overwritten.
    fail = true;
    await expect(harness.behavior.callRpc("stack_install", { projectId: "p-done", confirmExternalOps: true })).rejects.toThrow("machine refused the install");
    expect(JSON.parse(String(loadProjectSettings(db, "p-done")["install.lastReceipt"]))).toEqual(saved);
    await harness.lifecycle.dispose();
  });

  it("[sma:k_in_refuse] an owned path must stay inside the home: outside, absolute, the home itself and a symlinked parent are refused; a real folder is accepted", async () => {
    const { home } = temp("lp-r19-safe-");
    await expect(safeTarget(home, "../outside/tool")).rejects.toThrow("Invalid managed install path");
    await expect(safeTarget(home, "/etc/passwd")).rejects.toThrow("Invalid managed install path");
    mkdirSync(join(home, "real-agents"));
    symlinkSync(join(home, "real-agents"), join(home, "linked-agents"));
    await expect(safeTarget(home, "linked-agents/bin/tool")).rejects.toThrow("symlink");
    expect(await safeTarget(home, "real-agents/bin/tool")).toBe(join(home, "real-agents/bin/tool"));
    expect(await safeTarget(home, "fresh/dir/tool")).toBe(join(home, "fresh/dir/tool"));
  });

  it("[sma:k_in_stale] two or three copies of our guard hook, in any quoting, are cut down to the first one, verbatim; the person's lines and comments stay", async () => {
    const { home } = temp("lp-r19-stale-");
    const workspace = join(home, "pm");
    const guard = ownedPmGuardPath(home);
    const settingsPath = join(workspace, ".claude/settings.json");
    const settings = `{
  // owner note
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "python3 '${guard}'", "timeout": 5 }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/guardian-code.sh" }] },
      { "matcher": "*", "hooks": [{ "type": "command", "command": "python3 \\"${guard}\\"", "timeout": 9 }, { "type": "command", "command": "echo person" }] },
      { "matcher": "*", "hooks": [{ "type": "command", "command": "python3 ${guard}", "timeout": 11 }] }
    ]
  }
}
`;
    put(settingsPath, settings);
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    const next = readFileSync(settingsPath, "utf8");
    expect(next).toContain("// owner note");
    expect(next).toContain('"timeout": 5');
    expect(next).not.toContain('"timeout": 9');
    expect(next).not.toContain('"timeout": 11');
    expect(next).toContain("guardian-code.sh");
    expect(next).toContain("echo person");
    expect(next.split(guard).length - 1).toBe(1);
    const parsed = JSON.parse(next.replace(/\/\/.*\n/, "")) as Settings;
    expect(parsed.hooks!.PreToolUse!.map((group) => group.hooks.map((hook) => hook.command))).toEqual([[`python3 '${guard}'`], ["bash /usr/local/bin/guardian-code.sh"], ["echo person"]]);
  });

  it("[sma:k_in_merge] our guard is appended after the person's entries, with their comments and order intact, and a second run changes nothing", async () => {
    const { home } = temp("lp-r19-merge-");
    const workspace = join(home, "pm");
    const settingsPath = join(workspace, ".claude/settings.json");
    const original = `{
  // owner note
  "theme": "mine",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/first.sh" }] },
      { "matcher": "Edit", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/second.sh" }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /opt/stop.js" }] }]
  }
}
`;
    put(settingsPath, original);
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    const once = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(once.replace(/\/\/.*\n/, "")) as Settings;
    expect(parsed.hooks!.PreToolUse!.map((group) => group.matcher)).toEqual(["Bash", "Edit", "*"]);
    expect(parsed.hooks!.Stop![0]!.hooks[0]!.command).toBe("node /opt/stop.js");
    expect(once).toContain('{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/first.sh" }] },');
    // The person's entries are the same values in the same order (the jsonc edit may re-indent the one before the new entry).
    expect(parsed.hooks!.PreToolUse!.slice(0, 2)).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "bash /usr/local/bin/first.sh" }] },
      { matcher: "Edit", hooks: [{ type: "command", command: "bash /usr/local/bin/second.sh" }] },
    ]);
    expect(once.indexOf("first.sh")).toBeLessThan(once.indexOf("second.sh"));
    expect(once).toContain("// owner note");
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    expect(readFileSync(settingsPath, "utf8")).toBe(once);
  });

  it("[sma:k_in_anchor] the written command is an absolute path in the home, quoted so a quote in the path survives", async () => {
    const root = mkdtempSync(join(tmpdir(), "lp-r19-anchor-"));
    roots.push(root);
    const home = join(root, "it's a home");
    const workspace = join(root, "pm");
    mkdirSync(home, { recursive: true });
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    const parsed = JSON.parse(readFileSync(join(workspace, ".claude/settings.json"), "utf8")) as Settings;
    const command = parsed.hooks!.PreToolUse![0]!.hooks[0]!.command;
    expect(command).toBe(`python3 '${join(home, ".agents/lane-pilot/pm/guard_shell.py").replaceAll("'", "'\\''")}'`);
    expect(command.startsWith("python3 '/")).toBe(true);
    // The shell reads it back as the one real file, from any working folder.
    const echoed = spawnSync("sh", ["-c", `set -- ${command.replace(/^python3 /, "")}; printf '%s' "$1"`], { cwd: "/", encoding: "utf8" });
    expect(echoed.stdout).toBe(join(home, ".agents/lane-pilot/pm/guard_shell.py"));
    expect(existsSync(echoed.stdout)).toBe(true);
  });

  it("[sma:k_in_badjson] a settings file that is not a JSON object is left byte for byte and the guard install stops, whatever way it is broken", async () => {
    const { home } = temp("lp-r19-bad-");
    const workspace = join(home, "pm");
    const settingsPath = join(workspace, ".claude/settings.json");
    for (const broken of ["{ not json\n", "[]\n", '"text"\n', '{ "hooks": "nope" }\n', '{ "hooks": { "PreToolUse": {} } }\n', '{ "a": 1, }}\n']) {
      put(settingsPath, broken);
      await expect(applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace }), broken).rejects.toThrow(/preserving/);
      expect(readFileSync(settingsPath, "utf8"), broken).toBe(broken);
    }
  });
});

describe("what a session gets written", () => {
  const events = (settings: { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }) => settings.hooks;

  it("[sma:k_in_hooktable] the session settings carry the pre-tool guard and all six session events, each running the session hook once", async () => {
    const dest = mkdtempSync(join(tmpdir(), "lp-r19-table-"));
    roots.push(dest);
    const { settingsPath } = await materializeNativeHookSession({ destDir: dest });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(events(settings)).sort()).toEqual(["PostToolUse", "PreCompact", "PreToolUse", "SessionEnd", "SessionStart", "SubagentStop", "UserPromptSubmit"]);
    for (const event of ["SessionStart", "UserPromptSubmit", "PreCompact", "SubagentStop", "PostToolUse", "SessionEnd"]) {
      const commands = settings.hooks[event]!.flatMap((group) => group.hooks.map((hook) => hook.command));
      expect(commands, event).toEqual([`node '${join(dest, "hooks/session-hook.mjs")}'`]);
    }
    expect(settings.hooks.PreToolUse!.flatMap((group) => group.hooks.map((hook) => hook.command)).some((command) => command.includes("guard_shell.py"))).toBe(true);
  });

  it("[sma:k_in_localpaths] a project hook that names a script by a ./ path is copied beside the session and called by its absolute path; a path that leaves the project is left as written; the project is untouched", async () => {
    const project = mkdtempSync(join(tmpdir(), "lp-r19-local-"));
    roots.push(project);
    const dest = mkdtempSync(join(tmpdir(), "lp-r19-local-dest-"));
    roots.push(dest);
    put(join(project, "tools/check.py"), "print('project check')\n");
    put(join(project, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "python3 ./tools/check.py --strict" }, { type: "command", command: "python3 ./../outside.py" }] },
    ] } }));
    const before = tree(project);
    const { settingsPath } = await materializeNativeHookSession({ cwd: project, destDir: dest });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>> };
    const bash = settings.hooks.PreToolUse!.find((group) => group.matcher === "Bash")!.hooks.map((hook) => hook.command);
    const copied = join(dest, "hooks/orig-0-check.py");
    expect(bash[0]).toContain(`'${join(dest, "hooks/inject_agent_type.py")}' -- python3 ${copied} --strict`);
    expect(readFileSync(copied, "utf8")).toBe("print('project check')\n");
    expect(bash[1]).toContain("python3 ./../outside.py");
    expect(readdirSync(join(dest, "hooks")).filter((name) => name.startsWith("orig-"))).toEqual(["orig-0-check.py"]);
    expect(tree(project)).toEqual(before);
  });

  it("[sma:k_in_runtime] every program a session hook command runs is a file that exists under the session folder, with its bundle bytes", async () => {
    const dest = mkdtempSync(join(tmpdir(), "lp-r19-runtime-"));
    roots.push(dest);
    const { settingsPath, commands } = await materializeNativeHookSession({ destDir: dest });
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const all = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
    expect(all.length).toBeGreaterThan(5);
    expect(commands.length).toBeGreaterThan(1);
    const guardLine = all.find((command) => command.includes("guard_shell.py"))!;
    expect(guardLine).toBe(`python3 '${join(dest, "hooks/inject_agent_type.py")}' -- python3 '${join(dest, "hooks/guard_shell.py")}'`);
    for (const command of all) {
      const files = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
      expect(files.length, command).toBeGreaterThan(0);
      for (const file of files) expect(existsSync(file), file).toBe(true);
    }
  });

  it("[sma:k_st_runtime] the hook programs are written from the bundle: each file holds exactly its bundled text, and a refresh overwrites a stale one", async () => {
    const dest = mkdtempSync(join(tmpdir(), "lp-r19-bundle-"));
    roots.push(dest);
    await materializeNativeHookSession({ destDir: dest });
    for (const name of ["guard_shell.py", "inject_agent_type.py", "lib_payload.py"]) {
      expect(readFileSync(join(dest, "hooks", name), "utf8"), name).toBe(NATIVE_HOOK_SOURCES[name]);
    }
    expect(readFileSync(join(dest, "hooks/session-hook.mjs"), "utf8").length).toBeGreaterThan(100);
    writeFileSync(join(dest, "hooks/guard_shell.py"), "# stale\n");
    await materializeNativeHookSession({ destDir: dest });
    expect(readFileSync(join(dest, "hooks/guard_shell.py"), "utf8")).toBe(NATIVE_HOOK_SOURCES["guard_shell.py"]);
  });

  it("[sma:k_in_agents] every bundled role becomes a definition whose description and prompt are the compiled ones, with nothing the CLI does not know", () => {
    const dev = compileMainAgentProfile("dev-orchestrator");
    const lead = compileMainAgentProfile("copy-lead");
    expect(dev.prompt).not.toBe(lead.prompt);
    for (const [id, compiled] of [["dev-orchestrator", dev], ["copy-lead", lead]] as const) {
      const json = JSON.parse(sessionOverrideAgentsJson({ agentId: id, edited: false, compiled })!) as Record<string, Record<string, unknown>>;
      expect(Object.keys(json)).toEqual([nativeAgentCliId(id)]);
      const definition = json[nativeAgentCliId(id)]!;
      expect(definition.description).toBe(compiled.description);
      expect(definition.prompt).toBe(compiled.prompt);
      for (const key of Object.keys(definition)) expect(CLI_AGENT_DEFINITION_FIELDS).toContain(key);
    }
    expect(sessionOverrideAgentsJson({ agentId: "dev-orchestrator", edited: false, compiled: null })).toBeNull();
    expect(() => sessionOverrideAgentsJson({ agentId: "dev-orchestrator", edited: true, compiled: null })).toThrow("edited_profile_missing_compiled");
  });

  it("[sma:k_in_carry] the owner's role lines are kept apart, survive a new role text and are appended to it; with none the text is unchanged", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const kv = bb.storage.kv;
    const first = await recordRoleLine(kv, "proj", "dev-orchestrator", "2026-11-01: never touch the lock file");
    await recordRoleLine(kv, "proj", "dev-orchestrator", "2026-11-01: never touch the lock file");
    await recordRoleLine(kv, "proj", "dev-orchestrator", "keep the diff small");
    expect(first).toBe("2026-11-01: never touch the lock file");
    const lines = await employeeRoleLines(bb, "proj", "dev-orchestrator");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("2026-11-01: never touch the lock file");
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}: keep the diff small$/);
    expect(await employeeRoleLines(bb, "proj", "copy-lead")).toEqual([]);
    // A new role text (another role, an edited one) gets the same lines appended after it.
    for (const compiled of [compileMainAgentProfile("dev-orchestrator"), compileMainAgentProfile("copy-lead", { prompt: "an edited role text" })]) {
      const next = withRoleLines(compiled, lines);
      expect(next.prompt.startsWith(compiled.prompt)).toBe(true);
      expect(next.prompt.slice(compiled.prompt.length)).toBe(`\n\nLines added to your role in this project (one dated line per review lesson):\n- ${lines[0]}\n- ${lines[1]}`);
      expect(next.description).toBe(compiled.description);
    }
    const bare = compileMainAgentProfile("dev-orchestrator");
    expect(withRoleLines(bare, [])).toBe(bare);
  });
});

describe("the entries the plugin offers", () => {
  it("[sma:k_in_commands] the router offers only published and tested graphs that are not fragments and not Lane Pilot's own pipelines", async () => {
    const stub = (extra: Record<string, unknown>) => extra as unknown as Workflow;
    expect(isOffered(stub({ status: "published" }))).toBe(true);
    expect(isOffered(stub({ status: "tested" }))).toBe(true);
    expect(isOffered(stub({ status: "draft" }))).toBe(false);
    expect(isOffered(stub({ status: "published", internal: true }))).toBe(false);
    expect(isOffered(stub({ status: "tested", startedBy: "lane_pilot_errand" }))).toBe(false);
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES.map((source) => ({ name: source.name, value: { ...(source.value as object), status: "published" } })) });
    const all = store.list().map((item) => item.workflow);
    const offered = all.filter(isOffered).map((workflow) => workflow.id);
    expect(offered.length).toBeGreaterThan(5);
    expect(offered.length).toBeLessThan(all.length);
    expect(offered).toContain("code-review");
    expect(offered).not.toContain("lp.build");
    expect(offered).not.toContain("lp-task-pipeline");
    for (const workflow of all) expect(isOffered(workflow), workflow.id).toBe(!workflow.internal && !workflow.startedBy);
  });

  it("[sma:k_in_skills] a published graph is started by id through lane_pilot_run_workflow with no SKILL.md written anywhere; an id that is not offered is refused", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "lprun-r19", "proj-r19", "cli");
    setRunThread(db, "lprun-r19", "pm-r19");
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES.map((source) => ({ name: source.name, value: { ...(source.value as object), status: "published" } })) });
    const started: Array<{ workflow: string; inputs: Record<string, unknown> }> = [];
    const engine = { start: (input: { workflow: { id: string }; inputs: Record<string, unknown> }) => { started.push({ workflow: input.workflow.id, inputs: input.inputs }); return { runId: "wfrun_1", created: true, done: new Promise(() => undefined) }; }, get: () => null, snapshot: () => null };
    const deps = { db, store: async () => store, engine: () => engine as never, runtime: (input: object) => ({ ctx: {} as never, services: {} as never, ...input }), warn: () => undefined } as unknown as WorkflowToolDeps;
    const project = mkdtempSync(join(tmpdir(), "lp-r19-skills-"));
    roots.push(project);
    const answer = JSON.parse(await runWorkflowTool(deps, { workflowId: "companion", inputs: { goal: "x" } }, { threadId: "pm-r19", projectId: "proj-r19" })) as { status: string; workflow: string };
    expect(answer).toMatchObject({ status: "running", workflow: "companion" });
    expect(started).toEqual([{ workflow: "companion", inputs: { goal: "x" } }]);
    const refused = JSON.parse(await runWorkflowTool(deps, { workflowId: "lp.build", inputs: {} }, { threadId: "pm-r19", projectId: "proj-r19" })) as { status: string; reason: string };
    expect(refused.status).toBe("refused");
    expect(started).toHaveLength(1);
    expect(readdirSync(project)).toEqual([]);
  });
});

describe("what a project gets", () => {
  it("[sma:k_in_dirs] the bookkeeping lines go into .git/info/exclude once, after the person's own last line even without a newline; .gitignore is not created", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lp-r19-dirs-"));
    roots.push(repo);
    spawnSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".git/info/exclude"), "# my own\nbuild/");
    const run = async (input: { command: string; cwd: string }) => {
      const ran = spawnSync("sh", ["-c", input.command], { cwd: input.cwd, encoding: "utf8" });
      return { exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
    };
    const added = await excludeBookkeeping(run, "h1", repo, () => undefined);
    expect(added).toEqual(["**/.agents/runs/", "**/.agents/reports/", "**/.bb/chats/", "**/notes/lock/", "**/.zcode/"]);
    const text = readFileSync(join(repo, ".git/info/exclude"), "utf8");
    expect(text).toBe("# my own\nbuild/\n**/.agents/runs/\n**/.agents/reports/\n**/.bb/chats/\n**/notes/lock/\n**/.zcode/\n");
    expect(await excludeBookkeeping(run, "h1", repo, () => undefined)).toEqual([]);
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).toBe(text);
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  it("[sma:k_in_memory] a database from before the memory table gets the table, its full-text index and its newer columns on the next start, and the notes in it are kept", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    const created = migrations.findIndex((statement) => statement.includes("CREATE TABLE lane_pilot_memory ("));
    expect(created).toBeGreaterThan(0);
    const fts = migrations.findIndex((statement) => statement.includes("lane_pilot_memory_fts USING fts5"));
    bb.storage.migrate(db, [...migrations.slice(0, fts + 1)]);
    db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at) VALUES('old','p','note','owner','the old note','[\"zorblax\"]','s',1)").run();
    db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES('old','p','the old note','zorblax')").run();
    const oldColumns = (db.prepare("PRAGMA table_info(lane_pilot_memory)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(oldColumns).not.toContain("status");
    bb.storage.migrate(db, [...migrations]);
    const columns = (db.prepare("PRAGMA table_info(lane_pilot_memory)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(["status", "use_count", "trust", "scope_json"]));
    expect(db.prepare("SELECT content, status, trust FROM lane_pilot_memory WHERE id='old'").get()).toEqual({ content: "the old note", status: "active", trust: "confirmed" });
    expect((db.prepare("PRAGMA table_info(lane_pilot_memory_fts)").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(["id", "project_id", "content", "concepts"]);
    expect(db.prepare("SELECT id FROM lane_pilot_memory_fts WHERE lane_pilot_memory_fts MATCH 'concepts:zorblax'").all()).toEqual([{ id: "old" }]);
    // A fresh database has the same shape and no notes.
    const other = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
    const fresh = other.storage.database();
    other.storage.migrate(fresh, [...migrations]);
    expect((fresh.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory").get() as { n: number }).n).toBe(0);
  });

  it("[sma:k_in_rules] the PM rules reach the prompt block, a writer-only rule does not, no rules gives nothing, and no CLAUDE.md or AGENTS.md is written", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const cwd = mkdtempSync(join(tmpdir(), "lp-r19-rules-"));
    roots.push(cwd);
    put(join(cwd, "CLAUDE.md"), "person bytes\n");
    const before = tree(cwd);
    expect(pmResumeInstructions(db, "proj-r19", [])).toBeNull();
    const rule = (id: string, text: string, audience: string) => {
      db.prepare("INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`mem-${id}`, "proj-r19", "", "core", "subagent", text, "[\"rule\"]", "s", 1);
      db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,audience)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`r-${id}`, "proj-r19", `s-${id}`, text, "owner", "accepted", 1, 1, "[]", `mem-${id}`, 1, 1, 1, 1, audience);
    };
    rule("pm", "Never plan past the signed context", "pm");
    rule("both", "Quote the contract wording", "both");
    rule("writer", "Writers keep tests next to code", "writer");
    const text = pmResumeInstructions(db, "proj-r19", [])!;
    expect(text).toContain("Never plan past the signed context");
    expect(text).toContain("Quote the contract wording");
    expect(text).not.toContain("Writers keep tests next to code");
    expect(tree(cwd)).toEqual(before);
  });
});
