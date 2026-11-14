// Region 1 · Task graph, batch c (second file): what the worker is launched with (ap_personal, ap_mcp, ap_switched_off, as_build_args).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeExecLine } from "../../src/rooms/native-agent/native-claude-host";
import { MANDATORY_BB_PLUGINS, MANDATORY_MCP_SERVERS, effectiveGroup } from "../../src/rooms/contracts/helper-context";
import { CONVEYOR_KEY, conveyorStartLine, conveyorState, setConveyor } from "../../src/rooms/runs/conveyor";
import { isHeld } from "../../src/rooms/runs/server";
import { claudeGuardLauncherScript, HELPER_DISALLOWED_TOOLS, WRITER_DISALLOWED_TOOLS } from "../../src/rooms/native-agent/claude-guard-launch";

type Settings = { permissions?: { deny?: string[]; allow?: string[] }; hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>; autoMemoryEnabled?: boolean };

/** Runs the launcher's real exec line (python merge, then the "claude" stand-in that prints its arguments and the one settings file it got). */
function launch(role: string, layer: unknown, person: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "sma-ap-personal-"));
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "cfg"), { recursive: true });
  writeFileSync(join(dir, "hooks", "guard_shell.py"), "x");
  writeFileSync(join(dir, "guard.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `python3 ${dir}/hooks/guard_shell.py` }] }] } }));
  writeFileSync(join(dir, "layer.json"), JSON.stringify(layer));
  writeFileSync(join(dir, "cfg", "settings.json"), JSON.stringify(person));
  writeFileSync(join(dir, "show.sh"), `#!/bin/sh\nprintf 'ARGS:%s\\n' "$*"\nwhile [ $# -gt 0 ]; do if [ "$1" = "--settings" ]; then cat "$2"; fi; shift; done\n`);
  chmodSync(join(dir, "show.sh"), 0o755);
  const ran = spawnSync("sh", ["-c", claudeExecLine(join(dir, "show.sh"), join(dir, "guard.json")), "sh", "--settings", join(dir, "layer.json")], {
    encoding: "utf8", env: { ...process.env, LANE_PILOT_ROLE: role, CLAUDE_CONFIG_DIR: join(dir, "cfg") },
  });
  const [first, ...rest] = ran.stdout.split("\n");
  return { dir, status: ran.status, stderr: ran.stderr, args: first!.slice("ARGS:".length), merged: JSON.parse(rest.join("\n") || "{}") as Settings };
}
const commands = (merged: Settings) => (merged.hooks?.PreToolUse ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));

