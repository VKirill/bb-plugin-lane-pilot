import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { fullAccessSpawn } from "../src/rooms/platform/server/pm-spawn";
import { CLAUDE_EDITOR_TOOLS, launchTuningFor, withLaunchTuning } from "../src/rooms/platform/server/launch-tuning";

const KEY = "experimental_vkLaunchTuning";
const READ_ONLY = ["plan-critic", "specialist-reviewer", "pm-reader", "gate-triage"];
const WRITERS = ["writer", "code-repair", "night-fixer", "docs-maintainer", "memory-maintainer", "errand", "browser-qa", "self-repair", "workflow-architect", "pm"];
const NONE = {} as NodeJS.ProcessEnv;

describe("launch tuning: which helper gets what", () => {
  it("puts a read-only role on Cursor and Devin into ask", () => {
    for (const role of READ_ONLY) {
      expect(launchTuningFor("acp-cursor", role, NONE)).toEqual({ version: 1, acp: { mode: "ask" } });
      expect(launchTuningFor("devin", role, NONE)).toEqual({ version: 1, acp: { mode: "ask" } });
    }
  });

  it("never uses the Devin plan mode, which writes, and never the Devin env switch, which does nothing under ACP", () => {
    const text = JSON.stringify(READ_ONLY.map((role) => launchTuningFor("devin", role, NONE)));
    expect(text).not.toContain("plan");
    expect(text).not.toContain("env");
    expect(text).not.toContain("DEVIN_SANDBOX");
  });

  it("puts a read-only role on Antigravity into plan with the sandbox flag", () => {
    expect(launchTuningFor("acp-antigravity", "plan-critic", NONE)).toEqual({ version: 1, acp: { mode: "plan", args: ["--sandbox"] } });
  });

  it("takes the editor tools away from Claude Code read-only roles and the code critic, and nothing else", () => {
    for (const role of [...READ_ONLY, "code-critic"]) {
      expect(launchTuningFor("claude-code", role, NONE)).toEqual({ version: 1, claude: { disallowedTools: [...CLAUDE_EDITOR_TOOLS] } });
    }
    expect(CLAUDE_EDITOR_TOOLS).not.toContain("Bash");
    expect(CLAUDE_EDITOR_TOOLS).not.toContain("Read");
  });

  it("leaves the code critic's shell on the ACP providers (its packet falls back to git log -p)", () => {
    for (const provider of ["acp-cursor", "devin", "acp-antigravity"]) expect(launchTuningFor(provider, "code-critic", NONE)).toBeNull();
  });

  it("leaves the graph agents that may keep scratch files alone", () => {
    for (const role of ["auditor", "triager"]) for (const provider of ["acp-cursor", "devin", "acp-antigravity", "claude-code"]) expect(launchTuningFor(provider, role, NONE)).toBeNull();
  });

  it("never changes a writer or any other role, on any provider", () => {
    for (const role of WRITERS) for (const provider of ["acp-cursor", "devin", "acp-antigravity", "claude-code", "codex", "opencode2"]) expect(launchTuningFor(provider, role, NONE)).toBeNull();
  });

  it("leaves other providers and unknown input alone", () => {
    expect(launchTuningFor("codex", "plan-critic", NONE)).toBeNull();
    expect(launchTuningFor(undefined, "plan-critic", NONE)).toBeNull();
    expect(launchTuningFor("acp-cursor", undefined, NONE)).toBeNull();
    expect(launchTuningFor("acp-cursor", "", NONE)).toBeNull();
  });

  it("is off with LANE_PILOT_LAUNCH_TUNING=off", () => {
    for (const off of ["off", "OFF", "false", "0", "no"]) {
      expect(launchTuningFor("acp-cursor", "plan-critic", { LANE_PILOT_LAUNCH_TUNING: off } as NodeJS.ProcessEnv)).toBeNull();
    }
    expect(launchTuningFor("acp-cursor", "plan-critic", { LANE_PILOT_LAUNCH_TUNING: "on" } as NodeJS.ProcessEnv)).not.toBeNull();
  });

  it("hands out a fresh object each time", () => {
    const a = launchTuningFor("claude-code", "plan-critic", NONE)!;
    a.claude!.disallowedTools.push("Bash");
    expect(launchTuningFor("claude-code", "plan-critic", NONE)!.claude!.disallowedTools).not.toContain("Bash");
  });
});

