import { describe, expect, it } from "vitest";
import {
  compileEffectiveMainAgent,
  compileMainAgentProfile,
  LEGACY_STOCK_TEMPLATES,
  MAIN_AGENT_PROFILE_IDS,
  PROFILE_SOURCE_VERSION,
} from "../src/agent-profile";
import bundledAgents from "../src/bundled-agents.json";

describe("bundled BB session profiles", () => {
  it("loads all seven profiles under schema limits with resources and no model fields", () => {
    for (const id of MAIN_AGENT_PROFILE_IDS) {
      const bundled = (bundledAgents as unknown as Record<string, { displayName: string; skills: string[]; mcpServers: string[] } | undefined>)[id] ?? { displayName: "Workflow architect", skills: [], mcpServers: [] };
      const compiled = compileMainAgentProfile(id);
      expect(compiled.sourceVersion).toBe(PROFILE_SOURCE_VERSION);
      expect(compiled.description).toBe(bundled.displayName);
      expect(compiled.description.length).toBeLessThanOrEqual(400);
      expect(compiled.prompt.length).toBeLessThanOrEqual(32_000);
      expect(compiled.prompt).toContain("Lane Pilot");
      expect(compiled.prompt).not.toContain("lane-stack` 1.60.0");
      expect(compiled.prompt).not.toContain("Imported from Claude Lane");
      expect(compiled).not.toHaveProperty("model");
      expect(compiled).not.toHaveProperty("permissionMode");
      expect(compiled).not.toHaveProperty("effort");
      if (bundled.skills.length) expect(compiled.skills).toEqual(bundled.skills);
      if (bundled.mcpServers.length) expect(compiled.mcpServers).toEqual(bundled.mcpServers);
    }
    const copy = compileMainAgentProfile("copy-lead");
    expect(copy.prompt).toContain("docs/audiences/copy.md");
    expect(copy.prompt).not.toContain("Boot **copy-lead**");
    const orchestrator = compileMainAgentProfile("dev-orchestrator");
    expect(JSON.stringify(orchestrator.tools ?? [])).not.toMatch(/run-supervisor|project-onboarder|SendMessage/);
    expect(orchestrator.prompt).toContain("lane_pilot_dispatch_writer");
    expect(orchestrator.prompt).not.toContain("Boot solo dev-orchestrator");
    expect(compileMainAgentProfile("seo-specialist").mcpServers).toHaveLength(9);
  });

  it("upgrades unchanged stubs and CLI dumps and keeps edited compiled snapshots plus resource overlays", () => {
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
    expect(upgraded.prompt).toContain("docs/audiences/copy.md");
    expect(upgraded.prompt).not.toContain("Boot **copy-lead**");
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
    expect(overlay.prompt).toContain("docs/audiences/copy.md");
    const frozen = compileMainAgentProfile("copy-lead", { prompt: "Night desk only.", description: "Night desk" });
    const kept = compileEffectiveMainAgent("copy-lead", { prompt: "Night desk only.", description: "Night desk", compiled: frozen });
    expect(kept.sourceHash).toBe(frozen.sourceHash);
    expect(kept.prompt).toBe("Night desk only.");
    const cliDump = compileEffectiveMainAgent("dev-orchestrator", {
      prompt: "Dispatch run-controller then project-onboarder for docs/llm. lane-ctl accept.",
    });
    expect(cliDump.prompt).toContain("lane_pilot_dispatch_writer");
    expect(cliDump.prompt).not.toContain("docs/llm");
  });
});
