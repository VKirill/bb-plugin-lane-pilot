import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyInstalledGuard, isOwnedPmGuardApplied, ownedPmGuardPath } from "../src/rooms/native-install/guard-apply";
import { hookCommandIdentity, hookCommandShape } from "@lane-pilot/kit";
import { materializeNativeHookSession } from "../src/rooms/native-agent/native-session-hooks";

const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const roots: string[] = [];

async function workspace(settings: string | null) {
  const root = await mkdtemp(join(tmpdir(), "lp-hook-shape-"));
  roots.push(root);
  const home = join(root, "home");
  const pm = join(root, "pm");
  await mkdir(join(pm, ".claude"), { recursive: true });
  const settingsPath = join(pm, ".claude/settings.json");
  if (settings !== null) await writeFile(settingsPath, settings);
  return { home, pm, settingsPath, guard: ownedPmGuardPath(home) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function guardCount(text: string, guard: string) {
  return text.split(guard).length - 1;
}

it("gives one shape to every quoting of the same program and script", () => {
  const shape = hookCommandShape("python3 '/a b/guard.py'");
  expect(hookCommandShape("python3 \"/a b/guard.py\"")).toBe(shape);
  expect(hookCommandShape("python3   /a\\ b//guard.py")).toBe(shape);
  expect(hookCommandShape("python3 '/a b/guard.py' --extra")).toBe(shape);
  expect(hookCommandShape("python3 '/a b/other.py'")).not.toBe(shape);
  expect(hookCommandShape("/usr/bin/python3 '/a b/guard.py'")).not.toBe(shape);
  expect(hookCommandShape("python3 '/it'\\''s/guard.py'")).toBe(hookCommandShape("python3 \"/it's/guard.py\""));
  expect(hookCommandShape("AGENT_HOOK_CLIENT=claude /a/guard.py")).toBeNull();
  expect(hookCommandShape("python3 /a/g.py | tee x")).toBeNull();
  expect(hookCommandIdentity("python3 x.py a")).not.toBe(hookCommandIdentity("python3 x.py b"));
  expect(hookCommandIdentity("python3 'x.py' a")).toBe(hookCommandIdentity("python3 x.py  a"));
});

it("installs the guard once even when the existing entry is quoted differently", async () => {
  const w = await workspace(null);
  const apply = () => applyInstalledGuard({ homeDir: w.home, guardSourcePath: GUARD, pmWorkspacePath: w.pm });
  expect((await apply()).filesChanged.some((file) => file.path === w.settingsPath)).toBe(true);
  expect(await isOwnedPmGuardApplied({ homeDir: w.home, guardSourcePath: GUARD, pmWorkspacePath: w.pm })).toBe(true);
  const first = await readFile(w.settingsPath, "utf8");
  expect((await apply()).filesChanged).toEqual([]);

  const requoted = first.replace(`python3 '${w.guard}'`, `python3 \\"${w.guard}\\"  --x`);
  expect(requoted).not.toBe(first);
  await writeFile(w.settingsPath, requoted);
  expect((await apply()).filesChanged).toEqual([]);
  expect(await readFile(w.settingsPath, "utf8")).toBe(requoted);
});

it("repairs a duplicated guard, keeping the first entry verbatim and everything else", async () => {
  const w = await workspace(null);
  await writeFile(w.settingsPath, `{
  // keep this comment
  "env": { "KEEP": "1" },
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "python3   ${w.guard}" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo other" }] },
      { "matcher": "*", "hooks": [{ "type": "command", "command": "echo mixed" }, { "type": "command", "command": "python3 '${w.guard}'" }] },
      { "matcher": "*", "hooks": [{ "type": "command", "command": "python3 \\"${w.guard}\\"" }] }
    ]
  }
}
`);
  expect(await isOwnedPmGuardApplied({ homeDir: w.home, guardSourcePath: GUARD, pmWorkspacePath: w.pm })).toBe(false);

  const result = await applyInstalledGuard({ homeDir: w.home, guardSourcePath: GUARD, pmWorkspacePath: w.pm });
  expect(result.filesChanged.some((file) => file.path === w.settingsPath)).toBe(true);
  const after = await readFile(w.settingsPath, "utf8");
  expect(guardCount(after, w.guard)).toBe(1);
  expect(after).toContain(`"python3   ${w.guard}"`);
  expect(after).toContain("// keep this comment");
  expect(after).toContain("echo other");
  expect(after).toContain("echo mixed");
  const parsed = JSON.parse(after.replace(/\/\/.*$/m, "")) as { hooks: { PreToolUse: Array<{ hooks: unknown[] }> } };
  expect(parsed.hooks.PreToolUse).toHaveLength(3);
  expect(parsed.hooks.PreToolUse[2]!.hooks).toHaveLength(1);
  expect(await isOwnedPmGuardApplied({ homeDir: w.home, guardSourcePath: GUARD, pmWorkspacePath: w.pm })).toBe(true);
});

it("still adds the guard when the same script is only hooked under another matcher", async () => {
  const w = await workspace("{}\n");
  await writeFile(w.settingsPath, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `python3 '${w.guard}'` }] }] },
  }));
  await applyInstalledGuard({ homeDir: w.home, guardSourcePath: GUARD, pmWorkspacePath: w.pm });
  const parsed = JSON.parse(await readFile(w.settingsPath, "utf8")) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
  expect(parsed.hooks.PreToolUse.map((group) => group.matcher)).toEqual(["Bash", "*"]);
});

it("runs a hook listed in both project and local settings once in the native session", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-hook-shape-session-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  const script = join(root, "orig_hook.py");
  await writeFile(script, "print('x')\n");
  const entry = (command: string) => ({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] } });
  await writeFile(join(cwd, ".claude/settings.json"), JSON.stringify(entry(`python3 ${script}`)));
  await writeFile(join(cwd, ".claude/settings.local.json"), JSON.stringify(entry(`python3 '${script}'`)));
  const result = await materializeNativeHookSession({ cwd, destDir: join(root, "session") });
  expect(result.commands.filter((command) => command.includes("orig-"))).toHaveLength(1);
});
