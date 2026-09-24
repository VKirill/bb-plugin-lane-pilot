import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compileMainAgentProfile,
  compiledMainAgentDigest,
  compiledMainAgentSpawnBinding,
  compiledMainAgentSpawnField,
  detectCompiledMainAgentCapability,
  parseOwnedAgents,
  resolveSelectedMainAgentProfile,
  validateCompiledMainAgent,
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
    expect(() => compileMainAgentProfile("lane-writer")).toThrow(/incomplete_main_agent_profile/);
    const custom = compileMainAgentProfile("lane-writer", { prompt: "Write the patch.", description: "Custom writer" });
    expect(custom.id).toBe("lane-writer");
    expect(custom).not.toHaveProperty("model");
  });

  it("uses a frozen compiled snapshot from agents:v1 before recompiling overrides", () => {
    const frozen = compileMainAgentProfile("copy-lead", { prompt: "Frozen prompt." });
    const resolved = resolveSelectedMainAgentProfile(
      { "main.agent": "copy-lead" },
      { "copy-lead": { prompt: "Newer prompt.", compiled: frozen } },
    );
    expect(resolved?.prompt).toBe("Frozen prompt.");
    expect(resolved?.sourceHash).toBe(frozen.sourceHash);
    expect(compileMainAgentProfile("tavily").id).toBe("tavily");
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
        snapshotDigest: true,
        providerIds: ["claude-code"],
      }),
    });
    expect(supported).toBe("supported");
    const selected = resolveSelectedMainAgentProfile({ "main.agent": "seo-specialist" });
    expect(selected?.id).toBe("seo-specialist");
    expect(compiledMainAgentSpawnBinding({ capability: "supported", profile: selected }).experimental_vkCompiledMainAgent.id)
      .toBe("seo-specialist");
  });

  it("uses lp-owned-1 insertion order and lp-owned-2 recursive key sort", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const v1 = {
      id: "copy-lead",
      sourceVersion: "lp-owned-1",
      description: "d",
      prompt: "p",
      tools: ["Read"],
    };
    expect(compiledMainAgentDigest(v1)).toBe(sha(JSON.stringify({
      id: "copy-lead", sourceVersion: "lp-owned-1", description: "d", prompt: "p", tools: ["Read"],
    })));
    const v2 = {
      id: "copy-lead",
      sourceVersion: "lp-owned-2",
      description: "d",
      prompt: "p",
      tools: ["Read"],
    };
    expect(compiledMainAgentDigest(v2)).toBe(sha(JSON.stringify({
      description: "d", id: "copy-lead", prompt: "p", sourceVersion: "lp-owned-2", tools: ["Read"],
    })));
    expect(validateCompiledMainAgent({ ...v2, sourceHash: compiledMainAgentDigest(v2) }).id).toBe("copy-lead");
  });

  it("does not compile a seed when the selected compiled payload fails schema", () => {
    const owned = parseOwnedAgents({
      "copy-lead": {
        prompt: "Edited prompt that must not spawn.",
        compiled: { id: "copy-lead", sourceVersion: "lp-owned-2", sourceHash: "not-a-hash", description: "d", prompt: "p" },
      },
    });
    expect(owned["copy-lead"]?.compiledCorrupt).toBe(true);
    expect(() => resolveSelectedMainAgentProfile({ "main.agent": "copy-lead" }, owned))
      .toThrow(/compiled_main_agent_corrupt/);
  });

  it("does not compile a seed when the selected compiled payload is missing sourceHash", () => {
    const owned = parseOwnedAgents({
      "copy-lead": {
        prompt: "Edited prompt that must not spawn.",
        compiled: { id: "copy-lead", sourceVersion: "lp-owned-2", description: "d", prompt: "p" },
      },
    });
    expect(owned["copy-lead"]?.compiledCorrupt).toBe(true);
    expect(() => resolveSelectedMainAgentProfile({ "main.agent": "copy-lead" }, owned))
      .toThrow(/compiled_main_agent_corrupt/);
  });
});
