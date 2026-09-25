import { describe, expect, it } from "vitest";
import {
  compileEffectiveMainAgent,
  compileMainAgentProfile,
  LEGACY_STOCK_TEMPLATES,
  MAIN_AGENT_PROFILE_IDS,
  PROFILE_SOURCE_VERSION,
} from "../src/agent-profile";
import bundledAgents from "../src/bundled-agents.json";

describe("bundled Claude Lane 1.60.0 profiles", () => {
  it("loads all six profiles under schema limits with resources and no model fields", () => {
    for (const id of MAIN_AGENT_PROFILE_IDS) {
      const bundled = bundledAgents[id];
      const compiled = compileMainAgentProfile(id);
      expect(compiled.sourceVersion).toBe(PROFILE_SOURCE_VERSION);
      expect(compiled.description).toBe(bundled.displayName);
      expect(compiled.description.length).toBeLessThanOrEqual(400);
      expect(compiled.prompt.length).toBeLessThanOrEqual(32_000);
      expect(compiled.prompt).toContain("## Instructions");
      expect(compiled.prompt).toContain("lane-stack` 1.60.0");
      expect(compiled.prompt).toContain(bundled.provenance.sha256);
      expect(compiled).not.toHaveProperty("model");
      expect(compiled).not.toHaveProperty("permissionMode");
      expect(compiled).not.toHaveProperty("effort");
      if (bundled.tools.length) expect(compiled.tools).toEqual(bundled.tools);
      if (bundled.skills.length) expect(compiled.skills).toEqual(bundled.skills);
      if (bundled.mcpServers.length) expect(compiled.mcpServers).toEqual(bundled.mcpServers);
    }
    const copy = compileMainAgentProfile("copy-lead");
    expect(copy.tools?.[0]).toBe("Agent(Explore, Plan, general-purpose)");
    expect(copy.skills).toHaveLength(10);
    expect(copy.prompt).toContain("## Startup instructions");
    expect(copy.prompt).toContain("Boot **copy-lead**");
    const orchestrator = compileMainAgentProfile("dev-orchestrator");
    expect(orchestrator.tools?.[0]?.startsWith("Agent(lane-stack:run-supervisor")).toBe(true);
    expect(orchestrator.tools?.[0]).toContain("Explore, Plan, general-purpose)");
    expect(orchestrator.prompt).toContain("Boot solo dev-orchestrator");
    expect(compileMainAgentProfile("seo-specialist").mcpServers).toHaveLength(9);
  });

  it("upgrades unchanged stubs and keeps edited compiled snapshots plus resource overlays", () => {
    const stub = {
      description: LEGACY_STOCK_TEMPLATES["copy-lead"].description,
      prompt: LEGACY_STOCK_TEMPLATES["copy-lead"].prompt,
      compiled: {
        id: "copy-lead",
        sourceVersion: "lp-owned-2",
        description: LEGACY_STOCK_TEMPLATES["copy-lead"].description,
        prompt: LEGACY_STOCK_TEMPLATES["copy-lead"].prompt,
        sourceHash: "a".repeat(64),
      },
    };
    const upgraded = compileEffectiveMainAgent("copy-lead", stub as never);
    expect(upgraded.prompt).toContain("Boot **copy-lead**");
    expect(upgraded.skills).toHaveLength(10);
    const overlay = compileEffectiveMainAgent("copy-lead", {
      description: LEGACY_STOCK_TEMPLATES["copy-lead"].description,
      prompt: LEGACY_STOCK_TEMPLATES["copy-lead"].prompt,
      compiled: {
        ...compileMainAgentProfile("copy-lead", {
          description: LEGACY_STOCK_TEMPLATES["copy-lead"].description,
          prompt: LEGACY_STOCK_TEMPLATES["copy-lead"].prompt,
          tools: ["Read"],
          skills: ["mine"],
        }),
      },
    });
    expect(overlay.tools).toEqual(["Read"]);
    expect(overlay.skills).toEqual(["mine"]);
    expect(overlay.prompt).toContain("Boot **copy-lead**");
    const frozen = compileMainAgentProfile("copy-lead", { prompt: "Night desk only.", description: "Night desk" });
    const kept = compileEffectiveMainAgent("copy-lead", { prompt: "Night desk only.", description: "Night desk", compiled: frozen });
    expect(kept.sourceHash).toBe(frozen.sourceHash);
    expect(kept.prompt).toBe("Night desk only.");
  });
});
