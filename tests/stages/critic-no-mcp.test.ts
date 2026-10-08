import { describe, expect, it } from "vitest";
import {
  HELPER_ROLES, MANDATORY_MCP_SERVERS, ROLE_PROFILES, coreRequiredSessionAdvertisement, parseHelperContextSettings, requiredSessionPolicySpawnBinding, roleProfilePolicy,
} from "../../src/rooms/native-agent/helper-context";
import type { HelperRole } from "../../src/rooms/native-agent/helper-context";
import { codeCritiquePrompt, buildCandidateEvidence } from "../../src/rooms/critique/code-critique";
import { critiquePrompt } from "../../src/rooms/critique/critique";
import { pmReadPrompt } from "../../src/rooms/critique/pm-read";
import { roleSpec } from "../../src/rooms/workflow/server/workflow-agent";

// Batch C of review 2: the one-shot readers answer from the message and carry no MCP schema (the code-graph tools cost ~8k tokens a turn).
const ONE_SHOT: HelperRole[] = ["plan-critic", "pm-reader"];
const snapshot = { schemaVersion: 1 as const, mode: "roles" as const, settings: { mode: "roles" as const, skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] }, parentRequired: false, parentPolicy: null, policy: null };
const bound = (role: HelperRole, providerId: string, roleAccess?: Record<string, unknown>) => {
  const b = requiredSessionPolicySpawnBinding({
    capability: "required", advertised: coreRequiredSessionAdvertisement(), providerId, role,
    snapshot: { ...snapshot, settings: { ...snapshot.settings, ...(roleAccess ? { roleAccess } : {}) } },
  }) as unknown as { experimental_vkRequiredSessionPolicy: { policy: Record<string, { names: string[] } | undefined> } };
  return b.experimental_vkRequiredSessionPolicy.policy;
};

describe("one-shot readers load no MCP server beyond the mandatory one", () => {
  it("has no optional MCP, skill or plugin in the role profile", () => {
    for (const role of ONE_SHOT) expect(ROLE_PROFILES[role], role).toEqual({ bbPlugins: [], skills: [], mcpServers: [] });
  });

  it("binds only bb-bridge for every provider the roles run on", () => {
    for (const role of ONE_SHOT) {
      for (const provider of ["acp-opencode", "codex", "claude-code"]) {
        const policy = bound(role, provider);
        expect(policy.mcpServers?.names, `${role}/${provider}`).toEqual([...MANDATORY_MCP_SERVERS]);
        expect(policy.skills?.names, `${role}/${provider}`).toEqual([]);
      }
    }
  });

  it("the router's model step (role pm-reader) and the chain roles map onto those profiles", () => {
    expect(roleSpec("pm-reader").helper).toBe("pm-reader");
    expect(roleSpec("plan-critic").helper).toBe("plan-critic");
  });

  it("other readers keep the code graph: the code critic, reviewers, triage and the thin chain roles", () => {
    const keep: HelperRole[] = ["code-critic", "specialist-reviewer", "night-reviewer", "gate-triage", "analyst", "planner", "auditor", "debugger"];
    for (const role of keep) expect(ROLE_PROFILES[role].mcpServers, role).toEqual(["gitnexus"]);
    expect(bound("code-critic", "codex").mcpServers?.names).toEqual(["bb-bridge", "gitnexus"]);
    // The profile never takes away reading files: that is the provider's own tool, not an MCP server.
    for (const role of HELPER_ROLES) expect(ROLE_PROFILES[role].mcpServers).not.toContain("bb-bridge");
  });

  it("the owner's helper.access.<role> still wins over the role profile", () => {
    const parsed = parseHelperContextSettings({
      "helper.access.plan-critic": { mcpServers: { mode: "allow", names: ["gitnexus"] } },
      "helper.access.pm-reader": { mcpServers: { mode: "all" } },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const access = parsed.settings.roleAccess ?? {};
    expect(roleProfilePolicy("plan-critic", access["plan-critic"]).mcpServers?.names).toEqual(["bb-bridge", "gitnexus"]);
    expect(roleProfilePolicy("pm-reader", access["pm-reader"]).mcpServers).toBeUndefined(); // "all": not narrowed
    expect(bound("plan-critic", "acp-opencode", access).mcpServers?.names).toEqual(["bb-bridge", "gitnexus"]);
    // An empty owner list keeps only the mandatory server.
    const empty = parseHelperContextSettings({ "helper.access.code-critic": { mcpServers: { mode: "allow", names: [] } } });
    if (!empty.ok) throw new Error("settings");
    expect(bound("code-critic", "codex", empty.settings.roleAccess).mcpServers?.names).toEqual(["bb-bridge"]);
  });

  it("the prompts of the one-shot readers do not send the model to tools it does not have", () => {
    expect(critiquePrompt({ plan: "p", task: { id: "t1" } })).not.toMatch(/gitnexus|`query`/);
    expect(pmReadPrompt({ agent: "pm-reader", packet: "x", task: { id: "t1" } })).not.toMatch(/gitnexus|`query`/);
    const evidence = buildCandidateEvidence({ produced: [], hashes: {}, verification: [], output: "", ownsPaths: [], neverTouch: [], dirtOk: true });
    expect(codeCritiquePrompt({ evidence, task: { id: "t1" } })).toContain("gitnexus");
  });
});
