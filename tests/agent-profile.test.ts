import { describe, expect, it } from "vitest";
import {
  compileMainAgentProfile,
  compiledMainAgentSpawnBinding,
  compiledMainAgentSpawnField,
  detectCompiledMainAgentCapability,
  resolveSelectedMainAgentProfile,
} from "../src/agent-profile";

describe("Lane Pilot owned main-agent profiles", () => {
  it("compiles the first three profiles with a stable source hash and no model/permissionMode", () => {
    for (const id of ["dev-orchestrator", "copy-lead", "seo-specialist"] as const) {
      const first = compileMainAgentProfile(id);
      const second = compileMainAgentProfile(id);
      expect(first.id).toBe(id);
      expect(first.sourceHash).toBe(second.sourceHash);
      expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first).not.toHaveProperty("model");
      expect(first).not.toHaveProperty("permissionMode");
      expect(compiledMainAgentSpawnField(first).experimental_vkCompiledMainAgent.sourceHash)
        .toBe(first.sourceHash);
    }
  });

  it("pins an edited prompt as a new LP-owned hash and refuses unknown ids", () => {
    const stock = compileMainAgentProfile("copy-lead");
    const edited = compileMainAgentProfile("copy-lead", { prompt:"Write only the headline." });
    expect(edited.sourceHash).not.toBe(stock.sourceHash);
    expect(edited.prompt).toBe("Write only the headline.");
    expect(() => compileMainAgentProfile("lane-writer")).toThrow(/unsupported_main_agent_profile/);
  });

  it("does not send a compiled profile to a core that only has the old dynamic API", () => {
    expect(detectCompiledMainAgentCapability({})).toBe("none");
    expect(detectCompiledMainAgentCapability({
      experimental_vkCompiledMainAgent: () => ({ persist: true }),
    })).toBe("none");
    expect(resolveSelectedMainAgentProfile({})).toBeNull();
    expect(compiledMainAgentSpawnBinding({ capability: "none", profile: null })).toEqual({});
    expect(() => compiledMainAgentSpawnBinding({
      capability: "none",
      profile: compileMainAgentProfile("copy-lead"),
    })).toThrow(/compiled_main_agent_unsupported/);
    const supported = detectCompiledMainAgentCapability({
      experimental_vkCompiledMainAgent: () => ({
        persist: true,
        bridgeAgentOptions: true,
        requiredMarker: true,
        providerIds: ["claude-code"],
      }),
    });
    expect(supported).toBe("supported");
    const selected = resolveSelectedMainAgentProfile({ "main.agent": "seo-specialist" });
    expect(selected?.id).toBe("seo-specialist");
    expect(compiledMainAgentSpawnBinding({ capability: "supported", profile: selected }).experimental_vkCompiledMainAgent.id)
      .toBe("seo-specialist");
  });
});

it("rejects stored compiled instructions whose digest no longer matches", () => {
  const compiled = compileMainAgentProfile("copy-lead");
  expect(() => resolveSelectedMainAgentProfile({ "main.agent": "copy-lead" }, {
    "copy-lead": { compiled: { ...compiled, prompt: "Tampered body" } },
  })).toThrow(/digest/);
});


it("fails closed on schema-invalid saved payload even if a legacy prompt is present", () => {
  expect(() => resolveSelectedMainAgentProfile({ "main.agent": "copy-lead" }, {
    "copy-lead": { prompt: "Legacy fallback must not run", description: "Legacy", compiled: { id: "copy-lead", sourceVersion: "lp-owned-2", sourceHash: "invalid", description: "Bad", prompt: "Broken" } as never },
  })).toThrow();
});