describe("what the worker is launched with", () => {
  it("[sma:ap_personal] a helper's settings carry the person's deny rules next to the core's, never the person's allow list or user-level hooks, and read no user layer; a PM keeps its own layer whole", () => {
    const layer = { permissions: { deny: ["Bash(rm -rf /)"] }, hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "python3 /definitely/missing/person-hook.py" }] }] } };
    const person = { permissions: { deny: ["Bash(rm -rf /)", "Read(~/.ssh/**)"], allow: ["Bash(ls)"] } };
    const helper = launch("writer", layer, person);
    expect(helper.status).toBe(0);
    // The person's protections come along (the layer's own rule is not repeated); what they allowed does not.
    expect(helper.merged.permissions?.deny).toEqual(["Bash(rm -rf /)", "Read(~/.ssh/**)"]);
    expect(helper.merged.permissions?.allow).toBeUndefined();
    expect(helper.merged.autoMemoryEnabled).toBe(false);
    // The user setting source is not loaded for a helper; an unreadable hook is dropped with its name and reason, the guard's stays.
    expect(helper.args).toContain("--setting-sources=project,local");
    expect(commands(helper.merged)).toEqual([`python3 ${helper.dir}/hooks/guard_shell.py`]);
    expect(helper.stderr).toContain("hook 1 of group 1 on event PreToolUse dropped from the settings layer of a helper, /definitely/missing/person-hook.py does not exist: python3 /definitely/missing/person-hook.py");
    // A PM's chat is the owner's own conversation: nothing mirrored, nothing dropped, the user layer stays.
    const pm = launch("pm", layer, person);
    expect(pm.merged.permissions?.deny).toEqual(["Bash(rm -rf /)"]);
    expect(commands(pm.merged)).toEqual(["python3 /definitely/missing/person-hook.py", `python3 ${pm.dir}/hooks/guard_shell.py`]);
    expect(pm.args).not.toContain("--setting-sources");
    expect(pm.stderr).toBe("");
  });

  it("[sma:ap_mcp] a role's connections are its own list plus the mandatory ones; an owner's list replaces the role's but keeps the mandatory; «all» is no list", () => {
    expect(MANDATORY_MCP_SERVERS).toEqual(["bb-bridge"]);
    expect(effectiveGroup("writer", "mcpServers")).toEqual({ names: ["bb-bridge", "gitnexus"], source: "role" });
    expect(effectiveGroup("plan-critic", "mcpServers")).toEqual({ names: ["bb-bridge"], source: "role" });
    expect(effectiveGroup("browser-qa", "bbPlugins")).toEqual({ names: [...MANDATORY_BB_PLUGINS, "browser-automation"], source: "role" });
    expect(effectiveGroup("writer", "mcpServers", { mcpServers: { mode: "allow", names: ["context7"] } })).toEqual({ names: ["bb-bridge", "context7"], source: "owner" });
    expect(effectiveGroup("writer", "mcpServers", { mcpServers: { mode: "all" } })).toEqual({ names: null, source: "owner" });
  });

  it("[sma:ap_switched_off] a switched-off conveyor holds the launch of every run until it is switched on; it keeps the first moment and reason, and the start says how to turn it on", async () => {
    const store = new Map<string, unknown>();
    const kv = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } };
    expect(await conveyorState(kv)).toEqual({ on: true, since: null, reason: null });
    expect(await isHeld(kv as never, "run1")).toBe(false);
    expect(conveyorStartLine(await conveyorState(kv))).toBeNull();
    const off = await setConveyor(kv, false, "  maintenance  ");
    expect(off).toMatchObject({ on: false, reason: "maintenance" });
    expect(off.since).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await isHeld(kv as never, "run1")).toBe(true);
    expect(await isHeld(kv as never, "run2")).toBe(true);
    // A second «off» keeps the first moment and reason.
    expect(await setConveyor(kv, false, "another")).toEqual(off);
    expect(conveyorStartLine(off)).toBe(`Lane Pilot: the conveyor is OFF since ${off.since} (maintenance): no new work is issued. Turn it on with: bb lane-pilot conveyor on`);
    const on = await setConveyor(kv, true);
    expect(on).toEqual({ on: true, since: null, reason: null });
    expect(store.get(CONVEYOR_KEY)).toBeNull();
    expect(await isHeld(kv as never, "run1")).toBe(false);
  });

  it("[sma:as_build_args] a writer's launch line carries the turn ceiling as a whole number and the writer's full deny list; a helper's has the helper list only and a PM's has neither", () => {
    const line = (role: string, extra: Record<string, unknown> = {}) => claudeGuardLauncherScript({ destDir: "/d", command: "/bin/claude", settingsPath: "/s", role, agentType: role, ...extra } as never);
    const writer = line("writer", { maxTurns: 150.7 });
    expect(writer).toContain(`--disallowedTools '${HELPER_DISALLOWED_TOOLS},${WRITER_DISALLOWED_TOOLS}'`);
    expect(writer).toMatch(/--max-turns 150(?!\d)/);
    expect(writer).not.toMatch(/--max-turns 151/);
    expect(line("writer")).not.toContain("--max-turns");
    const critic = line("code-critic");
    expect(critic).toContain(`--disallowedTools '${HELPER_DISALLOWED_TOOLS}'`);
    expect(critic).not.toContain(WRITER_DISALLOWED_TOOLS);
    const pm = line("pm");
    expect(pm).not.toContain("--disallowedTools");
    expect(pm).not.toContain("--max-turns");
  });
});
