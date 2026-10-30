import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { agentListItem, parseAgentFile } from "../src/rooms/native-agent/custom-agent";
import { MAIN_AGENT_PROFILE_IDS, parseOwnedAgents } from "../src/rooms/native-agent/agent-profile";
import { BB_AGENT_SESSIONS, laneSessionOverlayPrompt, unionLpBridgeToolsOnAgentsJson } from "../src/rooms/native-agent/native-agent-overlay";
import { NATIVE_LP_BRIDGE_SPECIALIST_TOOLS } from "../src/rooms/native-agent/native-session-hooks";
import { roleProfilePolicy, type HelperRole } from "../src/rooms/native-agent/helper-context";
import { LP_AGENT_OVERRIDES_KEY } from "@lane-pilot/settings-catalog";
import { listSettingRows, openDatabase } from "../src/rooms/storage/database";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function host(sdk: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: sdk as never });
  await plugin(bb);
  cleanup.push(() => harness.lifecycle.dispose());
  const rpc = <T,>(name: string, input: Record<string, unknown> = {}) => harness.behavior.callRpc(name as never, input as never) as Promise<T>;
  return { bb, harness, rpc };
}

type Item = ReturnType<typeof agentListItem>;
const video = {
  id: "context-lead",
  displayName: "Context",
  description: "Keeps the project context in order.",
  prompt: "You are the context specialist. Chat in Russian, write files in English.",
  skills: ["lane-memory"],
  mcpServers: ["gitnexus"],
  model: "claude-opus-5-5",
  effort: "high",
};

