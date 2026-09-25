import { describe, expect, it } from "vitest";
import {
  classifyCliAgentsCollision,
  collisionMessage,
  nativeAgentCliId,
  nativeAgentSettingId,
  nativeSelectionMarker,
  tokensFrom,
} from "../src/native-session";

describe("native agent id", () => {
  it("keeps --agent short and reconstructs the live agentSetting namespace", () => {
    expect(nativeAgentCliId("dev-orchestrator")).toBe("dev-orchestrator");
    expect(nativeAgentCliId("lane-stack:dev-orchestrator")).toBe("dev-orchestrator");
    expect(nativeAgentSettingId("dev-orchestrator", "plugin:lane-stack")).toBe("lane-stack:dev-orchestrator");
    expect(nativeAgentSettingId("lane-stack:dev-orchestrator")).toBe("lane-stack:dev-orchestrator");
  });
});

describe("cli-agents collision", () => {
  const pending = {
    projectId: "proj_a",
    hostId: "host_a",
    providerId: "claude-code",
    agentId: "reviewer",
    token: "00000000-0000-0000-0000-000000000001",
  };

  it("sees project pending without a CLI Agents mention", () => {
    expect(classifyCliAgentsCollision({
      messageValue: { text: "ordinary task" },
      pending,
      thread: null,
      hostId: "host_a",
      providerId: "claude-code",
    })).toBe("pending");
  });

  it("sees a thread binding after CLI Agents dispatch consumed pending", () => {
    expect(classifyCliAgentsCollision({
      messageValue: { text: "follow-up" },
      pending: null,
      thread: pending,
      hostId: "host_a",
      providerId: "claude-code",
    })).toBe("thread");
  });

  it("does not treat another host pending as this send", () => {
    expect(classifyCliAgentsCollision({
      messageValue: {},
      pending,
      thread: null,
      hostId: "host_b",
      providerId: "claude-code",
    })).toBeNull();
  });

  it("extracts only Lane Pilot tokens", () => {
    const token = "11111111-1111-1111-1111-111111111111";
    expect(tokensFrom({ text: nativeSelectionMarker(token) })).toEqual([token]);
    expect(tokensFrom({ text: "[cli-agents-selection:11111111-1111-1111-1111-111111111111]" })).toEqual([]);
  });

  it("does not tell the operator to clear foreign pending", () => {
    expect(collisionMessage("pending")).toContain("does not delete pending:");
  });
});
