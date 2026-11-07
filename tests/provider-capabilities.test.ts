import { describe, expect, it } from "vitest";
import { providerForwardsAgentOnly } from "@lane-pilot/models";

describe("providerForwardsAgentOnly", () => {
  it("is a property of the provider, devin included", () => {
    for (const providerId of ["claude-code", "codex", "opencode2", "devin", "acp-cursor"]) {
      expect(providerForwardsAgentOnly(providerId), providerId).toBe(true);
    }
    expect(providerForwardsAgentOnly("zcode")).toBe(false);
  });
});