describe("the agent registry: an agent is data", () => {
  it("lists the bundled agents with kind and custom, video-lead among them", async () => {
    const { rpc } = await host();
    const { agents } = await rpc<{ agents: Item[] }>("list_agents");
    expect(agents.map((row) => row.id)).toEqual([...MAIN_AGENT_PROFILE_IDS]);
    const byId = Object.fromEntries(agents.map((row) => [row.id, row]));
    expect(byId["dev-orchestrator"]).toMatchObject({ kind: "coordinator", custom: false, displayName: "Development coordinator" });
    expect(byId["project-onboarder"]).toMatchObject({ kind: "internal", custom: false });
    for (const id of ["copy-lead", "seo-specialist", "design-lead", "tavily", "video-lead"]) expect(byId[id], id).toMatchObject({ kind: "specialist", custom: false });
    expect(byId["video-lead"]!.skills).toEqual(["video-lead-playbook"]);
    expect(byId["game-dev"]!.skillSections).toContain("Разработка/Игры");
    expect(byId["video-lead"]!.tools).toContain("mcp__bb-bridge__lane_pilot_schedule");
    for (const row of agents) expect(row.description).toBe(row.displayName);
  });

  it("creates, shows, updates and deletes an agent of the owner; get_globals and the picker list carry it", async () => {
    const { bb, rpc } = await host();
    expect(await rpc("create_agent", video)).toMatchObject({ ok: true, id: "context-lead" });

    const { agents } = await rpc<{ agents: Item[] }>("list_agents", { custom: true });
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "context-lead", description: "Context", displayName: "Context", summary: "Keeps the project context in order.",
      kind: "specialist", custom: true, edited: true, skills: ["lane-memory"], mcpServers: ["gitnexus"], model: "claude-opus-5-5", effort: "high",
    });
    const globals = await rpc<{ agents: Item[] }>("get_globals");
    expect(globals.agents.map((row) => row.id)).toEqual([...MAIN_AGENT_PROFILE_IDS, "context-lead"]);

    // The same store as the edits of a bundled profile; the compiled profile has no model field.
    const owned = parseOwnedAgents(await bb.storage.kv.get(LP_AGENT_OVERRIDES_KEY));
    expect(owned["context-lead"]!.compiled).toMatchObject({ id: "context-lead", description: "Context", skills: ["lane-memory"] });
    expect(owned["context-lead"]!.compiled).not.toHaveProperty("model");
    expect(owned["context-lead"]!.meta).toMatchObject({ displayName: "Context", model: "claude-opus-5-5", effort: "high" });

    expect(await rpc("update_agent", { id: "context-lead", prompt: "A new prompt.", skills: ["lane-memory", "ru-text"], model: null })).toMatchObject({ ok: true });
    const [changed] = (await rpc<{ agents: Item[] }>("list_agents", { custom: true })).agents;
    expect(changed).toMatchObject({ prompt: "A new prompt.", skills: ["lane-memory", "ru-text"], mcpServers: ["gitnexus"], displayName: "Context", effort: "high" });
    expect(changed).not.toHaveProperty("model");
    expect(changed!.sourceHash).not.toBe(agents[0]!.sourceHash);

    expect(await rpc("delete_agent", { id: "context-lead" })).toMatchObject({ ok: true });
    expect((await rpc<{ agents: Item[] }>("list_agents", { custom: true })).agents).toEqual([]);
    expect(await rpc("delete_agent", { id: "context-lead" })).toMatchObject({ ok: false, error: "agent_not_found" });
  });

  it("refuses a bundled or reserved id, a duplicate, and the deletion or update of a bundled agent", async () => {
    const { rpc } = await host();
    for (const id of ["copy-lead", "video-lead", "dev-orchestrator", "workflow-architect", "frontend-orchestrator", "browser-qa", "default"]) {
      expect(await rpc("create_agent", { ...video, id }), id).toMatchObject({ ok: false, error: "agent_id_reserved" });
    }
    expect(await rpc("create_agent", video)).toMatchObject({ ok: true });
    expect(await rpc("create_agent", video)).toMatchObject({ ok: false, error: "agent_exists" });
    expect(await rpc("delete_agent", { id: "copy-lead" })).toMatchObject({ ok: false, error: "agent_not_custom" });
    expect(await rpc("update_agent", { id: "copy-lead", prompt: "x" })).toMatchObject({ ok: false, error: "agent_not_custom" });
    expect(await rpc("update_agent", { id: "nobody", prompt: "x" })).toMatchObject({ ok: false, error: "agent_not_found" });
    // save_agent_profile keeps working for a bundled agent and refuses a reserved name.
    const stock = (await rpc<{ agents: Item[] }>("list_agents")).agents.find((row) => row.id === "copy-lead")!;
    expect(await rpc("save_agent_profile", { id: "copy-lead", prompt: "Write only headlines.", expectedSourceHash: stock.sourceHash })).toMatchObject({ ok: true });
    expect(await rpc("save_agent_profile", { id: "browser-qa", prompt: "x", description: "x", expectedSourceHash: "" })).toMatchObject({ ok: false });
  });

  it("keeps the label, summary and model of an agent when its profile is saved from the settings editor", async () => {
    const { rpc } = await host();
    await rpc("create_agent", video);
    const before = (await rpc<{ agents: Item[] }>("list_agents", { custom: true })).agents[0]!;
    const saved = await rpc<{ ok: boolean }>("save_agent_profile", { id: "context-lead", prompt: "Edited in the editor.", description: "Context desk", expectedSourceHash: before.sourceHash, resourceModes: { skills: "selected", mcpServers: "selected" }, skills: ["lane-memory"], mcpServers: ["gitnexus"] });
    expect(saved.ok).toBe(true);
    const after = (await rpc<{ agents: Item[] }>("list_agents", { custom: true })).agents[0]!;
    expect(after).toMatchObject({ displayName: "Context desk", summary: "Keeps the project context in order.", model: "claude-opus-5-5", prompt: "Edited in the editor." });
  });

  it("a profile made with the settings editor alone (no registry call) is an agent of the owner too", async () => {
    const { rpc } = await host();
    expect(await rpc("save_agent_profile", { id: "my-agent", prompt: "Do the thing.", description: "Mine", expectedSourceHash: "" })).toMatchObject({ ok: true });
    const mine = (await rpc<{ agents: Item[] }>("list_agents", { custom: true })).agents[0]!;
    expect(mine).toMatchObject({ id: "my-agent", custom: true, kind: "specialist", displayName: "Mine" });
    expect(await rpc("delete_agent", { id: "my-agent" })).toMatchObject({ ok: true });
  });

  it("starts a chat with the agent through the same path as a bundled one: its prompt, skills, MCP servers, model, and the schedule tool", async () => {
    const { rpc, bb } = await host();
    await rpc("create_agent", { ...video, tools: ["Read", "Write"] });
    const started = await rpc<{ token: string; agentId: string; label: string; profileMode: string }>("prepare_native_session", { projectId: "proj_custom", agentId: "context-lead" });
    expect(started).toMatchObject({ agentId: "context-lead", label: "Context", profileMode: "session-override" });
    const record = await bb.storage.kv.get<{ agentsJson: string }>(`native-selection:${started.token}`);
    const definition = (JSON.parse(record!.agentsJson) as Record<string, Record<string, unknown>>)["context-lead"]!;
    expect(definition).toMatchObject({ description: "Context", prompt: video.prompt, skills: ["lane-memory"], mcpServers: ["gitnexus"], model: "claude-opus-5-5", effort: "high" });
    // What the launcher writes into `--agents`: the owner's tools plus the schedule (and the loader that defers it).
    const launched = unionLpBridgeToolsOnAgentsJson("context-lead", record!.agentsJson)["context-lead"] as { tools: string[] };
    expect(launched.tools).toEqual(["Read", "Write", "mcp__bb-bridge__lane_pilot_schedule", "ToolSearch"]);

    // The bundled video agent starts the same way.
    const bundled = await rpc<{ token: string }>("prepare_native_session", { projectId: "proj_custom", agentId: "video-lead" });
    const bundledDefinition = (JSON.parse((await bb.storage.kv.get<{ agentsJson: string }>(`native-selection:${bundled.token}`))!.agentsJson) as Record<string, Record<string, unknown>>)["video-lead"]!;
    expect(bundledDefinition.skills).toEqual(["video-lead-playbook"]);
    expect(bundledDefinition.prompt).toBe(laneSessionOverlayPrompt("video-lead"));
    expect(bundledDefinition.prompt).toContain("## Skill catalog");
  });

  it("gives an agent of the owner a specialist helper role: Env Catalog plus its own skills and MCP servers", () => {
    const policy = roleProfilePolicy("specialist:context-lead" as HelperRole, {}, { skills: ["lane-memory"], mcpServers: ["gitnexus"] });
    expect(policy.skills).toMatchObject({ mode: "allow", names: expect.arrayContaining(["env-catalog", "lane-memory"]) });
    expect(policy.mcpServers).toMatchObject({ names: expect.arrayContaining(["gitnexus"]) });
  });
});

