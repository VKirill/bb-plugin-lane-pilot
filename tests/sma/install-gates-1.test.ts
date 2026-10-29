import { createHash } from "node:crypto";
import { symlink } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { applyInstalledGuard } from "../../src/rooms/native-install/guard-apply";
import { removeClaudeLaneLeftovers } from "../../src/rooms/native-install/claude-lane-leftovers";
import { nativeInstallOperation } from "../../src/rooms/native-install/native-install-host";
import { hashBytes, planJson, safeTarget, transitionOwned, type NativeInstallManifest } from "../../src/rooms/native-install/native-install-owned";
import { loadProjectSettings, openDatabase, savePrototypeConfig } from "../../src/rooms/storage/database";

const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function tempHome(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { root, home };
}

describe("install gates", () => {
  it("[sma:k_rm_plan] [sma:k_rm_confirm] [sma:k_v_deleteme] a dry-run lists the removal and one apply is the only yes", async () => {
    const { home } = await tempHome("lp-sma-rm-");
    await mkdir(join(home, ".agents/hooks"), { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".agents/hooks/guard_shell.py"), "# lane\n");
    await writeFile(join(home, ".claude/settings.json"), "{}\n");
    const before = await readFile(join(home, ".agents/hooks/guard_shell.py"), "utf8");
    const plan = await removeClaudeLaneLeftovers({ home });
    expect(plan.apply).toBe(false);
    expect(plan.changed).toBe(true);
    expect(plan.backupDir).toBeNull();
    expect(plan.moved).toContain(join(home, ".agents/hooks"));
    expect(await readFile(join(home, ".agents/hooks/guard_shell.py"), "utf8")).toBe(before);
    const applied = await removeClaudeLaneLeftovers({ home, apply: true });
    expect(applied.apply).toBe(true);
    expect(applied.changed).toBe(true);
    expect(applied.backupDir).toContain(".lane-pilot/claude-lane-leftovers/");
    await expect(readFile(join(home, ".agents/hooks/guard_shell.py"))).rejects.toMatchObject({ code: "ENOENT" });
    const again = await removeClaudeLaneLeftovers({ home, apply: true });
    expect(again.changed).toBe(false);
    expect(again.moved).toEqual([]);
    expect(again.backupDir).toBeNull();
  });

  it("[sma:k_rm_cmd] [sma:k_rm_keep] [sma:k_rm_hooks] [sma:k_st_settings] [sma:k_up_preserved] removal keeps the memory corpus and foreign settings", async () => {
    const { home } = await tempHome("lp-sma-keep-");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".agents/hooks"), { recursive: true });
    await mkdir(join(home, ".agents/memory"), { recursive: true });
    await mkdir(join(home, ".agents/skills/shared"), { recursive: true });
    await mkdir(join(home, ".agents/state"), { recursive: true });
    await writeFile(join(home, ".agents/hooks/guard_shell.py"), "# lane\n");
    await writeFile(join(home, ".agents/memory/MEMORY.md"), "person notes\n");
    await writeFile(join(home, ".agents/skills/shared/SKILL.md"), "canon\n");
    await writeFile(join(home, ".agents/state/keep"), "state\n");
    const settings = {
      theme: "owner",
      hooks: {
        PreToolUse: [{ hooks: [
          { type: "command", command: `python3 ${home}/.agents/hooks/guard_shell.py` },
          { type: "command", command: "bash /usr/local/bin/guardian-code.sh" },
        ] }],
        Stop: [{ hooks: [{ type: "command", command: "node /opt/gitnexus/hook.js" }] }],
      },
    };
    await writeFile(join(home, ".claude/settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    await removeClaudeLaneLeftovers({ home, apply: true });
    const next = JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8")) as {
      theme: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(next.theme).toBe("owner");
    expect(next.hooks.PreToolUse![0]!.hooks.map((hook) => hook.command)).toEqual(["bash /usr/local/bin/guardian-code.sh"]);
    expect(next.hooks.Stop![0]!.hooks.map((hook) => hook.command)).toEqual(["node /opt/gitnexus/hook.js"]);
    expect(await readFile(join(home, ".agents/memory/MEMORY.md"), "utf8")).toBe("person notes\n");
    expect(await readFile(join(home, ".agents/skills/shared/SKILL.md"), "utf8")).toBe("canon\n");
    expect(await readFile(join(home, ".agents/state/keep"), "utf8")).toBe("state\n");
  });

  it("[sma:k_in_badjson] invalid settings.json is left byte for byte and the guard install stops", async () => {
    const { home } = await tempHome("lp-sma-json-");
    const workspace = join(home, "pm");
    const settingsPath = join(workspace, ".claude/settings.json");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    const broken = "{ not json\n";
    await writeFile(settingsPath, broken);
    await expect(applyInstalledGuard({
      homeDir: home,
      guardSourcePath: GUARD,
      pmWorkspacePath: workspace,
    })).rejects.toThrow("not valid JSONC");
    expect(await readFile(settingsPath, "utf8")).toBe(broken);
  });

  it("[sma:k_in_merge] [sma:k_in_stale] [sma:k_in_anchor] [sma:k_up_verify_patches] a guard hook is anchored once and person lines stay", async () => {
    const { home } = await tempHome("lp-sma-merge-");
    const workspace = join(home, "pm");
    const settingsPath = join(workspace, ".claude/settings.json");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    const original = `{
  // owner note
  "theme": "mine",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash /usr/local/bin/guardian-code.sh" }] }
    ]
  }
}
`;
    await writeFile(settingsPath, original);
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    const once = await readFile(settingsPath, "utf8");
    const guardPath = join(home, ".agents/lane-pilot/pm/guard_shell.py");
    expect(once).toContain("// owner note");
    expect(once).toContain('"theme": "mine"');
    expect(once).toContain("bash /usr/local/bin/guardian-code.sh");
    expect(once).toContain(`python3 '${guardPath}'`);
    expect(once.indexOf("guardian-code.sh")).toBeLessThan(once.indexOf(guardPath));
    expect(once.split(guardPath).length - 1).toBe(1);
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    expect(await readFile(settingsPath, "utf8")).toBe(once);
    const doubled = once.replace(
      `python3 '${guardPath}'`,
      `python3 '${guardPath}'" }, { "type": "command", "command": "python3 '${guardPath}'`,
    );
    expect(doubled.split(guardPath).length - 1).toBe(2);
    await writeFile(settingsPath, doubled);
    await applyInstalledGuard({ homeDir: home, guardSourcePath: GUARD, pmWorkspacePath: workspace });
    const repaired = await readFile(settingsPath, "utf8");
    expect(repaired.split(guardPath).length - 1).toBe(1);
    expect(repaired).toContain("bash /usr/local/bin/guardian-code.sh");
    expect(repaired).toContain("// owner note");
  });

  it("[sma:k_rm_blocks] [sma:k_lib_embed] a torn managed block is refused and the file is not written", async () => {
    const { root, home } = await tempHome("lp-sma-block-");
    const managed = join(root, "managed");
    await mkdir(managed, { recursive: true });
    const page = "person line\n# lane-pilot:managed:start\norphaned without an end\n";
    await writeFile(join(home, "CLAUDE.md"), page);
    const manifest: NativeInstallManifest = {
      schemaVersion: 1, home, sourceSha: "a".repeat(40), state: "prepared",
      files: [], json: [], blocks: [{ path: "CLAUDE.md", text: "where memory is" }],
      preserved: [], createdConfigs: [], createdDirs: [],
    };
    await expect(transitionOwned(managed, manifest, "enable")).rejects.toThrow("preserved: CLAUDE.md");
    expect(await readFile(join(home, "CLAUDE.md"), "utf8")).toBe(page);
  });

  it("[sma:k_in_refuse] install writes into the home and refuses a path that leaves it or follows a symlink", async () => {
    const { root, home } = await tempHome("lp-sma-refuse-");
    const sourceBefore = createHash("sha256").update(await readFile(GUARD)).digest("hex");
    await nativeInstallOperation({ root: join(root, "managed"), home, action: "install" });
    expect(createHash("sha256").update(await readFile(GUARD)).digest("hex")).toBe(sourceBefore);
    expect((await readFile(join(home, ".agents/lane-pilot/pm/guard_shell.py"))).length).toBeGreaterThan(20);
    await expect(safeTarget(home, "../outside/tool")).rejects.toThrow("Invalid managed install path");
    await mkdir(join(home, "real-agents"));
    await symlink(join(home, "real-agents"), join(home, "linked-agents"));
    await expect(safeTarget(home, "linked-agents/bin/tool")).rejects.toThrow("symlink");
  });

  it("[sma:k_up_confirm] [sma:k_up_apply] install does not run unless the caller passes one explicit yes", async () => {
    const hostCalls: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: (call) => { hostCalls.push(call.method); throw new Error(`host ${call.method} should not run`); },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId: "project-test", hostId: "host-test",
      pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer",
      pmProviderId: "claude-code", pmModel: "claude-test",
      writerProviderId: "codex", writerModel: "codex-test",
    });
    await plugin(bb);
    const result = await harness.behavior.callRpc("stack_install", { projectId: "project-test", confirmExternalOps: false });
    expect(result).toMatchObject({
      action: "install",
      status: "blocked",
      reason: "Explicit installation confirmation is required; no operation was run.",
    });
    expect(hostCalls).toEqual([]);
    expect(loadProjectSettings(db, "project-test")["install.lastReceipt"]).toBeUndefined();
    await harness.lifecycle.dispose();
  });

  it("[sma:k_up_preserved] a person edit of an owned file blocks removal and the edit stays", async () => {
    const { root, home } = await tempHome("lp-sma-edit-");
    const managed = join(root, "managed");
    await mkdir(join(managed, "payload"), { recursive: true });
    await writeFile(join(managed, "payload/tool"), "owned");
    await writeFile(join(home, "settings.jsonc"), '// keep comment\n{"foreign": true}\n');
    const manifest: NativeInstallManifest = {
      schemaVersion: 1, home, sourceSha: "b".repeat(40), state: "prepared",
      files: [{ path: ".agents/bin/tool", payload: "payload/tool", mode: 0o755, hash: hashBytes("owned") }],
      json: await planJson(home, "settings.jsonc", { hooks: { Start: ["lane"] } }),
      blocks: [], preserved: [], createdConfigs: [], createdDirs: [],
    };
    await transitionOwned(managed, manifest, "enable");
    await writeFile(join(home, ".agents/bin/tool"), "person edit");
    await expect(transitionOwned(managed, manifest, "remove")).rejects.toThrow("changed; preserved");
    expect(await readFile(join(home, ".agents/bin/tool"), "utf8")).toBe("person edit");
    expect(await readFile(join(home, "settings.jsonc"), "utf8")).toContain("// keep comment");
    expect(await readFile(join(home, "settings.jsonc"), "utf8")).toContain('"foreign": true');
  });
});
