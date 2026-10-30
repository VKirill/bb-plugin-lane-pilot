import { describe, expect, it } from "vitest";
import { fingerprint, proposePrompt, rejectedPrompt, screenRejected, type RejectedEdit } from "../src/index";

const refused: RejectedEdit = {
  fingerprint: "abc123",
  reason: "worse: acceptance 40% vs 80%",
  summary: "1 check",
};

describe("screenRejected", () => {
  it("lets a candidate through the first time and drops the same fingerprint the second time", () => {
    expect(screenRejected("abc123", []).blocked).toBe(false);
    const again = screenRejected("abc123", [refused]);
    expect(again.blocked).toBe(true);
    expect(again.reason).toContain("acceptance 40%");
    expect(screenRejected("other", [refused]).blocked).toBe(false);
  });

  it("does not treat a retired row with no reason as a refusal", () => {
    expect(screenRejected("abc123", [{ fingerprint: "abc123", reason: "  ", summary: "" }]).blocked).toBe(false);
  });

  it("shows the refusal to the editor", () => {
    const block = rejectedPrompt([refused]);
    expect(block).toContain("abc123");
    expect(block).toContain("acceptance 40%");
    expect(block.toLowerCase()).toContain("do not re-propose");
    const mission = proposePrompt("INV", { area: "admin" }, [refused]);
    expect(mission).toContain("acceptance 40%");
  });

  it("matches a tree by its fingerprint, so an identical tree is the same candidate", () => {
    const tree = { "always-on.md": "When a check fails, read the output before retrying." };
    const fp = fingerprint(tree);
    expect(screenRejected(fp, [{ fingerprint: fp, reason: "no measurable gain", summary: "always-on" }]).blocked).toBe(true);
    expect(screenRejected(fingerprint({ "always-on.md": "other" }), [{ fingerprint: fp, reason: "no measurable gain", summary: "always-on" }]).blocked).toBe(false);
  });
});
