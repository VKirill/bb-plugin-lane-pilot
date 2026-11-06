import { describe, expect, it } from "vitest";
import { parseRequiredSessionPolicyCapability, requiredSessionPolicySpawnBinding, type HelperPolicySnapshot } from "../src/rooms/native-agent/helper-context";
import { coreHostsRequiredProvider } from "../src/rooms/runs/server";
import { classifyFailure } from "../src/rooms/runs/failure-class";

const ROLES_SNAPSHOT: HelperPolicySnapshot = {
  schemaVersion: 1, mode: "roles",
  settings: { mode: "roles", skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] },
  parentRequired: false, parentPolicy: null, policy: null,
};

// A literal copy of VK_REQUIRED_SESSION_POLICY_CAPABILITY from the VK core (packages/domain/src/vk-session-policy.ts, e74519ed4).
// The older tests fed Lane Pilot its own table back, so W35 added devin on both sides and nobody saw the core stop matching.
const VK_CORE_E74519 = {
  version: 1, persist: true, requiredMarker: true, snapshotDigest: true, parentCeiling: true, bridgeHandshakeVersion: 1,
  markerStorage: "thread-plugin-metadata",
  providerGroups: {
    "claude-code": ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
    codex: ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
    "acp-opencode": ["bbPlugins", "skills", "mcpServers"],
    "acp-cursor": ["bbPlugins", "skills", "mcpServers"],
    opencode2: ["bbPlugins", "skills", "mcpServers"],
  },
  instructionSwitches: {
    "claude-code": ["userInstructions", "projectInstructions", "claudeAiSync"],
    codex: ["userInstructions", "projectInstructions"],
    "acp-opencode": ["userInstructions", "projectInstructions"],
    "acp-cursor": ["userInstructions"],
    opencode2: ["userInstructions"],
  },
  mandatoryBbPlugins: ["environment-project-checkout", "project-folders"],
  mandatoryMcpServers: ["bb-bridge"],
};

// The hub's core 0.48.1-vk.4 (115c64f68, read off the hub's start-server.js 2026-11-06): devin and zcode rows. Lane Pilot's exact match
// refused it, so from that deploy every helper ran with BB's whole context (get_globals said requiredSessionPolicy «none»).
const acpRow = (groups: Record<string, string[]>, switches: Record<string, string[]>, ids: string[]) => ({
  ...VK_CORE_E74519,
  providerGroups: { ...VK_CORE_E74519.providerGroups, ...Object.fromEntries(ids.map((id) => [id, ["bbPlugins", "skills", "mcpServers"]])), ...groups },
  instructionSwitches: { ...VK_CORE_E74519.instructionSwitches, ...Object.fromEntries(ids.map((id) => [id, ["userInstructions"]])), ...switches },
});
const VK_CORE_HUB = acpRow({}, {}, ["devin", "zcode"]);
// e1dee719b: Antigravity joins the ACP providers.
const VK_CORE = acpRow({}, {}, ["devin", "zcode", "acp-antigravity"]);

