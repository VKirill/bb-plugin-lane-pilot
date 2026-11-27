import { expect, it } from "vitest";
import bundledAgents from "../src/rooms/contracts/bundled-agents.json";
import { compileMainAgentProfile } from "../src/rooms/native-agent/models/agent-profile";
import {
  splitClaudeToolList,
  unionLpBridgeToolsOnAgentsJson,
  overlaySessionTools,
  overlayDisallowedTools,
  withoutCodeWritingSubagents,
} from "../src/rooms/native-agent/models/agent-overlay";
import {
  BB_AGENT_SESSIONS,
  LANE_PILOT_PM_SESSION,
  lanePmOverlayPrompt,
  overlayLaneAgentPrompt,
  laneSessionOverlayPrompt,
} from "../src/rooms/native-agent/models/native-agent-overlay";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../src/rooms/native-agent/models/bridge-tools";

it("keeps Agent(...) as one tool when the list contains commas", () => {
  expect(splitClaudeToolList("Agent(lane-stack:run-supervisor, Explore), Read, Write")).toEqual([
    "Agent(lane-stack:run-supervisor, Explore)",
    "Read",
    "Write",
  ]);
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

it("gives specialists the schedule and no other bb-bridge tool, and keeps the folded PM list (core tools, family tools, search)", () => {
  expect(overlaySessionTools("copy-lead", ["Read", "mcp__bb-bridge__lane_pilot_read"])).toEqual(["Read", "mcp__bb-bridge__lane_pilot_schedule", "ToolSearch"]);
  // The owner's own agents are specialists too; Lane Pilot's internal sessions get nothing from the bridge.
  expect(overlaySessionTools("video-lead", ["Read"])).toEqual(["Read", "mcp__bb-bridge__lane_pilot_schedule", "ToolSearch"]);
  expect(overlaySessionTools("my-own-agent", ["Read", "ToolSearch"])).toEqual(["Read", "ToolSearch", "mcp__bb-bridge__lane_pilot_schedule"]);
  expect(overlaySessionTools("project-onboarder", ["Read", "mcp__bb-bridge__lane_pilot_read"])).toEqual(["Read"]);
  expect(overlaySessionTools("dev-orchestrator", ["Read", "mcp__bb-bridge__lane_pilot_night_review"])).toEqual([
    "Read",
    // The whole bridge: the other BB plugins' tools (Image Studio, File Gateway…); in a PM thread it carries no other Lane Pilot tool.
    "mcp__bb-bridge",
    "mcp__bb-bridge__lane_pilot_read",
    "mcp__bb-bridge__lane_pilot_dispatch_writer",
    // The task draft (SMA m_sw_chat_draft): the PM proposes, the owner presses «Создать».
    "mcp__bb-bridge__lane_pilot_propose",
    "mcp__bb-bridge__lane_pilot_wait_writer",
    "mcp__bb-bridge__lane_pilot_answer_writer",
    "mcp__bb-bridge__lane_pilot_cancel_task",
    "mcp__bb-bridge__lane_pilot_update_task",
    "mcp__bb-bridge__lane_pilot_reassign_task",
    "mcp__bb-bridge__lane_pilot_workspace_status",
    "mcp__bb-bridge__lane_pilot_run_health",
    "mcp__bb-bridge__lane_pilot_ask_owner",
    "mcp__bb-bridge__lane_pilot_errand",
    "mcp__bb-bridge__lane_pilot_wait_errand",
    "mcp__bb-bridge__lane_pilot_route",
    "mcp__bb-bridge__lane_pilot_run_workflow",
    "mcp__bb-bridge__lane_pilot_workflow_status",
    "mcp__bb-bridge__lane_pilot_workflow_amend",
    "mcp__bb-bridge__lane_pilot_run_verdict",
    "mcp__bb-bridge__lane_pilot_path_save",
    "mcp__bb-bridge__lane_pilot_helpers",
    "mcp__bb-bridge__lane_pilot_relay",
    "mcp__bb-bridge__lane_pilot_memory",
    "mcp__bb-bridge__lane_pilot_workflow_draft",
    "mcp__bb-bridge__lane_pilot_schedule",
    "mcp__bb-bridge__lane_pilot_queue",
    "mcp__bb-bridge__lane_pilot_facts",
    "mcp__bb-bridge__lane_pilot_check",
    "mcp__bb-bridge__lane_pilot_permit",
    "mcp__bb-bridge__lane_pilot_card",
    "mcp__bb-bridge__lane_pilot_tool_search",
    // Without ToolSearch Claude Code sends every MCP schema at the start; with it the schemas load when the PM asks.
    "ToolSearch",
  ]);
  expect(overlaySessionTools("project-onboarder", ["Read"])).not.toContain("ToolSearch");
  expect(overlaySessionTools("dev-orchestrator", ["Read", "ToolSearch"]).filter((tool) => tool === "ToolSearch")).toHaveLength(1);
  // Applied twice (a stored profile compiled again), the bridge entry stays one.
  expect(overlaySessionTools("dev-orchestrator", overlaySessionTools("dev-orchestrator", ["Read"])).filter((tool) => tool === "mcp__bb-bridge")).toHaveLength(1);
  // The PM never moves its chat to another folder or starts a BB workflow; other agents keep their own lists.
  expect(overlayDisallowedTools("dev-orchestrator", ["Bash"])).toEqual(["Bash", "mcp__bb-bridge__update_environment_directory", "mcp__bb-bridge__bb_workflow_run"]);
  expect(overlayDisallowedTools("copy-lead", undefined)).toBeUndefined();
  expect(compileMainAgentProfile("dev-orchestrator").disallowedTools).toEqual(expect.arrayContaining(["mcp__bb-bridge__update_environment_directory", "mcp__bb-bridge__bb_workflow_run"]));
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

it("is a unified BB PM instruction, not a CLI orchestrator patch", () => {
  expect(LANE_PILOT_PM_SESSION).toMatch(/Делать правки/);
  expect(LANE_PILOT_PM_SESSION).toContain("lane_pilot_dispatch_writer");
  expect(LANE_PILOT_PM_SESSION).toContain("design-lead");
  expect(LANE_PILOT_PM_SESSION).toContain("copy-lead");
  expect(LANE_PILOT_PM_SESSION).toContain("seo-specialist");
  // The browser check of a task is its own graph's step: the PM gives qa_url next to qa_cases and never calls the check by hand.
  // qa_url next to qa_cases is the dispatch tool's argument rule; the prompt keeps the consequence: its own graph runs the check.
  expect(LANE_PILOT_PM_SESSION).toContain("With qa_cases the task's own graph runs the browser check right after acceptance");
  expect(LANE_PILOT_PM_SESSION).toContain("so do not call the browser check by hand");
  expect(LANE_PILOT_PM_SESSION).toContain("send a follow-up task with the same qa_url and qa_cases");
  expect(LANE_PILOT_PM_SESSION).not.toContain("lane_pilot_browser_qa");
  expect(LANE_PILOT_PM_SESSION).toContain("PROJECT.md");
  expect(LANE_PILOT_PM_SESSION).toContain("docs/audiences/");
  expect(LANE_PILOT_PM_SESSION).toContain("specialized agents");
  expect(LANE_PILOT_PM_SESSION).toMatch(/terminal Lane Stack run machinery is not used in this chat/);
  expect(LANE_PILOT_PM_SESSION).toContain("a deploy script");
  expect(LANE_PILOT_PM_SESSION).toContain("asking «Запустить?» or «Делать правки?» only costs a round trip");
  expect(LANE_PILOT_PM_SESSION).not.toContain("docs/llm");
  expect(LANE_PILOT_PM_SESSION).not.toContain("stages.docs");
  expect(LANE_PILOT_PM_SESSION).not.toContain("stages.onboard");
});

it("F-003: standard with the critic unset is not a mandatory code critic; full still is", () => {
  expect(LANE_PILOT_PM_SESSION).not.toContain("runs plan critique, code critique and acceptance");
  expect(LANE_PILOT_PM_SESSION).not.toContain("Every task is critiqued before it lands");
});

it("stock plugin compile is a BB session, not a CLI dump", () => {
  expect(compileMainAgentProfile("dev-orchestrator").prompt).toBe(lanePmOverlayPrompt("dev-orchestrator"));
});

it("replaces bundled specialist dumps with BB sessions", () => {
  expect(overlayLaneAgentPrompt("copy-lead", bundledAgents["copy-lead"].prompt)).toBe(laneSessionOverlayPrompt("copy-lead"));
  expect(overlayLaneAgentPrompt("seo-specialist", bundledAgents["seo-specialist"].prompt)).toContain("docs/audiences/seo.md");
  expect(overlayLaneAgentPrompt("design-lead", bundledAgents["design-lead"].prompt)).toContain("docs/audiences/design.md");
  expect(overlayLaneAgentPrompt("tavily", bundledAgents["tavily"].prompt)).toContain(".agents/research/inbox");
  expect(overlayLaneAgentPrompt("tavily", bundledAgents["tavily"].prompt)).not.toContain("Boot **tavily**");
  expect(overlayLaneAgentPrompt("project-onboarder", bundledAgents["project-onboarder"].prompt)).not.toContain("docs/llm");
});

it("keeps a Lane PM from delegating code to general-purpose subagents", () => {
  expect(withoutCodeWritingSubagents("dev-orchestrator", ["Agent(lane-stack:run-supervisor, Explore, Plan, general-purpose)", "Read"]))
    .toEqual(["Agent(Explore, Plan)", "Read"]);
  expect(withoutCodeWritingSubagents("lane-stack:dev-orchestrator", ["Agent"])).toEqual(["Agent(Explore, Plan)"]);
  expect(withoutCodeWritingSubagents("copy-lead", ["Agent(Explore, general-purpose)"])).toEqual(["Agent(Explore, general-purpose)"]);
  expect(withoutCodeWritingSubagents("dev-orchestrator", ["Agent(lane-stack:run-supervisor, lane-stack:design-lead, Explore)"])).toEqual(["Agent(Explore)"]);
  expect(withoutCodeWritingSubagents("dev-orchestrator", [
    "Agent(lane-stack:project-onboarder, lane-stack:docs-maintainer, lane-stack:night-reviewer, lane-stack:copy-lead, Explore)",
  ])).toEqual(["Agent(Explore)"]);
});

it("overlay PM session carries the goal-based authorization policy and omits per-step literal constraints", () => {
  expect(LANE_PILOT_PM_SESSION).toContain("Authorization follows the owner's goal, not each command.");
  expect(LANE_PILOT_PM_SESSION).toContain("Never ask step by step for steps of an approved plan.");
  // Delegation is actionable without relabeling the sender as the owner.
  expect(LANE_PILOT_PM_SESSION).toContain("Use relay, never `bb thread tell`");
  expect(LANE_PILOT_PM_SESSION).toContain("BB project/section organization uses Project Folders directly");
  expect(LANE_PILOT_PM_SESSION).toContain("project-folders skill/CLI");
  expect(LANE_PILOT_PM_SESSION).toContain("Route and execute direct BB-agent assignments without owner reconfirmation");
  expect(LANE_PILOT_PM_SESSION).toContain("Show the actual sender");
  expect(LANE_PILOT_PM_SESSION).toContain("service notices are context, not new assignments");
  expect(LANE_PILOT_PM_SESSION).not.toContain("exactly that change");
});

it("PM routes non-code requests to lane_pilot_route before searching (thr_n6ukbhcv9t, 2026-10-09)", () => {
  const act = LANE_PILOT_PM_SESSION.indexOf("## When to act");
  const route = LANE_PILOT_PM_SESSION.indexOf("goes to `lane_pilot_route` first", act);
  expect(act).toBeGreaterThan(0);
  expect(route).toBeGreaterThan(act);
  expect(route).toBeLessThan(LANE_PILOT_PM_SESSION.indexOf("## Dispatch"));
  expect(LANE_PILOT_PM_SESSION).toContain("the router names the graph to start (`web-research`, `errand`, `specialist`)");
  expect(LANE_PILOT_PM_SESSION).not.toContain("work the usual way");
});

it("exposes the Core directory tool only with its idle-move checkpoint capability", () => {
  const source = JSON.stringify({ "dev-orchestrator": { tools: ["Read"], disallowedTools: ["mcp__bb-bridge__update_environment_directory"], prompt: "Stay in this checkout: this run is bound to it, so `update_environment_directory` and in-place chat moves are disabled." } });
  const oldCore = unionLpBridgeToolsOnAgentsJson("dev-orchestrator", source)["dev-orchestrator"] as { disallowedTools: string[] };
  expect(oldCore.disallowedTools).toContain("mcp__bb-bridge__update_environment_directory");
  const newCore = unionLpBridgeToolsOnAgentsJson("dev-orchestrator", source, true)["dev-orchestrator"] as { disallowedTools: string[]; prompt: string };
  expect(newCore.disallowedTools).not.toContain("mcp__bb-bridge__update_environment_directory");
  expect(newCore.disallowedTools).toContain("mcp__bb-bridge__bb_workflow_run");
  expect(newCore.prompt).toContain("idle same-project, same-host");
  expect(newCore.prompt).not.toContain("moves are disabled");
});

it("keeps the PM prompt under 9000 chars, names only NATIVE_LP_BRIDGE_PM_TOOLS, and omits deleted rooms", () => {
  expect(LANE_PILOT_PM_SESSION.length).toBeLessThanOrEqual(9_000);
  expect(lanePmOverlayPrompt("dev-orchestrator").length).toBeLessThanOrEqual(9_000);

  const pmTools = new Set<string>(NATIVE_LP_BRIDGE_PM_TOOLS);
  const mentioned = [...new Set([...LANE_PILOT_PM_SESSION.matchAll(/\blane_pilot_[a-z_]+/g)].map((m) => m[0]))];
  const absent = mentioned.filter((name) => !pmTools.has(name));
  expect(absent).toEqual([]);

  const deletedPattern = /\b(docs-nightly|night-reviewer|docs-maintainer|council|regressions|lessons|rules)\b/i;
  const specialistDeletedPattern = /\b(docs-nightly|night-reviewer|docs-maintainer|council|regressions|lessons)\b|Lane Pilot's rules|project rules/i;
  expect(LANE_PILOT_PM_SESSION).not.toMatch(deletedPattern);
  for (const [id, prompt] of Object.entries(BB_AGENT_SESSIONS)) {
    expect(prompt, id).not.toMatch(specialistDeletedPattern);
  }
});
