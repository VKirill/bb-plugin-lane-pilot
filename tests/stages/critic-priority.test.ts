import { describe, expect, it } from "vitest";
import { codeCritiquePrompt, buildCandidateEvidence } from "../../src/rooms/critique/code-critique";
import { critiquePrompt } from "../../src/rooms/critique/critique";
import { CRITIC_RUBRIC } from "@lane-pilot/workflow-engine";

describe("plan critic prompt priorities", () => {
  const prompt = critiquePrompt({ plan: "p", task: {} });
  it("puts the outcome defects first, with a rework example and a hygiene example", () => {
    expect(prompt.indexOf("PRIORITY.")).toBeGreaterThan(-1);
    expect(prompt.indexOf("PRIORITY.")).toBeLessThan(prompt.indexOf("Method."));
    expect(prompt).toContain("stopJob(id)");
    expect(prompt).toContain("-> low, pass");
    expect(prompt).toMatch(/Contract hygiene[^\n]*severity low and never on its own a reason for rework/);
  });
  it("makes a whole-suite command medium unless the suite is sandbox-unsafe, and read_first is no rubric id", () => {
    expect(prompt).toMatch(/whole-suite run\) is a medium finding/);
    expect(prompt).toContain("sandbox-unsafe makes it an unverifiable requirement: rework, severity high");
    expect(CRITIC_RUBRIC.plan).not.toContain("read_first");
  });
  it("does not send the scan's partial-coverage line to the model", () => {
    const withFindings = critiquePrompt({ plan: "p", task: {}, structuralFindings: [
      { code: "coverage_scan_truncated", path: ".", severity: "info", finding: "Workspace path listing reached its file bound" },
      { code: "owns_empty", path: "tasks/t", severity: "error", finding: "no owned paths" }] });
    expect(withFindings).not.toContain("coverage_scan_truncated");
    expect(withFindings).toContain("owns_empty");
    expect(critiquePrompt({ plan: "p", task: {}, structuralFindings: [{ code: "coverage_scan_truncated", path: ".", severity: "info", finding: "x" }] })).not.toContain("Deterministic structural findings");
  });
});

describe("code critic prompt focus", () => {
  const packet = buildCandidateEvidence({ produced: [], hashes: {}, verification: [], output: "", ownsPaths: [], neverTouch: [], dirtOk: true });
  it("names why the level is strict, before the method", () => {
    const prompt = codeCritiquePrompt({ evidence: packet, task: {}, focus: "sensitive_path:src/billing.ts" });
    expect(prompt).toContain("Focus first: sensitive_path:src/billing.ts");
    expect(prompt.indexOf("Focus first:")).toBeLessThan(prompt.indexOf("Method."));
    expect(codeCritiquePrompt({ evidence: packet, task: {} })).not.toContain("Focus first");
  });
});
