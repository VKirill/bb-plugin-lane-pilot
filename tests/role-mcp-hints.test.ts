import { gitnexusRepoOf } from "../src/rooms/writer/server/writer-knowledge";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROLE_PROFILES, HelperRole, requiredSessionPolicySpawnBinding, coreRequiredSessionAdvertisement } from "../src/rooms/contracts/helper-context";
import { writerToolLine } from "../src/rooms/writer/server/writer-task";
import { critiquePrompt } from "../src/rooms/critique/critique";
import { codeCritiquePrompt, buildCandidateEvidence } from "../src/rooms/critique/code-critique";
import { pmReadPrompt } from "../src/rooms/critique/pm-read";

describe("role MCP server configurations", () => {
  it("assigns expected MCP servers across all helper roles", () => {
    // 1. writer, code-repair, night-fixer keep gitnexus (impact before editing) and carry no metamcp (0 calls in 1038 writer runs)
    expect(ROLE_PROFILES["writer"].mcpServers).toEqual(["gitnexus"]);
    expect(ROLE_PROFILES["code-repair"].mcpServers).toEqual(["gitnexus"]);
    expect(ROLE_PROFILES["night-fixer"].mcpServers).toEqual(["gitnexus"]);

    // 2. code roles get gitnexus
    const gitnexusRoles: HelperRole[] = [
      "code-critic",
      "specialist-reviewer",
      "debugger",
    ];
    for (const role of gitnexusRoles) {
      expect(ROLE_PROFILES[role].mcpServers, `Role ${role} should have gitnexus`).toEqual(["gitnexus"]);
    }

    // Roles that did not call the code graph in a measured week carry no MCP server (hub, the week to 2026-11-10).
    // docs-maintainer: 10 calls in 1968 runs; onboarder and project-life: 1 in 75 (audit 2026-11-14).
    for (const role of ["gate-triage", "analyst", "planner", "auditor", "plan-critic", "pm-reader", "docs-maintainer", "onboarder", "project-life"] as HelperRole[]) {
      expect(ROLE_PROFILES[role].mcpServers, `Role ${role} carries no MCP server`).toEqual([]);
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

    // 5. Invariant: discord-web, computer-use, node_repl are NEVER given to helper roles
    const forbidden = ["discord-web", "computer-use", "node_repl"];
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

    // A known provider whose row differs from every expected variant cannot be narrowed at all (one warning, then {}).
    const limitedAdvertised = {
      ...advertised,
      providerGroups: {
        ...advertised.providerGroups,
        "claude-code": ["bbPlugins", "skills"], // not a variant the table holds for claude-code
      },
    };
    const boundDrifted = requiredSessionPolicySpawnBinding({
      capability: "required",
      advertised: limitedAdvertised,
      snapshot,
      providerId: "claude-code",
      role: "writer",
    });
    expect(boundDrifted).toEqual({});

    // A provider that advertises only an ACP subset (no mcpServers) still binds; lenient mode strips the unsupported groups.
    const acpAdvertised = {
      ...advertised,
      providerGroups: { ...advertised.providerGroups, "acp-future": ["bbPlugins", "skills"] },
      instructionSwitches: { ...advertised.instructionSwitches, "acp-future": ["userInstructions"] },
    };
    const boundLimited = requiredSessionPolicySpawnBinding({
      capability: "required",
      advertised: acpAdvertised,
      snapshot,
      providerId: "acp-future",
      role: "writer",
    });
    expect(boundLimited).toHaveProperty("experimental_vkRequiredSessionPolicy");
    const limited = (boundLimited as { experimental_vkRequiredSessionPolicy: { policy: Record<string, unknown> } }).experimental_vkRequiredSessionPolicy.policy;
    expect(limited.mcpServers).toBeUndefined();
    expect(limited.nativePlugins).toBeUndefined();
  });
});

describe("prompt hints for gitnexus and metamcp", () => {
  it("the writer's tool line names gitnexus and context7 only when the role has them and the index exists", () => {
    const full = writerToolLine({ gitnexusTools: true, gitnexusIndex: true, gitnexusRepo: "shop", metamcpTools: true });
    expect(full).toContain('pass repo: "shop" on every call');
    expect(full).toContain("run `impact` on it");
    expect(full).toContain("context7");
    // The worktree is not indexed: without the registry name a GitNexus call finds nothing, so the line is not given.
    expect(writerToolLine({ gitnexusTools: true, gitnexusIndex: true })).not.toContain("GitNexus");
    expect(gitnexusRepoOf("HEAD=abc\nREPO=bb-plugin-lane-pilot\n")).toBe("bb-plugin-lane-pilot");
    expect(gitnexusRepoOf("NONE\n")).toBeUndefined();
    // Tools the role does not load are not pointed at; a missing index drops the gitnexus part alone.
    const noIndex = writerToolLine({ gitnexusTools: true, metamcpTools: true });
    expect(noIndex).not.toContain("GitNexus");
    expect(noIndex).toContain("context7");
    const bare = writerToolLine();
    expect(bare).toContain("Find code with grep");
    expect(bare).not.toContain("GitNexus");
    expect(bare).not.toContain("context7");
    expect(bare).toContain("that is no reason to stop");
  });

  const expectedHint = "with gitnexus tools and a `.gitnexus/` index use `query`/`context`/`impact`; grep for literals.";

  it("critiquePrompt and pmReadPrompt no longer point at tools the role does not load", () => {
    expect(critiquePrompt({ plan: "test-plan", task: { id: "t1" } })).not.toContain("gitnexus");
    expect(pmReadPrompt({ task: { id: "t1" } })).not.toContain("gitnexus");
  });

  it("codeCritiquePrompt carries the gitnexus line only for a workspace that has the index", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-gnx-hint-"));
    const evidence = {
      ...buildCandidateEvidence({
        produced: [],
        hashes: {},
        verification: [],
        output: "",
        ownsPaths: [],
        neverTouch: [],
        dirtOk: true,
      }),
      workspace: dir,
    };
    expect(codeCritiquePrompt({ evidence, task: { id: "t1" } })).not.toContain(expectedHint);
    mkdirSync(join(dir, ".gitnexus"));
    expect(codeCritiquePrompt({ evidence, task: { id: "t1" } })).toContain(expectedHint);
  });
});
