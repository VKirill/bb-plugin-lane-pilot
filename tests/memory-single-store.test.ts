import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MAIN_AGENT_PROFILE_IDS } from "../src/rooms/contracts/server";
import { compileMainAgentProfile } from "../src/rooms/native-agent/agent-profile";
import { claudeGuardLauncherScript } from "../src/rooms/native-agent/claude-guard-launch";
import { disableCodexMemories } from "../src/rooms/host-worker/handlers/machine";

/**
 * All Lane Pilot memory lives in one place: the hub DB next to the plugin. No text the plugin hands to an agent may send it to
 * another store (agentmemory MCP tools), and every session the plugin launches runs with the built-in memory of its CLI off.
 */
const ROOT = join(__dirname, "..");
const BANNED = /memory_save|memory_smart_search|memory_recall|memory_lesson_save|agentmemory/i;

/** Files that may name agentmemory: the one-time import, the RPC enum of its sources, the origin guard of the write door, the SMA proof map. */
const ALLOWED = new Set([
  "src/rooms/memory/server/import.ts",
  "src/rooms/contracts/rpc-knowledge.ts",
  "src/rooms/sma-map/contracts.ts",
  "packages/memory-core/src/store.ts",
  "packages/memory-core/src/context.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|md|json|ya?ml|py|sh|txt)$/.test(name)) out.push(path);
  }
  return out;
}

describe("one memory store: the hub DB", () => {
  it("skills, workflows, policy, lane-stack and source texts never send an agent to agentmemory", () => {
    const hits: string[] = [];
    for (const top of ["skills", "workflows", "policy", "lane-stack", "src"]) {
      for (const file of walk(join(ROOT, top))) {
        const rel = relative(ROOT, file);
        if (ALLOWED.has(rel) || /\.test\.tsx?$/.test(rel) || /\.sql$/.test(rel) || /migrations?/.test(rel)) continue;
        if (BANNED.test(readFileSync(file, "utf8"))) hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no seeded agent profile names an agentmemory tool or server", () => {
    for (const id of MAIN_AGENT_PROFILE_IDS) expect(JSON.stringify(compileMainAgentProfile(id)), id).not.toMatch(BANNED);
  });

  it("Claude Code: every launched session (PM and helpers alike) runs with auto-memory off, even when core passes true", async () => {
    const home = await mkdtemp(join(tmpdir(), "single-store-home-"));
    for (const role of ["pm", "writer", "code-critic", "errand", "helper"]) {
      const dest = await mkdtemp(join(tmpdir(), `single-store-${role}-`));
      await mkdir(join(dest, "hooks"), { recursive: true });
      const settingsPath = join(dest, "settings.json");
      await writeFile(settingsPath, JSON.stringify({ hooks: {} }));
      await writeFile(join(dest, "hooks", "inject_agent_type.py"), "# inject\n");
      await writeFile(join(dest, "hooks", "guard_shell.py"), "# guard\n");
      const command = join(dest, "real-claude");
      await writeFile(command, "#!/bin/sh\nfor a in \"$@\"; do echo \"$a\"; done\n");
      await chmod(command, 0o700);
      const launcher = join(dest, "claude");
      await writeFile(launcher, claudeGuardLauncherScript({ destDir: dest, command, settingsPath, role, agentType: role }));
      await chmod(launcher, 0o700);
      for (const extra of [[], ["--settings", JSON.stringify({ autoMemoryEnabled: true })]]) {
        const args = spawnSync(launcher, ["-p", "hi", ...extra], { encoding: "utf8", env: { ...process.env, HOME: home } }).stdout.trim().split("\n");
        const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1]!, "utf8"));
        expect(settings.autoMemoryEnabled, `${role} ${extra.length ? "with core layer" : "alone"}`).toBe(false);
      }
    }
  });

  it("Codex: the seeded per-task config.toml turns its memory store off", () => {
    expect(disableCodexMemories("")).toContain("[features]\nmemories = false");
    expect(disableCodexMemories("")).toContain("[memories]\ngenerate_memories = false");
    const owner = disableCodexMemories('model = "x"\n[features]\nhooks = true\nmemories = true\ngoals = true\n\n[memories]\ngenerate_memories = true\nmax_rollouts_per_startup = 3\n');
    expect(owner).not.toMatch(/memories\s*=\s*true/);
    expect(owner).toContain("hooks = true");
    expect(owner).toContain("max_rollouts_per_startup = 3");
    // a [features] table without the key gets it; other tables stay untouched
    expect(disableCodexMemories('[features]\nhooks = true\n[projects.x]\ntrust_level = "trusted"\n')).toMatch(/\[features\]\nmemories = false\nhooks = true/);
    const once = disableCodexMemories("[features]\nmemories = true\n");
    expect(disableCodexMemories(once)).toBe(once);
  });
});
