import { describe, expect, it } from "vitest";
import { parseRequiredSessionPolicyCapability } from "../src/rooms/native-agent/helper-context";
import { coreHostsRequiredProvider } from "../src/rooms/runs/server";
import { classifyFailure } from "../src/rooms/runs/failure-class";

// A literal copy of VK_REQUIRED_SESSION_POLICY_CAPABILITY from the VK core (packages/domain/src/vk-session-policy.ts, e74519ed4).
// The older tests fed Lane Pilot its own table back, so W35 added devin on both sides and nobody saw the core stop matching.
const VK_CORE = {
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

describe("the VK core required-policy advertisement", () => {
  it("is recognised, so helpers keep their role profiles", () => {
    expect(parseRequiredSessionPolicyCapability({ experimental_vkRequiredSessionPolicy: () => VK_CORE })).not.toBeNull();
  });

  it("a provider the core does not list is not started under a PM policy; the chain takes the next writer", () => {
    const bb = { agents: { experimental_vkRequiredSessionPolicy: () => VK_CORE } } as never;
    expect(coreHostsRequiredProvider(bb, "devin")).toBe(false);
    expect(coreHostsRequiredProvider(bb, "acp-cursor")).toBe(true);
    expect(coreHostsRequiredProvider({ agents: {} } as never, "devin")).toBe(true);
    expect(classifyFailure("blocked", "writer_provider_unavailable:core_unsupported:devin").cls).toBe("limit");
  });
});
