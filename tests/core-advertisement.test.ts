import { describe, expect, it } from "vitest";
import { parseRequiredSessionPolicyCapability } from "../src/rooms/native-agent/helper-context";
import { coreHostsRequiredProvider } from "../src/rooms/runs/server";
import { classifyFailure } from "../src/rooms/runs/failure-class";

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

  it("an ACP agent the table does not know narrows only the ACP subset; a known provider's row must still match", () => {
    const parse = (core: unknown) => parseRequiredSessionPolicyCapability({ experimental_vkRequiredSessionPolicy: () => core });
    expect(parse(acpRow({ "acp-antigravity": ["bbPlugins", "nativePlugins"] }, {}, ["acp-antigravity"]))).toBeNull();
    expect(parse(acpRow({}, { "acp-antigravity": ["userInstructions", "projectInstructions"] }, ["acp-antigravity"]))).toBeNull();
    expect(parse(acpRow({ codex: ["bbPlugins"] }, {}, ["devin"]))).toBeNull();
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
