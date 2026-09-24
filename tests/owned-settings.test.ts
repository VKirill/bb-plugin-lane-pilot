import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { resolveSelectedMainAgentProfile, compileMainAgentProfile } from "../src/agent-profile";
import { LP_AGENT_OVERRIDES_KEY, LP_DEFAULTS_KEY, parseLanePilotDefaults, inheritProjectValues } from "../src/lp-defaults";

describe("owned settings persistence and optimistic concurrency", () => {
  it("atomically saves defaults with one CAS winner and retains explicit project choices", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    try {
      const before: any = await harness.behavior.callRpc("get_globals", {});
      expect(before.revision).toBe(0);
      const results: any[] = await Promise.all([
        harness.behavior.callRpc("save_globals", { defaults: { helperPlacement: "project_tree" }, expectedRevision: 0 }),
        harness.behavior.callRpc("save_globals", { defaults: { helperPlacement: "plugin" }, expectedRevision: 0 }),
      ]);
      expect(results.map((item) => item.ok)).toEqual([true, false]);
      const readback: any = await harness.behavior.callRpc("get_globals", {});
      expect(readback).toMatchObject({ revision: 1, defaults: { helperPlacement: "project_tree" } });
      const persisted = await bb.storage.kv.get(LP_DEFAULTS_KEY);
      expect(persisted).toMatchObject({ revision: 1, helperPlacement: "project_tree" });
      expect(inheritProjectValues({}, parseLanePilotDefaults(persisted)).values["helper.placement"]).toBe("project_tree");
      expect(inheritProjectValues({ "helper.placement": "plugin" }, readback.defaults).values["helper.placement"]).toBe("plugin");
    } finally { await harness.lifecycle.dispose(); }
  });

  it("saves a custom independent compiled profile and rejects stale/invalid edits before writing", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    try {
      const seeded = compileMainAgentProfile("copy-lead", { skills: ["copywriter"], mcpServers: ["search"], tools: ["Read"], disallowedTools: ["Bash"] });
      await bb.storage.kv.set(LP_AGENT_OVERRIDES_KEY, { "copy-lead": { compiled: seeded } });
      const editedResources: any = await harness.behavior.callRpc("save_agent_profile", { id: "copy-lead", prompt: "New instruction text", expectedSourceHash: seeded.sourceHash });
      const kept: any = await bb.storage.kv.get(LP_AGENT_OVERRIDES_KEY);
      expect(kept["copy-lead"].compiled).toMatchObject({ skills: ["copywriter"], mcpServers: ["search"], tools: ["Read"], disallowedTools: ["Bash"] });
      expect(editedResources.sourceHash).not.toBe(seeded.sourceHash);
      const before: any = await harness.behavior.callRpc("get_globals", {});
      expect(before.agents.map((item: any) => item.id)).toEqual(["dev-orchestrator", "copy-lead", "seo-specialist", "design-lead", "project-onboarder", "tavily"]);
      const prototypeNamed: any = await harness.behavior.callRpc("save_agent_profile", { id: "constructor", prompt: "Treat as user profile.", description: "Constructor copy profile", expectedSourceHash: "" });
      expect(prototypeNamed.ok).toBe(true);
      const saved: any = await harness.behavior.callRpc("save_agent_profile", { id: "my-editor", prompt: "Write the agreed headline.", description: "My editor", expectedSourceHash: "" });
      expect(saved.ok).toBe(true);
      const owned: any = await bb.storage.kv.get(LP_AGENT_OVERRIDES_KEY);
      const compiled = resolveSelectedMainAgentProfile({ "main.agent": "my-editor" }, owned)!;
      expect(compiled.prompt).toBe("Write the agreed headline.");
      expect(compiled.sourceHash).toBe(saved.sourceHash);
      expect(compiled).not.toHaveProperty("model");
      expect(compiled).not.toHaveProperty("permissionMode");
      const conflict: any = await harness.behavior.callRpc("save_agent_profile", { id: "my-editor", prompt: "Stale content", description: "My editor", expectedSourceHash: "" });
      expect(conflict.ok).toBe(false);
      await expect(harness.behavior.callRpc("save_agent_profile", { id: "../escape", prompt: "Bad", description: "Bad", expectedSourceHash: "" })).rejects.toThrow();
      expect(await bb.storage.kv.get(LP_AGENT_OVERRIDES_KEY)).toEqual(owned);
      const readback: any = await harness.behavior.callRpc("get_globals", {});
      expect(readback.agents.find((item: any) => item.id === "my-editor")).toMatchObject({ prompt: compiled.prompt, sourceHash: saved.sourceHash });
      const edited = compileMainAgentProfile("copy-lead", { prompt: "Pinned text", description: "Pinned" });
      expect(resolveSelectedMainAgentProfile({ "main.agent": "copy-lead" }, { "copy-lead": { compiled: edited } })).toEqual(edited);
    } finally { await harness.lifecycle.dispose(); }
  });
});