describe("the VK core required-policy advertisement", () => {
  it("is recognised, so helpers keep their role profiles", () => {
    for (const core of [VK_CORE_E74519, VK_CORE_HUB, VK_CORE]) expect(parseRequiredSessionPolicyCapability({ experimental_vkRequiredSessionPolicy: () => core })).not.toBeNull();
  });

  it("an ACP agent the table does not know narrows only the ACP subset; a known provider's differing row cannot be narrowed", () => {
    const bind = (core: unknown, providerId: string) => requiredSessionPolicySpawnBinding({
      capability: "required", snapshot: ROLES_SNAPSHOT, providerId, role: "auditor",
      advertised: parseRequiredSessionPolicyCapability({ experimental_vkRequiredSessionPolicy: () => core }),
    });
    // Rows outside the ACP subset leave that provider with BB's ordinary context — the other providers keep theirs.
    for (const core of [
      acpRow({ "acp-antigravity": ["bbPlugins", "nativePlugins"] }, {}, ["acp-antigravity"]),
      acpRow({}, { "acp-antigravity": ["userInstructions", "projectInstructions"] }, ["acp-antigravity"]),
    ]) {
      expect(bind(core, "acp-antigravity")).toEqual({});
      expect(bind(core, "codex")).not.toEqual({});
    }
    // A known provider's row outside every variant is a mismatch for that provider only.
    const drifted = acpRow({ codex: ["bbPlugins"] }, {}, ["devin"]);
    expect(bind(drifted, "codex")).toEqual({});
    expect(bind(drifted, "claude-code")).not.toEqual({});
    expect(bind(drifted, "devin")).not.toEqual({});
  });

  it("a drifted provider row is flagged once per process, and only that provider loses narrowing", async () => {
    const { requiredSessionPolicySpawnBinding, providerPolicyRows } = await import("../src/rooms/native-agent/helper-context");
    const drifted = acpRow({ codex: ["bbPlugins"] }, {}, ["devin", "zcode", "acp-antigravity"]);
    const advertised = parseRequiredSessionPolicyCapability({ experimental_vkRequiredSessionPolicy: () => drifted })!;
    expect(advertised).not.toBeNull();
    const rows = providerPolicyRows(advertised, "codex");
    expect(rows.ok).toBe(false);
    if (!rows.ok) expect(rows.reason).toContain("providerGroups");
    const warnings: string[] = [];
    const bind = () => requiredSessionPolicySpawnBinding({ capability: "required", advertised, snapshot: ROLES_SNAPSHOT, providerId: "codex", role: "auditor", log: (line) => warnings.push(line) });
    expect(bind()).toEqual({});
    expect(bind()).toEqual({}); // the same provider warns once, not per spawn
    expect(warnings).toEqual(["core advertisement for codex differs: providerGroups [\"bbPlugins\"]"]);
    expect(providerPolicyRows(advertised, "devin").ok).toBe(true);
    expect(providerPolicyRows(advertised, "claude-code").ok).toBe(true);
    expect(providerPolicyRows(advertised, "unknown-provider").ok).toBe(false);
  });

  it("binds the role profile of a helper on Antigravity once the core lists it", async () => {
    const { requiredSessionPolicySpawnBinding } = await import("../src/rooms/native-agent/helper-context");
    const snapshot = { schemaVersion: 1 as const, mode: "roles" as const, settings: { mode: "roles" as const, skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] }, parentRequired: false, parentPolicy: null, policy: null };
    const bind = (core: unknown) => requiredSessionPolicySpawnBinding({ capability: "required", advertised: parseRequiredSessionPolicyCapability({ experimental_vkRequiredSessionPolicy: () => core }), snapshot, providerId: "acp-antigravity", role: "auditor" });
    expect(bind(VK_CORE_HUB)).toEqual({});
    const policy = (bind(VK_CORE) as { experimental_vkRequiredSessionPolicy: { policy: Record<string, unknown> } }).experimental_vkRequiredSessionPolicy.policy;
    expect(policy.bbPlugins).toEqual({ mode: "allow", names: ["environment-project-checkout", "project-folders"] });
    expect(policy.skills).toEqual({ mode: "allow", names: [] });
    expect(policy.nativePlugins).toBeUndefined();
    expect(policy.projectInstructions).toBeUndefined();
  });

  it("a provider the core does not list is not started under a PM policy; the chain takes the next writer", () => {
    const bb = { agents: { experimental_vkRequiredSessionPolicy: () => VK_CORE_E74519 } } as never;
    expect(coreHostsRequiredProvider(bb, "devin")).toBe(false);
    expect(coreHostsRequiredProvider({ agents: { experimental_vkRequiredSessionPolicy: () => VK_CORE } } as never, "acp-antigravity")).toBe(true);
    expect(coreHostsRequiredProvider(bb, "acp-cursor")).toBe(true);
    expect(coreHostsRequiredProvider({ agents: {} } as never, "devin")).toBe(true);
    expect(classifyFailure("blocked", "writer_provider_unavailable:core_unsupported:devin").cls).toBe("limit");
  });
});
