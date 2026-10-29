import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => state.home,
}));

import { prepareNativeClaude } from "../src/rooms/native-agent/native-claude-host";
import { materializeNativeHookSession } from "../src/rooms/native-agent/native-session-hooks";

it("A-027 native launchers keep settings isolated between projects with the same agent", async () => {
  const temp = await mkdtemp(join(tmpdir(), "audit-native-project-"));
  state.home = join(temp, "home");
  const bin = join(temp, "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(state.home);
  await writeFile(join(bin, "claude"), `#!/bin/sh
case "$1" in
--version) echo fixture-1;;
--help) echo "--agent NAME --agents JSON --plugin-dir DIR";;
*) exit 99;;
esac
`, { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(state.home, ".claude"));
  try {
    for (const id of ["one", "two"]) {
      const root = join(temp, id);
      await mkdir(join(root, ".claude/agents"), { recursive: true });
      await writeFile(join(root, ".claude/agents/dev-orchestrator.md"), "fixture profile");
      await writeFile(join(root, ".claude/settings.json"), JSON.stringify({
        env: { AUDIT_PROJECT: id },
        hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `echo ${id}` }] }] },
      }));
    }
    const one = await prepareNativeClaude({ cwd: join(temp, "one"), agentId: "dev-orchestrator", agentsJson: null, dataDir: join(temp, "data") });
    const first = one.env.find((entry) => entry.name === "BB_CLAUDE_CODE_EXECUTABLE")!.value;
    const before = JSON.parse(await readFile(join(dirname(first), "settings.json"), "utf8")) as { env: { AUDIT_PROJECT: string } };
    expect(before.env.AUDIT_PROJECT).toBe("one");
    const two = await prepareNativeClaude({ cwd: join(temp, "two"), agentId: "dev-orchestrator", agentsJson: null, dataDir: join(temp, "data") });
    const second = two.env.find((entry) => entry.name === "BB_CLAUDE_CODE_EXECUTABLE")!.value;
    const after = JSON.parse(await readFile(join(dirname(first), "settings.json"), "utf8")) as {
      env: { AUDIT_PROJECT: string };
      hooks: { PreToolUse: unknown };
    };
    expect(after.env.AUDIT_PROJECT, JSON.stringify({ sameLauncher: first === second, before: before.env, after: after.env, afterHooks: after.hooks.PreToolUse })).toBe("one");
    expect(first).not.toBe(second);
  } finally {
    vi.unstubAllEnvs();
    await rm(temp, { recursive: true, force: true });
  }
});

it("A-028 a project-relative Python hook is resolved from that project", async () => {
  const temp = await mkdtemp(join(tmpdir(), "audit-native-relative-"));
  const project = join(temp, "project");
  await mkdir(join(project, ".claude"), { recursive: true });
  await mkdir(join(project, "hooks"));
  await writeFile(join(project, "hooks/project-policy.py"), "print('fixture hook')\n");
  await writeFile(join(project, ".claude/settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "python3 ./hooks/project-policy.py" }] }] },
  }));
  try {
    const dest = join(temp, "session");
    const result = await materializeNativeHookSession({ cwd: project, destDir: dest });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const group = settings.hooks.PreToolUse.find((row) => row.matcher === "Read");
    expect(group?.hooks[0]?.command).toContain(join(dest, "hooks"));
    expect(group?.hooks[0]?.command).toContain("project-policy.py");
    expect(await readFile(join(dest, "hooks", group!.hooks[0]!.command.match(/orig-\d+-project-policy\.py/)![0]), "utf8")).toBe("print('fixture hook')\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("A-028 a missing project hook does not reject the session", async () => {
  const temp = await mkdtemp(join(tmpdir(), "audit-native-missing-"));
  const project = join(temp, "project");
  await mkdir(join(project, ".claude"), { recursive: true });
  await writeFile(join(project, ".claude/settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "python3 ./hooks/missing-policy.py" }] }] },
  }));
  try {
    const result = await materializeNativeHookSession({ cwd: project, destDir: join(temp, "session") });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.PreToolUse.some((row) => row.matcher === "Read")).toBe(true);
    expect(settings.hooks.PreToolUse.some((row) => row.hooks.some((hook) => hook.command.includes("guard_shell.py")))).toBe(true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
