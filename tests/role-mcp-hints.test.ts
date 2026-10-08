import { describe, expect, it } from "vitest";
import { ROLE_PROFILES, HelperRole, requiredSessionPolicySpawnBinding, coreRequiredSessionAdvertisement } from "../src/rooms/native-agent/helper-context";
import { WRITER_SETUP_LINES } from "../src/rooms/writer/server/writer-task";
import { critiquePrompt } from "../src/rooms/critique/critique";
import { codeCritiquePrompt, buildCandidateEvidence } from "../src/rooms/critique/code-critique";
import { pmReadPrompt } from "../src/rooms/critique/pm-read";

describe("role MCP server configurations", () => {
  it("assigns expected MCP servers across all helper roles", () => {
    // 1. writer, code-repair, night-fixer have gitnexus and metamcp
    expect(ROLE_PROFILES["writer"].mcpServers).toEqual(["gitnexus", "metamcp"]);
    expect(ROLE_PROFILES["code-repair"].mcpServers).toEqual(["gitnexus", "metamcp"]);
    expect(ROLE_PROFILES["night-fixer"].mcpServers).toEqual(["gitnexus", "metamcp"]);

    // 2. code roles get gitnexus
    const gitnexusRoles: HelperRole[] = [
      "code-critic",
      "night-reviewer",
      "specialist-reviewer",
      "gate-triage",
      "docs-maintainer",
      "onboarder",
      "project-life",
    ];
    for (const role of gitnexusRoles) {
      expect(ROLE_PROFILES[role].mcpServers, `Role ${role} should have gitnexus`).toEqual(["gitnexus"]);
    }

    // 3. specialist:design-lead gets metamcp
    expect(ROLE_PROFILES["specialist:design-lead"].mcpServers).toEqual(["metamcp"]);

    // 4. other roles have no optional mcp servers
    const otherRoles: HelperRole[] = [
      "plan-critic",
      "pm-reader",
      "memory-maintainer",
      "council-seat",
      "rules-analyzer",
      "browser-qa",
      "errand",
      "specialist:copy-lead",
      "specialist:seo-specialist",
      "specialist:tavily",
    ];
    for (const role of otherRoles) {
      expect(ROLE_PROFILES[role].mcpServers, `Role ${role} should have empty mcpServers`).toEqual([]);
    }

    // 5. Invariant: agentmemory, discord-web, computer-use, node_repl are NEVER given to helper roles
    const forbidden = ["agentmemory", "discord-web", "computer-use", "node_repl"];
    for (const [role, profile] of Object.entries(ROLE_PROFILES)) {
      for (const bad of forbidden) {
        expect(profile.mcpServers, `Role ${role} must not include ${bad}`).not.toContain(bad);
      }
    }
  });

  it("spawns without error when host/provider lacks gitnexus or metamcp (lenient role spawn)", () => {
    const advertised = coreRequiredSessionAdvertisement();
    const snapshot = {
      schemaVersion: 1 as const,
      mode: "roles" as const,
      settings: { mode: "roles" as const, skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] },
      parentRequired: false,
      parentPolicy: null,
      policy: null,
    };

    // When provider supports mcpServers, spawn succeeds and binds policy
    const bound = requiredSessionPolicySpawnBinding({
      capability: "required",
      advertised,
      snapshot,
      providerId: "claude-code",
      role: "writer",
    });
    expect(bound).toHaveProperty("experimental_vkRequiredSessionPolicy");

    // When provider does NOT support mcpServers (e.g. legacy or custom provider), lenient mode strips unsupported groups without error
    const limitedAdvertised = {
      ...advertised,
      providerGroups: {
        ...advertised.providerGroups,
        "claude-code": ["bbPlugins", "skills"], // mcpServers omitted
      },
    };
    const boundLimited = requiredSessionPolicySpawnBinding({
      capability: "required",
      advertised: limitedAdvertised,
      snapshot,
      providerId: "claude-code",
      role: "writer",
    });
    expect(boundLimited).toHaveProperty("experimental_vkRequiredSessionPolicy");
    const policy = (boundLimited as { experimental_vkRequiredSessionPolicy: { policy: Record<string, unknown> } }).experimental_vkRequiredSessionPolicy.policy;
    expect(policy.mcpServers).toBeUndefined();
  });
});

describe("prompt hints for gitnexus and metamcp", () => {
  it("WRITER_SETUP_LINES carries the gitnexus-first and context7 lines", () => {
    const gitnexusLine = WRITER_SETUP_LINES.find((line) => line.includes("GitNexus index") && line.includes("gitnexus"));
    expect(gitnexusLine).toBeDefined();
    expect(gitnexusLine).toBe(
      "If the project has a GitNexus index (a `.gitnexus/` folder) and you have the gitnexus tools, find code with them first: `query` for a concept, `context` for a symbol's callers and callees, `impact` before changing a shared function. Use grep for literals and when the index has no answer. For a library's API use the context7 docs (through metamcp) before guessing. If you lack a tool, read the code yourself; that is no reason to stop.",
    );
  });

  const expectedHint = "If you have the gitnexus tools and the project has a `.gitnexus/` index, use `query`/`context`/`impact` to check claims about callers and blast radius; grep for literals.";

  it("critiquePrompt and pmReadPrompt no longer point at tools the role does not load", () => {
    expect(critiquePrompt({ plan: "test-plan", task: { id: "t1" } })).not.toContain("gitnexus");
    expect(pmReadPrompt({ agent: "pm-reader", packet: "packet", task: { id: "t1" } })).not.toContain("gitnexus");
  });

  it("codeCritiquePrompt carries the gitnexus line", () => {
    const evidence = buildCandidateEvidence({
      produced: [],
      hashes: {},
      verification: [],
      output: "",
      ownsPaths: [],
      neverTouch: [],
      dirtOk: true,
    });
    const prompt = codeCritiquePrompt({ evidence, task: { id: "t1" } });
    expect(prompt).toContain(expectedHint);
  });
});
