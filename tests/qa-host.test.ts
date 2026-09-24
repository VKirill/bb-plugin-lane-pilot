import { describe, expect, it } from "vitest";
import { mapListedQaHosts, qaCodexPreflightReason, qaHostUnreachableReason, resolveBrowserQaTarget, resolveStaleBrowserQaReceipt } from "../src/qa-host";

describe("browser QA host routing", () => {
  it("allows the writer host and requires an explicit cwd on another host", () => {
    expect(() => resolveBrowserQaTarget({
      writerHostId:"stage-host", configuredHostId:"", configuredWorkspace:"", writerWorkspace:"/tmp/writer",
    })).toThrow("browser_qa_host_required");
    expect(resolveBrowserQaTarget({
      writerHostId:"stage-host", configuredHostId:"stage-host", configuredWorkspace:"", writerWorkspace:"/tmp/writer",
    })).toEqual({ hostId:"stage-host", workspacePath:"/tmp/writer", sameHost:true });
    expect(() => resolveBrowserQaTarget({
      writerHostId:"stage-host", configuredHostId:"host-qa-mini", configuredWorkspace:"", writerWorkspace:"/tmp/writer",
    })).toThrow("browser_qa_workspace_required_for_cross_host");
    expect(resolveBrowserQaTarget({
      writerHostId:"stage-host", configuredHostId:"host-qa-mini", configuredWorkspace:"/tmp/lane-pilot-qa", writerWorkspace:"/tmp/writer",
    })).toEqual({ hostId:"host-qa-mini", workspacePath:"/tmp/lane-pilot-qa", sameHost:false });
  });

  it("fails closed when Codex is missing on the selected host", () => {
    expect(qaCodexPreflightReason({
      hostId:"host-qa-mini", providers:[{ id:"codex", available:true }], models:[], model:"gpt-6-luna",
    })).toBe("browser_qa_model_unavailable_on_host:host-qa-mini:codex/gpt-6-luna");
    expect(qaCodexPreflightReason({
      hostId:"host-qa-mini",
      providers:[{ id:"codex", available:true }],
      models:[{ id:"gpt-6-luna", model:"gpt-6-luna", supportedReasoningEfforts:[{ reasoningEffort:"medium" }] }],
      model:"gpt-6-luna",
      reasoning:"high",
    })).toBe("browser_qa_effort_unavailable_on_host:host-qa-mini:codex/gpt-6-luna/high");
    expect(qaCodexPreflightReason({
      hostId:"host-qa-mini",
      providers:[{ id:"codex", available:true }],
      models:[{ id:"gpt-6-luna", model:"gpt-6-luna", defaultReasoningEffort:"xhigh", supportedReasoningEfforts:[{ reasoningEffort:"medium" }] }],
      model:"gpt-6-luna",
    })).toBe("browser_qa_effort_unavailable_on_host:host-qa-mini:codex/gpt-6-luna/xhigh");
    expect(qaCodexPreflightReason({
      hostId:"host-qa-mini", providers:[{ id:"codex", available:true }], models:[{ id:"gpt-6-luna" }],
    })).toBe("browser_qa_codex_requires_configured_model");
  });

  it("marks a claimed running receipt unknown after the stale window", () => {
    const snapshot = { spawnAttempted:true, configuredHostId:"host-qa-mini", workspacePath:"/tmp/lane-pilot-qa" };
    expect(resolveStaleBrowserQaReceipt({
      state:"running", result:snapshot, updatedAt:1_000, now:1_000 + 61_000,
    }).kind).toBe("outcome_unknown");
    expect(resolveStaleBrowserQaReceipt({
      state:"running", result:snapshot, updatedAt:1_000, now:1_000 + 1_000,
    }).kind).toBe("observe");
  });

  it("maps listed hosts and keeps unreachable reasons fail-closed", () => {
    expect(mapListedQaHosts([
      { id:"host-qa-mini", name:"Mini", status:"connected" },
      { id:"stage-host", name:"Writer", status:"connected" },
    ])).toEqual([
      { id:"host-qa-mini", name:"Mini", status:"connected", connected:true },
      { id:"stage-host", name:"Writer", status:"connected", connected:true },
    ]);
    expect(qaHostUnreachableReason("host-qa-mini", new Error("ECONNREFUSED")))
      .toBe("browser_qa_host_unreachable:host-qa-mini:ECONNREFUSED");
  });
});