describe("deleting an agent that is in use", () => {
  const schedule = (agentId: string) => ({ projectId: "proj_custom", name: "Context desk", task: { kind: "agent", agentId, task: "Keep the project context in order and report what changed." }, when: { type: "cron", cron: "0 9 * * 1", timezone: "UTC" } });

  it("sets a project's main agent back to the default when the agent is deleted, and leaves the other projects alone", async () => {
    const { rpc, bb } = await host();
    const db = openDatabase(bb);
    await rpc("create_agent", video);
    await rpc("create_agent", { ...video, id: "other-lead" });
    for (const [projectId, value] of [["proj_custom", "context-lead"], ["proj_other", "other-lead"]] as const) {
      expect(await rpc("save_setting", { projectId, key: "main.agent", value, expectedVersion: 0 })).toMatchObject({ ok: true });
    }
    expect(await rpc("delete_agent", { id: "context-lead" })).toMatchObject({ ok: true });
    const read = (projectId: string) => listSettingRows(db, projectId).find((row) => row.key === "main.agent")?.value;
    expect(read("proj_custom")).toBeUndefined();
    expect(read("proj_other")).toBe("other-lead");
  });

  it("refuses to delete an agent an active schedule runs, naming the schedule, and deletes it once the schedule is paused", async () => {
    const { rpc } = await host({ hosts: { list: async () => [] } });
    await rpc("create_agent", video);
    const made = await rpc<{ ok: boolean; schedule: { id: string } | null; problems: string[] }>("schedule_upsert", { definition: schedule("context-lead") });
    expect(made.problems).toEqual([]);
    const refused = await rpc<{ ok: boolean; error?: string; detail?: string }>("delete_agent", { id: "context-lead" });
    expect(refused).toMatchObject({ ok: false, error: "agent_in_use", detail: expect.stringContaining(`«Context desk» (${made.schedule!.id})`) });
    expect((await rpc<{ agents: Item[] }>("list_agents", { custom: true })).agents.map((row) => row.id)).toEqual(["context-lead"]);
    await rpc("schedule_pause", { id: made.schedule!.id });
    expect(await rpc("delete_agent", { id: "context-lead" })).toMatchObject({ ok: true });
  });
});