describe("launch tuning: the spawn arguments", () => {
  it("adds the tuning next to the role and keeps every other field", () => {
    const args = { providerId: "acp-cursor", prompt: "p", pluginMetadata: { role: "plan-critic", lanePilotRunId: "r1" } };
    expect(withLaunchTuning(args, NONE)).toEqual({ ...args, pluginMetadata: { ...args.pluginMetadata, [KEY]: { version: 1, acp: { mode: "ask" } } } });
  });

  it("returns the very same object when there is nothing to add", () => {
    const writer = { providerId: "acp-cursor", pluginMetadata: { role: "writer" } };
    const noMeta = { providerId: "acp-cursor" };
    expect(withLaunchTuning(writer, NONE)).toBe(writer);
    expect(withLaunchTuning(noMeta, NONE)).toBe(noMeta);
  });

  it("keeps a tuning the caller set itself", () => {
    const own = { providerId: "acp-cursor", pluginMetadata: { role: "plan-critic", [KEY]: { version: 1, acp: { mode: "plan" } } } };
    expect(withLaunchTuning(own, NONE)).toBe(own);
  });
});

describe("launch tuning: through fullAccessSpawn", () => {
  async function spawnWith(providerId: string, role: string, env?: string) {
    const spawned: Record<string, unknown>[] = [];
    const before = process.env.LANE_PILOT_LAUNCH_TUNING;
    if (env === undefined) delete process.env.LANE_PILOT_LAUNCH_TUNING; else process.env.LANE_PILOT_LAUNCH_TUNING = env;
    try {
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: { providers: { list: async () => [{ id: providerId }] }, threads: { spawn: async (args: unknown) => { spawned.push(args as Record<string, unknown>); return { id: "thr-1" }; } } },
      });
      await fullAccessSpawn(bb, { providerId, model: "m", prompt: "p", environment: { type: "host", hostId: "h", workspace: { type: "unmanaged", path: "/tmp/x" } }, pluginMetadata: { role } } as never);
    } finally { if (before === undefined) delete process.env.LANE_PILOT_LAUNCH_TUNING; else process.env.LANE_PILOT_LAUNCH_TUNING = before; }
    return spawned[0]!;
  }

  it("sends the ask mode of a Cursor plan critic to core", async () => {
    const sent = await spawnWith("acp-cursor", "plan-critic");
    expect((sent.pluginMetadata as Record<string, unknown>)[KEY]).toEqual({ version: 1, acp: { mode: "ask" } });
    expect(sent.permissionMode).toBe("full");
  });

  it("sends the editor-tool ban of a Claude Code reviewer to core", async () => {
    const sent = await spawnWith("claude-code", "specialist-reviewer");
    expect((sent.pluginMetadata as Record<string, unknown>)[KEY]).toEqual({ version: 1, claude: { disallowedTools: [...CLAUDE_EDITOR_TOOLS] } });
  });

  it("sends nothing for a writer", async () => {
    for (const provider of ["acp-cursor", "devin", "acp-antigravity", "claude-code"]) {
      expect(((await spawnWith(provider, "writer")).pluginMetadata as Record<string, unknown>)[KEY]).toBeUndefined();
    }
  });

  it("sends nothing when the switch is off", async () => {
    expect(((await spawnWith("acp-cursor", "plan-critic", "off")).pluginMetadata as Record<string, unknown>)[KEY]).toBeUndefined();
  });
});
