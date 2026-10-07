import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import bundledAgents from "../src/bundled-agents.json";
import { compileMainAgentProfile } from "../src/agent-profile";
import {
  splitClaudeToolList,
  stockAgentsOverlayFromInstalled,
  unionLpBridgeToolsOnAgentsJson,
  LANE_PILOT_PM_SESSION,
  lanePmOverlayPrompt,
  overlayLanePmPrompt,
  overlayLaneAgentPrompt,
  overlaySessionTools,
  laneSessionOverlayPrompt,
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
  expect(body.prompt).toBe(`You are **dev-orchestrator**.\n\n${LANE_PILOT_PM_SESSION}\n`);
  expect(body.description).toBe("Solo PM.");
  expect(body.tools).toEqual(expect.arrayContaining([
    "Agent(Explore)",
    "Read",
    "Write",
    "Bash",
    "mcp__bb-bridge__lane_pilot_read",
    "mcp__bb-bridge__lane_pilot_dispatch_writer",
    "mcp__bb-bridge__lane_pilot_cancel_task",
    "mcp__bb-bridge__lane_pilot_wait_writer",
    "mcp__bb-bridge__lane_pilot_browser_qa",
    "mcp__bb-bridge__lane_pilot_memory_context",
    "mcp__bb-bridge__lane_pilot_workspace_status",
  ]));
  expect(body.tools).not.toContain("mcp__bb-bridge__lane_pilot_dispatch_cli");
  expect(body.tools).not.toContain("mcp__bb-bridge__lane_pilot_night_review");
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

it("unions LP tools onto an edited --agents JSON without replacing a custom prompt", () => {
  const next = unionLpBridgeToolsOnAgentsJson("dev-orchestrator", JSON.stringify({
    "dev-orchestrator": { description: "Edited", prompt: "Edited prompt", tools: ["Read"] },
  }));
  const body = next["dev-orchestrator"] as Record<string, unknown>;
  expect(body.prompt).toBe("Edited prompt");
  expect(body.tools).toEqual(expect.arrayContaining(["Read", "mcp__bb-bridge__lane_pilot_read"]));
  expect(body.tools).not.toContain("Write");
  expect(body.tools).not.toContain("mcp__bb-bridge__lane_pilot_dispatch_cli");
  expect(body.tools).not.toContain("*");
});

it("gives specialists no bb-bridge tools and keeps the PM core plus browser QA", () => {
  expect(overlaySessionTools("copy-lead", ["Read", "mcp__bb-bridge__lane_pilot_read"])).toEqual(["Read"]);
  expect(overlaySessionTools("dev-orchestrator", ["Read", "mcp__bb-bridge__lane_pilot_night_review"])).toEqual([
    "Read",
    "mcp__bb-bridge__lane_pilot_read",
    "mcp__bb-bridge__lane_pilot_dispatch_writer",
    "mcp__bb-bridge__lane_pilot_cancel_task",
    "mcp__bb-bridge__lane_pilot_update_task",
    "mcp__bb-bridge__lane_pilot_wait_writer",
    "mcp__bb-bridge__lane_pilot_answer_writer",
    "mcp__bb-bridge__lane_pilot_ask_owner",
    "mcp__bb-bridge__lane_pilot_browser_qa",
    "mcp__bb-bridge__lane_pilot_memory_context",
    "mcp__bb-bridge__lane_pilot_workspace_status",
    "mcp__bb-bridge__lane_pilot_routing_stats",
    "mcp__bb-bridge__lane_pilot_lessons_sweep",
    "mcp__bb-bridge__lane_pilot_rule_propose",
    "mcp__bb-bridge__lane_pilot_lesson",
    "mcp__bb-bridge__lane_pilot_run_health",
    "mcp__bb-bridge__lane_pilot_council_start",
    "mcp__bb-bridge__lane_pilot_council_status",
    "mcp__bb-bridge__lane_pilot_council_say",
    "mcp__bb-bridge__lane_pilot_council_stop",
    "mcp__bb-bridge__lane_pilot_specialist",
    "mcp__bb-bridge__lane_pilot_wait_specialist",
    "mcp__bb-bridge__lane_pilot_browser",
    "mcp__bb-bridge__lane_pilot_errand",
    "mcp__bb-bridge__lane_pilot_wait_errand",
    "mcp__bb-bridge__lane_pilot_ask",
    "mcp__bb-bridge__lane_pilot_reply",
    "mcp__bb-bridge__lane_pilot_remind",
    "mcp__bb-bridge__lane_pilot_relay_list",
    "mcp__bb-bridge__lane_pilot_workflow_draft_create",
    "mcp__bb-bridge__lane_pilot_workflow_draft_patch",
    "mcp__bb-bridge__lane_pilot_workflow_draft_get",
    "mcp__bb-bridge__lane_pilot_workflow_capabilities",
    "mcp__bb-bridge__lane_pilot_workflow_draft_test",
    "mcp__bb-bridge__lane_pilot_workflow_draft_publish",
    "mcp__bb-bridge__lane_pilot_route",
    "mcp__bb-bridge__lane_pilot_run_workflow",
    "mcp__bb-bridge__lane_pilot_workflow_status",
    "mcp__bb-bridge__lane_pilot_workflow_amend",
    // Without ToolSearch Claude Code sends every MCP schema at the start; with it the schemas load when the PM asks.
    "ToolSearch",
  ]);
  expect(overlaySessionTools("copy-lead", ["Read"])).not.toContain("ToolSearch");
  expect(overlaySessionTools("dev-orchestrator", ["Read", "ToolSearch"]).filter((tool) => tool === "ToolSearch")).toHaveLength(1);
  const overlay = stockAgentsOverlayFromInstalled({
    agentId: "dev-orchestrator",
    source: "plugin:lane-stack",
    markdown: PLUGIN_MD,
  }) as Record<string, { tools: string[] }>;
  // Specialists start as their own threads; the PM session carries no copy-lead companion.
  expect(overlay).not.toHaveProperty("copy-lead");
});

it("does not rewrite a custom --agents prompt", () => {
  const next = unionLpBridgeToolsOnAgentsJson("dev-orchestrator", JSON.stringify({
    "dev-orchestrator": {
      description: "PM",
      prompt: "Dispatch run-controller then project-onboarder for docs/llm. lane-ctl accept.",
      tools: ["Read"],
    },
  }));
  expect((next["dev-orchestrator"] as { prompt: string }).prompt).toBe(
    "Dispatch run-controller then project-onboarder for docs/llm. lane-ctl accept.",
  );
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

it("is a unified BB PM instruction, not a CLI orchestrator patch", () => {
  expect(LANE_PILOT_PM_SESSION).toMatch(/Делать правки/);
  expect(LANE_PILOT_PM_SESSION).toContain("lane_pilot_dispatch_writer");
  expect(LANE_PILOT_PM_SESSION).toContain("design-lead");
  expect(LANE_PILOT_PM_SESSION).toContain("copy-lead");
  expect(LANE_PILOT_PM_SESSION).toContain("seo-specialist");
  expect(LANE_PILOT_PM_SESSION).toContain("lane_pilot_browser_qa");
  expect(LANE_PILOT_PM_SESSION).toContain("Mac mini");
  expect(LANE_PILOT_PM_SESSION).toContain("Checking a task of ours after acceptance");
  expect(LANE_PILOT_PM_SESSION).toContain("lane_pilot_browser_qa");
  expect(LANE_PILOT_PM_SESSION).toContain("PROJECT.md");
  expect(LANE_PILOT_PM_SESSION).toContain("docs/audiences/");
  expect(LANE_PILOT_PM_SESSION).toContain("specialized agents");
  expect(LANE_PILOT_PM_SESSION).toMatch(/terminal Lane Stack run machinery is not used in this chat/);
  expect(LANE_PILOT_PM_SESSION).toContain("scripts/deploy.sh");
  expect(LANE_PILOT_PM_SESSION).toContain("asking «Запустить?» or «Делать правки?» only costs a round trip");
  expect(LANE_PILOT_PM_SESSION).not.toContain("docs/llm");
  expect(LANE_PILOT_PM_SESSION).not.toContain("stages.docs");
  expect(LANE_PILOT_PM_SESSION).not.toContain("stages.onboard");
});

it("stock plugin compile is a BB session, not a CLI dump", () => {
  const stock = bundledAgents["dev-orchestrator"].prompt;
  expect(compileMainAgentProfile("dev-orchestrator").prompt).toBe(lanePmOverlayPrompt("dev-orchestrator"));
  expect(overlayLanePmPrompt("dev-orchestrator", stock)).not.toContain("Boot solo");
});

it("replaces bundled specialist dumps with BB sessions", () => {
  expect(overlayLaneAgentPrompt("copy-lead", bundledAgents["copy-lead"].prompt)).toBe(laneSessionOverlayPrompt("copy-lead"));
  expect(overlayLaneAgentPrompt("seo-specialist", bundledAgents["seo-specialist"].prompt)).toContain("docs/audiences/seo.md");
  expect(overlayLaneAgentPrompt("design-lead", bundledAgents["design-lead"].prompt)).toContain("docs/audiences/design.md");
  expect(overlayLaneAgentPrompt("tavily", bundledAgents["tavily"].prompt)).toContain(".agents/research/inbox");
  expect(overlayLaneAgentPrompt("tavily", bundledAgents["tavily"].prompt)).not.toContain("Boot **tavily**");
  expect(overlayLaneAgentPrompt("project-onboarder", bundledAgents["project-onboarder"].prompt)).not.toContain("docs/llm");
});

it("replaces a stock CLI orchestrator body instead of appending it", () => {
  const overlay = stockAgentsOverlayFromInstalled({
    agentId: "dev-orchestrator",
    source: "plugin:lane-stack",
    markdown: `---
name: dev-orchestrator
description: Solo PM.
tools: Agent(lane-stack:run-supervisor, lane-stack:project-onboarder, lane-stack:docs-maintainer, lane-stack:design-lead, Explore), Read
---
You are **dev-orchestrator**. Dispatch run-controller. Then spawn project-onboarder for CLAUDE / docs/llm. Use lane-ctl accept.
`,
  });
  const body = overlay?.["dev-orchestrator"] as { prompt: string; tools: string[] };
  expect(body.prompt).toBe(lanePmOverlayPrompt("dev-orchestrator"));
  expect(body.prompt).not.toContain("docs/llm");
  // Specialists are child threads (lane_pilot_specialist), not subagents of the PM session.
  expect(body.tools[0]).toBe("Agent(Explore)");
  expect(overlay).not.toHaveProperty("project-onboarder");
  expect(overlay).not.toHaveProperty("copy-lead");
  expect(overlay).not.toHaveProperty("browser-qa");
});

it("keeps a Lane PM from delegating code to general-purpose subagents", async () => {
  const { withoutCodeWritingSubagents, stockAgentsOverlayFromInstalled } = await import("../src/native-agent-overlay");
  expect(withoutCodeWritingSubagents("dev-orchestrator", ["Agent(lane-stack:run-supervisor, Explore, Plan, general-purpose)", "Read"]))
    .toEqual(["Agent(Explore, Plan)", "Read"]);
  expect(withoutCodeWritingSubagents("lane-stack:dev-orchestrator", ["Agent"])).toEqual(["Agent(Explore, Plan)"]);
  expect(withoutCodeWritingSubagents("copy-lead", ["Agent(Explore, general-purpose)"])).toEqual(["Agent(Explore, general-purpose)"]);
  const overlay = stockAgentsOverlayFromInstalled({
    agentId: "dev-orchestrator",
    source: "plugin:lane-stack",
    markdown: "---\nname: dev-orchestrator\ndescription: PM\ntools: Agent(Explore, Plan, general-purpose), Read\n---\nBody",
  }) as Record<string, { tools: string[] }>;
  expect(overlay["dev-orchestrator"]!.tools[0]).toBe("Agent(Explore, Plan)");
  expect((overlay["dev-orchestrator"] as unknown as { prompt: string }).prompt).toContain("lane_pilot_dispatch_writer");
  expect(withoutCodeWritingSubagents("dev-orchestrator", ["Agent(lane-stack:run-supervisor, lane-stack:design-lead, Explore)"])).toEqual(["Agent(Explore)"]);
  expect(withoutCodeWritingSubagents("dev-orchestrator", [
    "Agent(lane-stack:project-onboarder, lane-stack:docs-maintainer, lane-stack:night-reviewer, lane-stack:copy-lead, Explore)",
  ])).toEqual(["Agent(Explore)"]);
});

it("overlay PM session carries the goal-based authorization policy and omits per-step literal constraints", () => {
  expect(LANE_PILOT_PM_SESSION).toContain("Authorization follows the owner's goal, not each command.");
  expect(LANE_PILOT_PM_SESSION).toContain("Never ask step by step for steps of an approved plan.");
  expect(LANE_PILOT_PM_SESSION).not.toContain("exactly that change");
});
