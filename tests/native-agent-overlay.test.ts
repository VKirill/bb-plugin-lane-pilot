import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  splitClaudeToolList,
  stockAgentsOverlayFromInstalled,
  unionLpBridgeToolsOnAgentsJson,
} from "../src/native-agent-overlay";
import { resolveInstalledAgentFile } from "../src/native-claude-host";

const PLUGIN_MD = `---
name: dev-orchestrator
description: "Solo PM."
tools: Agent(lane-stack:run-supervisor, Explore), Read, Write, Bash
permissionMode: bypassPermissions
model: opus[1m]
effort: high
color: pink
maxTurns: 120
skills:
  - lane-contract
initialPrompt: |
  Boot now.
---
You are **dev-orchestrator**.
`;

it("keeps Agent(...) as one tool when the list contains commas", () => {
  expect(splitClaudeToolList("Agent(lane-stack:run-supervisor, Explore), Read, Write")).toEqual([
    "Agent(lane-stack:run-supervisor, Explore)",
    "Read",
    "Write",
  ]);
});

it("overlays plugin stock from the installed file without activating ignored or BB-owned fields", () => {
  const overlay = stockAgentsOverlayFromInstalled({
    agentId: "dev-orchestrator",
    source: "plugin:lane-stack",
    markdown: PLUGIN_MD,
  });
  const body = overlay?.["dev-orchestrator"] as Record<string, unknown>;
  expect(body.prompt).toBe("You are **dev-orchestrator**.\n");
  expect(body.description).toBe("Solo PM.");
  expect(body.tools).toEqual(expect.arrayContaining([
    "Agent(lane-stack:run-supervisor, Explore)",
    "Read",
    "Write",
    "Bash",
    "mcp__bb-bridge__lane_pilot_read",
  ]));
  expect(body.tools).not.toContain("*");
  expect(body.skills).toEqual(["lane-contract"]);
  expect(body.maxTurns).toBe(120);
  expect(body).not.toHaveProperty("permissionMode");
  expect(body).not.toHaveProperty("initialPrompt");
  expect(body).not.toHaveProperty("model");
  expect(body).not.toHaveProperty("effort");
  expect(body).not.toHaveProperty("hooks");
  expect(body).not.toHaveProperty("mcpServers");
});

it("keeps project-agent permissionMode because that loader honors it", () => {
  const overlay = stockAgentsOverlayFromInstalled({
    agentId: "dev-orchestrator",
    source: "project",
    markdown: PLUGIN_MD,
  });
  const body = overlay?.["dev-orchestrator"] as Record<string, unknown>;
  expect(body.permissionMode).toBe("bypassPermissions");
  expect(body.initialPrompt).toBe("Boot now.");
  expect(body).not.toHaveProperty("model");
  expect(body).not.toHaveProperty("effort");
});

it("unions LP tools onto an edited --agents JSON without replacing the prompt", () => {
  const next = unionLpBridgeToolsOnAgentsJson("dev-orchestrator", JSON.stringify({
    "dev-orchestrator": { description: "Edited", prompt: "Edited prompt", tools: ["Read"] },
  }));
  const body = next["dev-orchestrator"] as Record<string, unknown>;
  expect(body.prompt).toBe("Edited prompt");
  expect(body.tools).toEqual(expect.arrayContaining(["Read", "mcp__bb-bridge__lane_pilot_read"]));
  expect(body.tools).not.toContain("Write");
  expect(body.tools).not.toContain("*");
});

it("resolves the installed markdown from the actual cwd, not a bundled copy", async () => {
  const root = join(tmpdir(), `lp-agent-src-${Date.now()}`);
  const cwd = join(root, "project");
  const config = join(root, "claude");
  await mkdir(join(cwd, ".claude/agents"), { recursive: true });
  await mkdir(join(config, "agents"), { recursive: true });
  await writeFile(join(cwd, ".claude/agents/dev-orchestrator.md"), PLUGIN_MD);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const found = await resolveInstalledAgentFile(cwd, "dev-orchestrator");
    expect(found).toEqual({
      id: "dev-orchestrator",
      source: "project",
      path: join(cwd, ".claude/agents/dev-orchestrator.md"),
    });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});
