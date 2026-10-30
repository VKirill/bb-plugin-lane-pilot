import { describe, expect, it } from "vitest";
import { parseCodeCritique } from "../../src/rooms/critique/code-critique";
import { parseCritique } from "../../src/rooms/critique/critique";

// Hub 2026-10-30, six tasks blocked on code_critique_failed by answer shapes, not by findings.
describe("a code critic answer in a known foreign form is folded, not refused", () => {
  it("drops keys the schema does not know (status_note, summary_note)", () => {
    const raw = JSON.stringify({ decision: "approve", summary: "looks fine", findings: [], status_note: "reviewed diff only", summary_note: "n/a" });
    expect(parseCodeCritique(raw).decision).toBe("approve");
    expect(parseCritique(raw).decision).toBe("approve");
  });

  it("an empty optional field counts as absent (verificationExpectation: \"\")", () => {
    const raw = JSON.stringify({ decision: "changes_requested", summary: "gaps", findings: [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, severity: "info", finding: `note ${i}`, criterion: "style" })),
      { id: "f5", severity: "blocking", finding: "no test covers the new branch", criterion: "tests", verificationExpectation: "" },
    ] });
    const parsed = parseCodeCritique(raw);
    expect(parsed.decision).toBe("changes_requested");
    expect(parsed.findings[5]?.verificationExpectation).toBeUndefined();
  });

  it("foreign decision words map to ours (approve/changes_requested → pass/block)", () => {
    expect(parseCodeCritique(JSON.stringify({ decision: "approved", summary: "ok", findings: [] })).decision).toBe("approve");
    expect(parseCodeCritique(JSON.stringify({ decision: "pass", summary: "ok", findings: [] })).decision).toBe("approve");
    expect(parseCodeCritique(JSON.stringify({ status: "approved", summary: "ok", findings: [], evidence: "read the diff" })).status).toBe("pass");
    // "rejected" folds to a verdict, not a parse error.
    expect(() => parseCodeCritique(JSON.stringify({ status: "rejected", summary: "bad", findings: [], evidence: "read the diff" }))).not.toThrow();
    expect(() => parseCodeCritique(JSON.stringify({ status: "needs_changes", summary: "fix", findings: [], evidence: "read the diff" }))).not.toThrow();
  });

  it("a status and a decision together keep the verdict reading", () => {
    const raw = JSON.stringify({ status: "pass", decision: "approved", summary: "ok", findings: [], evidence: "checked files" });
    expect(parseCodeCritique(raw).status).toBe("pass");
  });

  it("genuinely unreadable output still throws (the retry/fallback path owns it)", () => {
    expect(() => parseCodeCritique("not json at all")).toThrow();
    expect(() => parseCodeCritique(JSON.stringify({ decision: "maybe", summary: "x", findings: [] }))).toThrow();
  });
});