describe("agents from a file and from the CLI", () => {
  it("reads JSON and markdown with frontmatter (lists, comma lines, name as id)", () => {
    expect(parseAgentFile('{"id":"a-b","displayName":"A","prompt":"P"}')).toEqual({ id: "a-b", displayName: "A", prompt: "P" });
    const md = ["---", "name: context-lead", "displayName: Context", "description: Keeps context.", "skills:", "  - lane-memory", "  - ru-text", "mcpServers: gitnexus, metamcp", "model: claude-opus-5-5", "effort: high", "---", "", "You are the context specialist.", ""].join("\n");
    expect(parseAgentFile(md)).toEqual({
      id: "context-lead", displayName: "Context", description: "Keeps context.", skills: ["lane-memory", "ru-text"], coreSkills: ["lane-memory", "ru-text"], mcpServers: ["gitnexus", "metamcp"],
      model: "claude-opus-5-5", effort: "high", prompt: "You are the context specialist.",
    });
    expect(() => parseAgentFile("   ")).toThrow(/agent_file_empty/);
  });

  it("bb lane-pilot agents list|show|create|update|delete", async () => {
    const { harness } = await host();
    const run = async (...argv: string[]) => harness.behavior.runCli(["agents", ...argv]) as Promise<{ exitCode: number; stdout: string }>;
    const md = ["---", "id: video-helper", "displayName: Video helper", "skills: hyperframes", "---", "You help with video. Chat in Russian."].join("\n");

    const created = await run("create", md);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, state: "created", id: "video-helper", agent: { kind: "specialist", custom: true } });

    const json = JSON.parse((await run("list", "--custom", "--json")).stdout) as { agents: Item[] };
    expect(json.agents.map((row) => row.id)).toEqual(["video-helper"]);
    expect((await run("list")).stdout).toMatch(/copy-lead\s+specialist\s+bundled/);
    expect((await run("list")).stdout).toMatch(/video-helper\s+specialist\s+custom\s+\S+\s+\S+\s+Video helper/);
    expect(JSON.parse((await run("show", "video-helper")).stdout)).toMatchObject({ id: "video-helper", prompt: "You help with video. Chat in Russian.", skills: ["hyperframes"] });

    const updated = await run("update", "video-helper", JSON.stringify({ displayName: "Video desk", effort: "max" }));
    expect(JSON.parse(updated.stdout)).toMatchObject({ ok: true, state: "updated" });
    expect(JSON.parse((await run("show", "video-helper")).stdout)).toMatchObject({ displayName: "Video desk", effort: "max", skills: ["hyperframes"] });
    expect((await run("update", "video-helper", JSON.stringify({ id: "other", prompt: "x" }))).exitCode).toBe(1);

    expect((await run("create", md)).exitCode).toBe(1);
    expect(JSON.parse((await run("create", JSON.stringify({ id: "copy-lead", displayName: "x", prompt: "x" }))).stdout)).toMatchObject({ ok: false, error: "agent_id_reserved" });
    expect(JSON.parse((await run("delete", "copy-lead")).stdout)).toMatchObject({ ok: false, error: "agent_not_custom" });
    expect(JSON.parse((await run("delete", "video-helper")).stdout)).toMatchObject({ ok: true, state: "deleted" });
    expect(JSON.parse((await run("show", "video-helper")).stdout)).toMatchObject({ ok: false, error: "agent_not_found" });
  });
});

describe("every specialist can plan an automation", () => {
  it("names the schedule tool in its session text, and the specialist list has the tool", () => {
    for (const id of ["copy-lead", "seo-specialist", "design-lead", "tavily", "video-lead", "advisor-researcher", "ai-researcher", "animator", "doc-classifier", "domain-researcher", "eval-auditor", "eval-planner", "framework-selector", "mempalace-curator", "nyquist-auditor", "ui-researcher"]) {
      expect(BB_AGENT_SESSIONS[id], id).toContain("lane_pilot_schedule");
      expect(BB_AGENT_SESSIONS[id], id).toContain("cannot create schedules");
    }
    for (const id of ["project-onboarder", "browser-qa"]) expect(BB_AGENT_SESSIONS[id], id).not.toContain("lane_pilot_schedule");
    expect([...NATIVE_LP_BRIDGE_SPECIALIST_TOOLS]).toEqual(["lane_pilot_schedule"]);
  });
});
