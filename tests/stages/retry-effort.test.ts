import { describe, expect, it } from "vitest";
import { resolveRetryEffort } from "../../src/stages/retry-effort";

const supported = new Set(["low", "medium", "high", "xhigh"]);

describe("bounded writer retry effort", () => {
  it("keeps the first attempt unchanged", () => {
    expect(resolveRetryEffort({ current:"medium", supportedLevels:supported, retryIndex:0, enabled:true }))
      .toMatchObject({ after:"medium", changed:false });
  });

  it("escalates one supported level on a retry", () => {
    expect(resolveRetryEffort({ current:"medium", supportedLevels:supported, retryIndex:1, enabled:true }))
      .toMatchObject({ before:"medium", after:"high", changed:true });
  });

  it("caps escalation at high, including an xhigh first attempt", () => {
    expect(resolveRetryEffort({ current:"high", supportedLevels:supported, retryIndex:1, enabled:true }).after).toBe("high");
    expect(resolveRetryEffort({ current:"xhigh", supportedLevels:supported, retryIndex:1, enabled:true }).after).toBe("high");
  });

  it("does not escalate when the shared LANE_JEV_EFFORT control is disabled", () => {
    expect(resolveRetryEffort({ current:"medium", supportedLevels:supported, retryIndex:1, enabled:false }))
      .toMatchObject({ after:"medium", changed:false, enabled:false });
  });

  it("keeps the current supported level when no higher allowed level is supported", () => {
    expect(resolveRetryEffort({ current:"medium", supportedLevels:new Set(["medium", "xhigh"]), retryIndex:1, enabled:true }))
      .toMatchObject({ after:"medium", changed:false });
  });
});
