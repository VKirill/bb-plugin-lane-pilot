import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { agentPickerLabel } from "../src/rooms/native-agent/agent-display";
import { compileMainAgentProfile, MAIN_AGENT_PROFILE_IDS } from "../src/rooms/native-agent/agent-profile";
import { createRun, openDatabase, savePrototypeConfig, setRunThread } from "../src/rooms/storage/database";
import { BB_AGENT_SUMMARIES, LANE_PILOT_PM_SESSION, laneSessionOverlayPrompt, overlaySessionTools } from "../src/rooms/native-agent/native-agent-overlay";
import { finalizeNativeLaneBinding } from "../src/rooms/native-agent/native-run";
import { NATIVE_LP_BRIDGE_ARCHITECT_TOOLS, NATIVE_LP_BRIDGE_PM_TOOLS, NATIVE_LP_BRIDGE_TOOLS } from "../src/rooms/native-agent/native-session-hooks";
import { foldedToolHome } from "../src/rooms/tools/pm-tool-families";
import { ARCHITECT_LAUNCH, WORKFLOW_ARCHITECT_ID, WORKFLOW_ARCHITECT_SESSION } from "../src/rooms/workflow/workflow-architect";
import { setLocaleOverride, t } from "@lane-pilot/i18n";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); setLocaleOverride(null); });

