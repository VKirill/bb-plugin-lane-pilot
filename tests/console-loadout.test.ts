import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledAgents, roleAccessKey, rpcContract, type AgentLoadoutOutput, type LoadoutRole } from "../src/rooms/contracts";
import { LP_AGENT_OVERRIDES_KEY } from "@lane-pilot/settings-catalog";
import { roleModelKey } from "@lane-pilot/models";
import { createCore } from "../src/rooms/core/server/core";
import { compileMainAgentProfile } from "../src/rooms/native-agent";
import { STANDALONE_SPECIALIST_SKILL_PACKS } from "../src/rooms/native-agent/server";
import { openDatabase, saveProjectSetting, sectionBindingId } from "../src/rooms/plugin-db";
import { agentLoadout, loadoutRpc, room as settingsRoom } from "../src/rooms/settings/server";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function findRole(out: AgentLoadoutOutput, role: string): LoadoutRole {
  const found = out.roles.find((entry) => entry.role === role);
  if (!found) throw new Error(`missing role ${role}`);
  return found;
}

function itemsOf(role: LoadoutRole, type: LoadoutRole["items"][number]["type"]) {
  return role.items.filter((item) => item.type === type);
}

describe("agentLoadout & agent_loadout RPC", () => {
  it("matches docs/agent-loadout.md tables under default settings, resolves Drift #3, and detects missing skills/plugins/MCP", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: (async (call: { method: string }) => {
        if (call.method === "session_inventory") {
          return { mcpServers: [{ name: "gitnexus", sources: ["claude"] }], nativePlugins: [] };
        }
        throw new Error(`unexpected host rpc ${call.method}`);
      }) as never,
      sdk: {
        plugins: {
          list: async () => [
            { id: "environment-project-checkout", name: "Checkout", enabled: true },
            { id: "project-folders", name: "Project Folders", enabled: true },
            { id: "env-catalog", name: "Env Catalog", enabled: true },
            { id: "browser-automation", name: "Browser Automation", enabled: false },
          ],
        },
        skills: {
          list: async () => ({
            skills: [
              { name: "karpathy-guidelines", description: "Coding discipline" },
              { name: "env-catalog", description: "Env Catalog" },
              { name: "seo-drmax-orchestrator", description: "SEO X4" },
              { name: "seo-tools", description: "SEO tools" },
              { name: "project-life", description: "Project life" },
            ],
          }),
        },
        hosts: {
          list: async () => [{ id: "mac-mini", name: "Mac mini", status: "connected" }],
        },
        projects: {
          list: async () => [{ id: "p1", name: "Alpha", kind: "standard" }],
          get: async ({ projectId }) => ({ id: projectId, name: projectId, sources: [] }),
        },
      },
    });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);

    // Verify contract + room registration wiring.
    expect("agent_loadout" in rpcContract).toBe(true);
    const roomHandlers = settingsRoom.rpc!(ctx, {} as never);
    expect(typeof roomHandlers.agent_loadout).toBe("function");

    const out = await loadoutRpc(ctx).agent_loadout({});
    expect(out.hubSkills).toBe(5);

    // Writer: lp-writer (absent on hub -> missing: true), karpathy-guidelines (present -> missing: false), gitnexus (in inventory -> missing: false).
    const writer = findRole(out, "writer");
    expect(writer.kind).toBe("pipeline");
    expect(writer.contextMode).toBe("roles");
    expect(writer.model).toEqual({ provider: "codex", model: "gpt-6-luna", from: "builtin" });
    expect(itemsOf(writer, "skill")).toEqual([
      { type: "skill", name: "lp-writer", from: "profile", missing: true },
      { type: "skill", name: "karpathy-guidelines", from: "profile", missing: false },
    ]);
    expect(itemsOf(writer, "plugin")).toEqual([
      { type: "plugin", name: "environment-project-checkout", from: "required", missing: false },
      { type: "plugin", name: "project-folders", from: "required", missing: false },
    ]);
    expect(itemsOf(writer, "mcp")).toEqual([
      { type: "mcp", name: "gitnexus", from: "profile", missing: false },
      { type: "mcp", name: "bb-bridge", from: "required", missing: false },
    ]);
    expect(itemsOf(writer, "instructions")).toEqual([
      { type: "instructions", name: "projectInstructions", from: "profile", missing: false },
    ]);

    // Prompt-only role (plan-critic): no projectInstructions, Gemini Flash default.
    const planCritic = findRole(out, "plan-critic");
    expect(planCritic.model).toEqual({ provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high", from: "builtin" });
    expect(itemsOf(planCritic, "instructions")).toEqual([]);
    expect(itemsOf(planCritic, "mcp")).toEqual([
      { type: "mcp", name: "bb-bridge", from: "required", missing: false },
    ]);

    // browser-qa: disabled plugin flagged missing, pinned to mac-mini.
    const browserQa = findRole(out, "browser-qa");
    expect(browserQa.machine).toBe("mac-mini");
    expect(itemsOf(browserQa, "plugin")).toEqual([
      { type: "plugin", name: "browser-automation", from: "profile", missing: true },
      { type: "plugin", name: "environment-project-checkout", from: "required", missing: false },
      { type: "plugin", name: "project-folders", from: "required", missing: false },
    ]);

    // seo-specialist: Drift #3 (8 bundled MCPs stripped, only bb-bridge remains); domain_pack tagged; note set.
    const seo = findRole(out, "seo-specialist");
    expect(seo.kind).toBe("specialist");
    expect(seo.machine).toBeNull();
    expect(seo.note).toBe("в шаге графа пакета нет");
    expect(itemsOf(seo, "mcp")).toEqual([
      { type: "mcp", name: "bb-bridge", from: "required", missing: false },
    ]);
    expect(itemsOf(seo, "plugin")).toEqual([
      { type: "plugin", name: "env-catalog", from: "profile", missing: false },
      { type: "plugin", name: "environment-project-checkout", from: "required", missing: false },
      { type: "plugin", name: "project-folders", from: "required", missing: false },
    ]);
    const seoSkills = itemsOf(seo, "skill");
    expect(seoSkills.filter((s) => s.from === "profile").map((s) => s.name)).toEqual(["env-catalog", "seo-drmax-orchestrator"]);
    const seoPack = seoSkills.filter((s) => s.from === "domain_pack");
    expect(seoPack.length).toBe(STANDALONE_SPECIALIST_SKILL_PACKS["seo-specialist"]!.length - 1);
    expect(seoPack.find((s) => s.name === "seo-tools")).toEqual({
      type: "skill",
      name: "seo-tools",
      from: "domain_pack",
      missing: false,
    });
    expect(seoPack.find((s) => s.name === "yandex")).toEqual({
      type: "skill",
      name: "yandex",
      from: "domain_pack",
      missing: true,
    });
    expect(itemsOf(seo, "tool")).toEqual([
      { type: "tool", name: "lane_pilot_schedule", from: "employee", missing: false },
    ]);

    // 3d-artist: blender MCP absent from host inventory -> missing: true, mac-mini machine.
    const artist3d = findRole(out, "3d-artist");
    expect(artist3d.machine).toBe("mac-mini");
    expect(itemsOf(artist3d, "mcp")).toEqual([
      { type: "mcp", name: "blender", from: "profile", missing: true },
      { type: "mcp", name: "bb-bridge", from: "required", missing: false },
    ]);

    // PM: main skills list + un-narrowed note.
    const pm = findRole(out, "dev-orchestrator");
    expect(pm.kind).toBe("pm");
    expect(pm.note).toBe("плюс весь каталог BB");
    expect(itemsOf(pm, "skill").map((s) => s.name)).toEqual(
      (bundledAgents as Record<string, { skills: string[] }>)["dev-orchestrator"]!.skills,
    );
    expect(itemsOf(pm, "mcp")).toEqual([
      { type: "mcp", name: "bb-bridge", from: "required", missing: false },
      { type: "mcp", name: "gitnexus", from: "profile", missing: false },
      { type: "mcp", name: "metamcp", from: "profile", missing: true },
    ]);
    expect(db).toBeDefined();
  });

  it("applies owner allow overrides (tagged owner), section role_model overrides (from section), and custom agents", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        plugins: {
          list: async () => [],
          callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
            if (pluginId === "project-folders" && method === "sections_list") {
              return {
                sections: [
                  { id: "s1", projectId: "p1", parentId: null, name: "App", path: "/work/app", hostId: "h", kind: "folder" },
                  { id: "s2", projectId: "p1", parentId: "s1", name: "Sub", path: "/work/app/sub", hostId: "h", kind: "folder" },
                ],
              };
            }
            throw new Error(`unexpected rpc ${pluginId}.${method}`);
          },
        },
        skills: { list: async () => ({ skills: [{ name: "ru-text" }, { name: "seo-tools" }] }) },
      },
    });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    // Owner allow list on writer skills + mcpServers, and on seo-specialist skills.
    saveProjectSetting(db, "p1", roleAccessKey("writer"), {
      skills: { mode: "allow", names: ["ru-text"] },
      mcpServers: { mode: "allow", names: [] },
    });
    saveProjectSetting(db, "p1", roleAccessKey("specialist:seo-specialist"), {
      skills: { mode: "allow", names: ["seo-tools"] },
    });

    // Model overrides at system, project, section, and legacy stage levels.
    saveProjectSetting(db, "*", roleModelKey("auditor"), { model: "claude-opus-5-5" });
    saveProjectSetting(db, "p1", roleModelKey("planner"), { model: "gpt-6.1-sol" });
    db.prepare(
      `INSERT INTO lane_pilot_project_settings (project_id, binding_id, key, value, version, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run("p1", sectionBindingId("s1"), roleModelKey("planner"), JSON.stringify({ model: "claude-haiku-5-5" }), Date.now());
    saveProjectSetting(db, "p1", "plan_critique.provider", "claude-code");
    saveProjectSetting(db, "p1", "plan_critique.model", "claude-opus-5-5");

    // Custom agent in agents:v1.
    const compiled = compileMainAgentProfile("legal-reviewer", {
      description: "Legal reviewer",
      prompt: "Review contracts carefully.",
      skills: ["ru-text"],
    });
    await bb.storage.kv.set(LP_AGENT_OVERRIDES_KEY, {
      "legal-reviewer": {
        prompt: "Review contracts carefully.",
        description: "Legal reviewer",
        compiled,
        meta: { displayName: "Legal reviewer", domain: "legal", model: "claude-sonnet-5-5" },
      },
    });

    const ctx = createCore(bb, db);
    const out = await agentLoadout(ctx, { projectId: "p1", sectionId: "s2" });

    // Writer with owner allow list returns only those skills tagged "owner", and only mandatory bb-bridge for MCP.
    const writer = findRole(out, "writer");
    expect(itemsOf(writer, "skill")).toEqual([
      { type: "skill", name: "ru-text", from: "owner", missing: false },
    ]);
    expect(itemsOf(writer, "mcp")).toEqual([
      { type: "mcp", name: "bb-bridge", from: "required", missing: false },
    ]);
    // Host MCP inventory is unavailable (no connected hosts), and writer has no non-mandatory MCP left after allow:[].
    expect(writer.note).toBeNull();

    // Design lead has metamcp (non-mandatory) and no connected hosts -> missing: false and note says inventory unavailable.
    const designLead = findRole(out, "design-lead");
    expect(itemsOf(designLead, "mcp")).toEqual([
      { type: "mcp", name: "metamcp", from: "profile", missing: false },
      { type: "mcp", name: "bb-bridge", from: "required", missing: false },
    ]);
    expect(designLead.note).toContain("инвентарь MCP недоступен");

    // Employee with owner allow list returns only owner skill (no domain_pack).
    const seo = findRole(out, "seo-specialist");
    expect(itemsOf(seo, "skill")).toEqual([
      { type: "skill", name: "seo-tools", from: "owner", missing: false },
    ]);

    // Section override wins and reports from: "section".
    const planner = findRole(out, "planner");
    expect(planner.model).toEqual({ provider: "claude-code", model: "claude-haiku-5-5", from: "section" });

    // System, legacy, and custom models report their exact levels.
    expect(findRole(out, "auditor").model).toEqual({ provider: "claude-code", model: "claude-opus-5-5", from: "system" });
    expect(findRole(out, "plan-critic").model).toEqual({ provider: "claude-code", model: "claude-opus-5-5", from: "legacy" });

    const custom = findRole(out, "legal-reviewer");
    expect(custom.kind).toBe("custom");
    expect(custom.model).toEqual({ provider: "claude-code", model: "claude-sonnet-5-5", from: "system" });
    expect(itemsOf(custom, "skill").some((s) => s.name === "ru-text" && s.from === "owner")).toBe(true);

    // Project-level call without section sees project override for planner.
    const projOnly = await agentLoadout(ctx, { projectId: "p1", role: "planner" });
    expect(projOnly.roles).toHaveLength(1);
    expect(projOnly.roles[0]!.model).toEqual({ provider: "codex", model: "gpt-6.1-sol", from: "project" });
  });

  it("handles hub skill list failure gracefully (hubSkills: -1, missing: false, warn log) and unknown role", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        plugins: { list: async () => [] },
        skills: {
          list: async () => {
            throw new Error("hub offline");
          },
        },
      },
    });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    const warnSpy = vi.spyOn(bb.log, "warn");

    const out = await agentLoadout(ctx, { role: "writer" });
    expect(out.hubSkills).toBe(-1);
    expect(out.roles).toHaveLength(1);
    for (const skill of itemsOf(out.roles[0]!, "skill")) {
      expect(skill.missing).toBe(false);
    }
    expect(warnSpy).toHaveBeenCalledWith("[loadout] hub skills unavailable: hub offline");

    const unknown = await agentLoadout(ctx, { role: "does-not-exist" });
    expect(unknown.roles).toEqual([]);
    expect(unknown.hubSkills).toBe(-1);

    const pmFiltered = await agentLoadout(ctx, { role: "pm" });
    expect(pmFiltered.roles).toHaveLength(1);
    expect(pmFiltered.roles[0]!.kind).toBe("pm");
  });
});
