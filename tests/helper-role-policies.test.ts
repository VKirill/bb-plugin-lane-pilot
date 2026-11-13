import { describe, expect, it } from "vitest";
import {
  HELPER_ROLES, ROLE_PROFILES, parseRequiredSessionPolicyCapability, requiredSessionPolicySpawnBinding, roleProfilePolicy,
  type HelperPolicySnapshot, type HelperRole,
} from "../src/rooms/contracts/helper-context";

// The hub's core as it advertises today (0.48.1-vk.4 + acp-antigravity): the five CLI providers, devin, zcode and
// acp-antigravity on the ACP subset. Mirrors tests/core-advertisement.test.ts.
const VK_CORE = {
  version: 1, persist: true, requiredMarker: true, snapshotDigest: true, parentCeiling: true, bridgeHandshakeVersion: 1,
  markerStorage: "thread-plugin-metadata",
  providerGroups: {
    "claude-code": ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
    codex: ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
    "acp-opencode": ["bbPlugins", "skills", "mcpServers"],
    "acp-cursor": ["bbPlugins", "skills", "mcpServers"],
    opencode2: ["bbPlugins", "skills", "mcpServers"],
    devin: ["bbPlugins", "skills", "mcpServers"],
    zcode: ["bbPlugins", "skills", "mcpServers"],
    "acp-antigravity": ["bbPlugins", "skills", "mcpServers"],
  },
  instructionSwitches: {
    "claude-code": ["userInstructions", "projectInstructions", "claudeAiSync"],
    codex: ["userInstructions", "projectInstructions"],
    "acp-opencode": ["userInstructions", "projectInstructions"],
    "acp-cursor": ["userInstructions"],
    opencode2: ["userInstructions"],
    devin: ["userInstructions"],
    zcode: ["userInstructions"],
    "acp-antigravity": ["userInstructions"],
  },
  mandatoryBbPlugins: ["environment-project-checkout", "project-folders"],
  mandatoryMcpServers: ["bb-bridge"],
};

const SNAPSHOT: HelperPolicySnapshot = {
  schemaVersion: 1, mode: "roles",
  settings: { mode: "roles", skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] },
  parentRequired: false, parentPolicy: null, policy: null,
};

const advertised = parseRequiredSessionPolicyCapability({ experimental_vkRequiredSessionPolicy: () => VK_CORE })!;

function boundPolicy(providerId: string, role: HelperRole) {
  const bound = requiredSessionPolicySpawnBinding({ capability: "required", advertised, snapshot: SNAPSHOT, providerId, role });
  return (bound as { experimental_vkRequiredSessionPolicy?: { policy: Record<string, unknown> } }).experimental_vkRequiredSessionPolicy?.policy;
}

const PROMPT_ONLY: HelperRole[] = [
  "plan-critic", "pm-reader", "memory-maintainer", "council-seat",
  "rules-analyzer", "episode-analyst", "wall-hunter", "specialist:lead", "workspace-provisioner",
];

describe("role profiles carried on the spawn", () => {
  it("the workspace-provisioner holder gets an empty policy: no plugins, skills, MCP or instructions", () => {
    const policy = boundPolicy("codex", "workspace-provisioner")!;
    expect(policy.bbPlugins).toEqual({ mode: "allow", names: ["environment-project-checkout", "project-folders"] });
    expect(policy.skills).toEqual({ mode: "allow", names: [] });
    expect(policy.mcpServers).toEqual({ mode: "allow", names: ["bb-bridge"] });
    expect(policy.userInstructions).toBe(false);
    expect(policy.projectInstructions).toBe(false);
  });

  it("the lead and the architect keep the lane-pilot plugin; the architect keeps its skill", () => {
    const lead = boundPolicy("claude-code", "lead")!;
    expect((lead.bbPlugins as { names: string[] }).names).toContain("lane-pilot");
    const architect = boundPolicy("claude-code", "workflow-architect")!;
    expect((architect.bbPlugins as { names: string[] }).names).toContain("lane-pilot");
    expect((architect.skills as { names: string[] }).names).toEqual(["lane-pilot"]);
    for (const role of ["lead", "workflow-architect"] as const) expect(ROLE_PROFILES[role].mcpServers).toEqual([]);
  });

  it("every background role drops the user's personal instructions", () => {
    for (const role of HELPER_ROLES) expect(roleProfilePolicy(role).userInstructions).toBe(false);
  });

  it("prompt-only roles also drop project instructions; working roles keep them", () => {
    for (const role of PROMPT_ONLY) expect(roleProfilePolicy(role).projectInstructions, role).toBe(false);
    // An empty profile means prompt-only; the harness sessions edit files, but the mission on disk is their whole brief.
    for (const role of ["harness-editor", "harness-composer", "harness-reflection"] as const)
      expect(roleProfilePolicy(role).projectInstructions, role).toBe(false);
    for (const role of ["writer", "code-critic", "docs-maintainer", "lead", "workflow-architect"] as const)
      expect(roleProfilePolicy(role).projectInstructions, role).toBeUndefined();
  });

  it("an owner include still wins over the prompt-only default", () => {
    const policy = roleProfilePolicy("pm-reader", { projectInstructions: "include" });
    expect(policy.projectInstructions).toBeUndefined();
  });

  it("a provider that cannot switch projectInstructions off gets the switch omitted, never refused", () => {
    // acp-cursor, devin, zcode, opencode2 advertise only userInstructions: the core would refuse a
    // projectInstructions key, so the spawn carries userInstructions:false and no projectInstructions at all.
    for (const providerId of ["acp-cursor", "devin", "zcode", "opencode2", "acp-antigravity"]) {
      const policy = boundPolicy(providerId, "plan-critic")!;
      expect(policy.userInstructions, providerId).toBe(false);
      expect(policy.projectInstructions, providerId).toBeUndefined();
    }
    // Providers that can switch it off get the real false.
    for (const providerId of ["claude-code", "codex", "acp-opencode"]) {
      const policy = boundPolicy(providerId, "plan-critic")!;
      expect(policy.projectInstructions, providerId).toBe(false);
    }
  });

  it("every table role binds on every advertised provider", () => {
    for (const providerId of Object.keys(VK_CORE.providerGroups)) {
      for (const role of HELPER_ROLES) expect(boundPolicy(providerId, role), `${providerId}/${role}`).toBeDefined();
    }
  });
});
