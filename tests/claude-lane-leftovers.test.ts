import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeClaudeLaneLeftovers } from "../src/rooms/native-install/claude-lane-leftovers";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function homeWithMixedLeftovers() {
  const root = await mkdtemp(join(tmpdir(), "lp-leftover-")); roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".agents/hooks"), { recursive: true });
  await mkdir(join(home, ".agents/bin"), { recursive: true });
  await mkdir(join(home, ".agents/skills/shared"), { recursive: true });
  await mkdir(join(home, ".agents/state"), { recursive: true });
  await mkdir(join(home, ".agents/memory"), { recursive: true });
  await mkdir(join(home, ".local/share/claude-lane-stack-installed"), { recursive: true });
  const settings = {
    theme: "owner",
    statusLine: { type: "command", command: `${home}/.agents/bin/lane-statusline` },
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [
          { type: "command", command: `python3 ${home}/.agents/hooks/guard_shell.py` },
          { type: "command", command: "bash /usr/local/bin/guardian-code.sh" },
        ] },
        { matcher: "Bash", hooks: [{ type: "command", command: "~/.agents/hooks/sma_hooks.py" }] },
      ],
      Stop: [{ hooks: [
        { type: "command", command: "node /opt/gitnexus/hook.js" },
        { type: "command", command: "claude-tmux" },
      ] }],
      Notification: [{ hooks: [{ type: "command", command: "/usr/local/bin/clipboard-image" }] }],
    },
  };
  await writeFile(join(home, ".claude/settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  await writeFile(join(home, ".codex/config.toml"), [
    "[plugins.other]",
    "enabled = true",
    "",
    "[plugins.\"codex-lane@claude-lane-stack\"]",
    "enabled = true",
    "",
    "[hooks.state.\"codex-lane@claude-lane-stack:pre\"]",
    "trusted_hash = \"abc\"",
    "",
    "[hooks.state.\"gitnexus:pre\"]",
    "trusted_hash = \"def\"",
    "",
  ].join("\n"));
  await writeFile(join(home, ".agents/hooks/guard_shell.py"), "# lane\n");
  await writeFile(join(home, ".agents/bin/lane-memory"), "#!/bin/sh\n");
  await writeFile(join(home, ".agents/bin/lane-statusline"), "#!/bin/sh\n");
  await writeFile(join(home, ".agents/bin/lane-custom"), "#!/bin/sh\n");
  await writeFile(join(home, ".agents/bin/agent-trash"), "#!/bin/sh\n");
  await writeFile(join(home, ".agents/bin/owner-tool"), "#!/bin/sh\n");
  await writeFile(join(home, ".agents/skills/shared/SKILL.md"), "canon\n");
  await writeFile(join(home, ".agents/state/keep"), "state\n");
  await writeFile(join(home, ".agents/memory/keep"), "memory\n");
  await writeFile(join(home, ".local/share/claude-lane-stack-installed/README"), "checkout\n");
  return home;
}

describe("remove Claude Lane leftovers", () => {
  it("drops only Claude Lane hooks and keeps the owner's entries", async () => {
    const home = await homeWithMixedLeftovers();
    const report = await removeClaudeLaneLeftovers({ home, apply: true });
    const settings = JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8")) as {
      theme: string;
      statusLine?: unknown;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.theme).toBe("owner");
    expect(settings.statusLine).toBeUndefined();
    const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
    expect(commands).toEqual([
      "bash /usr/local/bin/guardian-code.sh",
      "node /opt/gitnexus/hook.js",
      "claude-tmux",
      "/usr/local/bin/clipboard-image",
    ]);
    expect(report.settings.some((command) => command.includes(".agents/hooks/"))).toBe(true);
    expect(report.moved).toContain(join(home, ".agents/hooks"));
  });

  it("leaves the home unchanged on a dry-run", async () => {
    const home = await homeWithMixedLeftovers();
    const beforeSettings = await readFile(join(home, ".claude/settings.json"), "utf8");
    const beforeCodex = await readFile(join(home, ".codex/config.toml"), "utf8");
    const report = await removeClaudeLaneLeftovers({ home });
    expect(report.apply).toBe(false);
    expect(report.changed).toBe(true);
    expect(report.backupDir).toBeNull();
    expect(await readFile(join(home, ".claude/settings.json"), "utf8")).toBe(beforeSettings);
    expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toBe(beforeCodex);
    expect(await readFile(join(home, ".agents/hooks/guard_shell.py"), "utf8")).toBe("# lane\n");
    expect(await readFile(join(home, ".agents/bin/lane-memory"), "utf8")).toContain("bin/sh");
  });

  it("is a no-op on a second apply and keeps other Codex plugins", async () => {
    const home = await homeWithMixedLeftovers();
    const first = await removeClaudeLaneLeftovers({ home, apply: true });
    expect(first.changed).toBe(true);
    const settings = await readFile(join(home, ".claude/settings.json"), "utf8");
    const codex = await readFile(join(home, ".codex/config.toml"), "utf8");
    expect(codex).toContain("[plugins.other]");
    expect(codex).toContain("gitnexus:pre");
    expect(codex).not.toContain("codex-lane@claude-lane-stack");
    expect(await readFile(join(home, ".agents/skills/shared/SKILL.md"), "utf8")).toBe("canon\n");
    expect(await readFile(join(home, ".agents/state/keep"), "utf8")).toBe("state\n");
    expect(await readFile(join(home, ".agents/memory/keep"), "utf8")).toBe("memory\n");
    expect(await readFile(join(home, ".agents/bin/agent-trash"), "utf8")).toContain("bin/sh");
    expect(await readFile(join(home, ".agents/bin/owner-tool"), "utf8")).toContain("bin/sh");
    await expect(readFile(join(home, ".agents/bin/lane-memory"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, ".agents/hooks/guard_shell.py"))).rejects.toMatchObject({ code: "ENOENT" });
    const backupRoot = join(home, ".lane-pilot/claude-lane-leftovers");
    const [stamp] = await readdir(backupRoot);
    expect(stamp).toBeTruthy();
    expect(await readFile(join(backupRoot, stamp!, ".local__share__claude-lane-stack-installed", "README"), "utf8")).toBe("checkout\n");
    const second = await removeClaudeLaneLeftovers({ home, apply: true });
    expect(second.changed).toBe(false);
    expect(second.moved).toEqual([]);
    expect(second.backupDir).toBeNull();
    expect(await readdir(backupRoot)).toHaveLength(1);
    expect(await readFile(join(home, ".claude/settings.json"), "utf8")).toBe(settings);
    expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toBe(codex);
  });
});