describe("Workflow architect profile", () => {
  it("is a selectable main agent next to the PM, in English and Russian", () => {
    expect(MAIN_AGENT_PROFILE_IDS).toContain(WORKFLOW_ARCHITECT_ID);
    const profile = compileMainAgentProfile(WORKFLOW_ARCHITECT_ID);
    expect(profile.description).toBe("Workflow architect");
    setLocaleOverride("en");
    expect(agentPickerLabel({ id: WORKFLOW_ARCHITECT_ID, description: profile.description }, t)).toBe("Workflow architect");
    setLocaleOverride("ru");
    expect(agentPickerLabel({ id: WORKFLOW_ARCHITECT_ID, description: profile.description }, t)).toBe("Архитектор цепочек");
    expect(agentPickerLabel({ id: WORKFLOW_ARCHITECT_ID, description: "Lane Pilot workflow architect" }, t)).toBe("Архитектор цепочек");
    expect(agentPickerLabel({ id: WORKFLOW_ARCHITECT_ID, description: "My own architect" }, t)).toBe("My own architect");
    expect(BB_AGENT_SUMMARIES[WORKFLOW_ARCHITECT_ID]).toContain("Workflow architect");
  });

  it("builds chains and does not write code or dispatch writers: its tools are reading, the web and the workflow tools", () => {
    const profile = compileMainAgentProfile(WORKFLOW_ARCHITECT_ID);
    const tools = profile.tools ?? [];
    expect(tools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "mcp__bb-bridge__lane_pilot_workflow_draft_patch", "mcp__bb-bridge__lane_pilot_workflow_draft_publish", "mcp__bb-bridge__lane_pilot_ask_owner"]));
    for (const forbidden of ["Write", "Edit", "Bash", "mcp__bb-bridge__lane_pilot_dispatch_writer", "mcp__bb-bridge__lane_pilot_errand", "mcp__bb-bridge__lane_pilot_browser"]) expect(tools).not.toContain(forbidden);
    expect(tools.filter((tool) => tool.startsWith("mcp__bb-bridge__lane_pilot_")).map((tool) => tool.replace("mcp__bb-bridge__", "")).sort()).toEqual([...NATIVE_LP_BRIDGE_ARCHITECT_TOOLS].sort());
    // A saved definition that lists other bridge tools gets exactly the architect's.
    expect(overlaySessionTools(WORKFLOW_ARCHITECT_ID, ["Read", "mcp__bb-bridge__lane_pilot_dispatch_writer"])).not.toContain("mcp__bb-bridge__lane_pilot_dispatch_writer");
    expect(profile.prompt).toBe(laneSessionOverlayPrompt(WORKFLOW_ARCHITECT_ID));
  });

  it("names only tools it has, and knows the interview, the format, the availability sources and the secrets rule", () => {
    const mentioned = new Set([...WORKFLOW_ARCHITECT_SESSION.matchAll(/\blane_pilot_[a-z_]+/g)].map((match) => match[0]));
    expect([...mentioned].filter((name) => !(NATIVE_LP_BRIDGE_ARCHITECT_TOOLS as readonly string[]).includes(name))).toEqual([]);
    for (const tool of NATIVE_LP_BRIDGE_ARCHITECT_TOOLS) if (tool.startsWith("lane_pilot_workflow_")) expect(mentioned.has(tool), tool).toBe(true);
    for (const phrase of ["Interview, briefly", "lane_pilot_workflow_capabilities", "browser-automation", "computer-use", "tavily", "Env Catalog", "env_request", "never ask for the value in chat", "lp-task",
      "same-session", "read-prior-session", "maxVisits", "human", "parallel", "quality_mode", "SKILL.md", "~/.agents/skills", "confirm: true", "data from outside"]) {
      expect(WORKFLOW_ARCHITECT_SESSION, phrase).toContain(phrase);
    }
    expect(WORKFLOW_ARCHITECT_SESSION.length).toBeLessThan(32_000);
  });

  it("every tool it has is registered by the plugin and bound to a native chat; the PM has the same chain tools", () => {
    for (const tool of NATIVE_LP_BRIDGE_ARCHITECT_TOOLS) {
      expect(NATIVE_LP_BRIDGE_TOOLS, tool).toContain(tool);
      // The PM reaches the same handlers as actions of the folded family tool.
      expect(NATIVE_LP_BRIDGE_PM_TOOLS, tool).toContain(foldedToolHome(tool)?.tool ?? tool);
    }
    expect(LANE_PILOT_PM_SESSION).toContain("lane_pilot_workflow_draft");
    for (const action of ["get", "patch", "test", "publish"]) expect(LANE_PILOT_PM_SESSION).toContain(`"${action}"`);
    expect(LANE_PILOT_PM_SESSION).toContain("Workflow architect");
  });

  it("is offered to the owner like the PM: in the composer's agent list, and prepared with the architect's own definition", async () => {
    const fake = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(fake.bb);
    savePrototypeConfig(db, { projectId: "project_a", hostId: "host_a", pmWorkspacePath: "/workspace", writerWorkspacePath: "/workspace", pmProviderId: "claude-code", pmModel: "claude", writerProviderId: "claude-code", writerModel: "claude" });
    await plugin(fake.bb);
    cleanup.push(() => fake.harness.lifecycle.dispose());
    const globals = await fake.harness.behavior.callRpc("get_globals", {}) as { agents: Array<{ id: string; description: string; tools?: string[] }> };
    expect(globals.agents.map((agent) => agent.id)).toContain(WORKFLOW_ARCHITECT_ID);
    const prepared = await fake.harness.behavior.callRpc("prepare_native_session", { projectId: "project_a", agentId: WORKFLOW_ARCHITECT_ID }) as { token: string; agentId: string; label: string };
    expect(prepared).toMatchObject({ agentId: WORKFLOW_ARCHITECT_ID, label: "Workflow architect" });
    expect(ARCHITECT_LAUNCH.input("project_a")).toEqual({ projectId: "project_a", agentId: WORKFLOW_ARCHITECT_ID });
    const selection = await fake.bb.storage.kv.get<{ agentsJson: string | null }>(`native-selection:${prepared.token}`);
    const definition = (JSON.parse(selection!.agentsJson!) as Record<string, { description: string; prompt: string; tools: string[] }>)[WORKFLOW_ARCHITECT_ID]!;
    expect(definition.prompt).toContain("Workflow architect session");
    expect(definition.tools).toContain("mcp__bb-bridge__lane_pilot_workflow_draft_create");
    expect(definition.tools).not.toContain("mcp__bb-bridge__lane_pilot_dispatch_writer");
  });

  it("gets the chain tools bound in a native chat, like the PM", async () => {
    const fake = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(fake.bb);
    await plugin(fake.bb);
    cleanup.push(() => fake.harness.lifecycle.dispose());
    createRun(db, "lprun_arch", "project-test", "cli");
    setRunThread(db, "lprun_arch", "thread-test");
    finalizeNativeLaneBinding({ db, runId: "lprun_arch", hostId: "host-test", workspacePath: "/checkout", environmentId: "environment-test" });
    const configured = await fake.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      origin: { kind: null, pluginId: "user" }, pluginMetadata: { role: "pm", lanePilotRunId: "lprun_arch" }, environment: { id: "environment-test", path: "/checkout" },
    }));
    const names = configured.tools.map((tool) => tool.name);
    for (const tool of NATIVE_LP_BRIDGE_ARCHITECT_TOOLS) expect(names, tool).toContain(foldedToolHome(tool)?.tool ?? tool);
  });
});
