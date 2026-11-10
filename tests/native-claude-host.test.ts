import { chmod, mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { nativeLauncherScript } from "../src/rooms/native-agent/native-claude-host";

it("exits 78 when session hooks are missing and does not exec claude", async () => {
  const dest = await mkdtemp(join(tmpdir(), "lp-native-launcher-"));
  const hooks = join(dest, "hooks");
  await mkdir(hooks, { recursive: true });
  const settingsPath = join(dest, "settings.json");
  const inject = join(hooks, "inject_agent_type.py");
  const guard = join(hooks, "guard_shell.py");
  const command = join(dest, "real-claude");
  await writeFile(settingsPath, "{}\n");
  await writeFile(inject, "# inject\n");
  await writeFile(guard, "# guard\n");
  await writeFile(command, "#!/bin/sh\necho launched\n");
  await chmod(command, 0o700);
  const launcher = join(dest, "claude");
  await writeFile(launcher, nativeLauncherScript({
    destDir: dest,
    command,
    settingsPath,
    agentId: "dev-orchestrator",
    settingId: "dev-orchestrator",
    extraArgs: [],
  }));
  await chmod(launcher, 0o700);
  expect(spawnSync(launcher, { encoding: "utf8" })).toMatchObject({ status: 0, stdout: "launched\n" });
  await unlink(inject);
  const missing = spawnSync(launcher, { encoding: "utf8" });
  expect(missing.status).toBe(78);
  expect(missing.stderr).toMatch(/native hooks missing/);
  expect(missing.stdout).toBe("");
});

it("hands claude one --settings: the core flag layer merged with the guard file, guard hooks kept", async () => {
  const dest = await mkdtemp(join(tmpdir(), "lp-native-merge-"));
  const hooks = join(dest, "hooks");
  await mkdir(hooks, { recursive: true });
  const settingsPath = join(dest, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }] } }));
  await writeFile(join(hooks, "inject_agent_type.py"), "# inject\n");
  await writeFile(join(hooks, "guard_shell.py"), "# guard\n");
  const command = join(dest, "real-claude");
  await writeFile(command, "#!/bin/sh\nfor a in \"$@\"; do echo \"$a\"; done\n");
  await chmod(command, 0o700);
  const launcher = join(dest, "claude");
  await writeFile(launcher, nativeLauncherScript({ destDir: dest, command, settingsPath, agentId: "dev-orchestrator", settingId: "dev-orchestrator", extraArgs: [] }));
  await chmod(launcher, 0o700);
  const core = JSON.stringify({ enabledPlugins: { "i-have-adhd@i-have-adhd": false }, hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "core" }] }] } });
  const run = spawnSync(launcher, ["-p", "hi", "--settings", core], { encoding: "utf8" });
  expect(run.status).toBe(0);
  const args = run.stdout.trim().split("\n");
  expect(args.filter((a) => a === "--settings")).toHaveLength(1);
  expect(args.slice(0, 2)).toEqual(["-p", "hi"]);
  expect(args.slice(-2)).toEqual(["--agent", "'dev-orchestrator'".replace(/'/g, "")]);
  const merged = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
  expect(merged.enabledPlugins).toEqual({ "i-have-adhd@i-have-adhd": false });
  expect(merged.hooks.PreToolUse.map((h: { hooks: { command: string }[] }) => h.hooks[0].command)).toEqual(["core", "guard"]);
  const plain = spawnSync(launcher, ["-p", "hi"], { encoding: "utf8" }).stdout.trim().split("\n");
  expect(plain[plain.indexOf("--settings") + 1]).toBe(settingsPath);
});

it("a helper launcher denies the orchestration built-ins, a PM launcher keeps them", async () => {
  const { claudeGuardLauncherScript, HELPER_DISALLOWED_TOOLS } = await import("../src/rooms/native-agent/claude-guard-launch");
  const dest = await mkdtemp(join(tmpdir(), "lp-guard-tools-"));
  await mkdir(join(dest, "hooks"), { recursive: true });
  const settingsPath = join(dest, "settings.json");
  await writeFile(settingsPath, "{}");
  await writeFile(join(dest, "hooks", "inject_agent_type.py"), "");
  await writeFile(join(dest, "hooks", "guard_shell.py"), "");
  const command = join(dest, "real-claude");
  await writeFile(command, "#!/bin/sh\nfor a in \"$@\"; do echo \"$a\"; done\n");
  await chmod(command, 0o700);
  let extra: string[] = [];
  const run = async (role: string) => {
    const launcher = join(dest, `claude-${role}`);
    await writeFile(launcher, claudeGuardLauncherScript({ destDir: dest, command, settingsPath, role, agentType: role }));
    await chmod(launcher, 0o700);
    return spawnSync(launcher, ["-p", "hi", ...extra], { encoding: "utf8" }).stdout.trim().split("\n");
  };
  const writer = await run("writer");
  expect(writer[writer.indexOf("--disallowedTools") + 1]).toBe(HELPER_DISALLOWED_TOOLS);
  expect(await run("pm")).not.toContain("--disallowedTools");
  // The person's settings differ per machine: a helper does not load them, a PM chat does (docs/guide/hooks.md, rule 6).
  extra = ["--setting-sources=user,project,local"];
  expect(await run("writer")).toContain("--setting-sources=project,local");
  expect(await run("pm")).toContain("--setting-sources=user,project,local");
  extra = ["--setting-sources", "user,project"];
  expect((await run("code-critic")).join(" ")).toContain("--setting-sources project");
  extra = [];
  expect(await run("errand")).toContain("--setting-sources=project,local");
  expect((await run("pm")).join(" ")).not.toContain("--setting-sources");
});
