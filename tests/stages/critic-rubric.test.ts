import { describe, expect, it } from "vitest";
import { actionableFindings, codeCritiquePrompt, parseCodeCritique, parseCodeCritiqueSettings, shouldRequestRepair } from "../../src/rooms/critique/code-critique";
import { critiquePrompt, parseCritique } from "../../src/rooms/critique/critique";
import { parseSpecialistResult, specialistPrompt } from "../../src/rooms/critique/specialist";
import { buildCandidateEvidence } from "../../src/rooms/critique/code-critique";

const evidence = "the host-read diff and the check output were read";
const codeRubric = (acceptance: "ok" | "fail", proof = "acceptance line 1 is not present in src/a.ts") => [
  { id: "acceptance", result: acceptance, evidence: acceptance === "fail" ? proof : "every acceptance line is in the produced files" },
  { id: "checks", result: "ok" as const, evidence: "the command exited 0 and names the test" },
  { id: "tests", result: "ok" as const, evidence: "no assertion was removed from the tests" },
  { id: "substance", result: "ok" as const, evidence: "the handler has a real body, not a stub" },
];

describe("a critic verdict comes from the rubric", () => {
  it("a pass word with a failed rubric item is a rework the writer can repair", () => {
    const parsed = parseCodeCritique(JSON.stringify({ status: "pass", summary: "fine", findings: [], evidence, rubric: codeRubric("fail") }));
    expect(parsed.status).toBe("rework");
    expect(parsed.decision).toBe("changes_requested");
    expect(actionableFindings(parsed)).toHaveLength(1);
    expect(shouldRequestRepair({ settings: parseCodeCritiqueSettings({ "code_critique.enabled": true }), result: parsed, round: 0 })).toBe(true);
  });

  it("a block word with every rubric item ok is a pass", () => {
    const parsed = parseCodeCritique(JSON.stringify({ status: "block", summary: "stop", findings: [], evidence, rubric: codeRubric("ok") }));
    expect(parsed.status).toBe("pass");
    expect(parsed.decision).toBe("approve");
  });

  it("a fail with too little evidence does not count, and a bad rubric value stays unreadable", () => {
    const weak = parseCodeCritique(JSON.stringify({ status: "pass", summary: "fine", findings: [], evidence, rubric: codeRubric("fail", "too short") }));
    expect(weak.status).toBe("pass");
    expect(() => parseCodeCritique(JSON.stringify({ status: "pass", summary: "fine", findings: [], evidence, rubric: [{ id: "acceptance", result: "maybe", evidence: "not a result" }] }))).toThrow();
  });

  it("an answer with no rubric keeps the host's reading of status and findings", () => {
    const legacy = parseCodeCritique(JSON.stringify({ status: "pass", summary: "fine", findings: [], evidence }));
    expect(legacy.status).toBe("pass");
    expect(legacy.verdict).not.toHaveProperty("rubric");
  });

  it("plan and specialist status follow their own rubric ids", () => {
    const planFail = parseCritique(JSON.stringify({
      status: "pass", summary: "fine", findings: [], evidence,
      rubric: [
        { id: "acceptance", result: "fail", evidence: "acceptance line 2 names no command and no file" },
        { id: "dependencies", result: "ok", evidence: "depends_on names tasks that exist" },
      ],
    }));
    expect(planFail.status).toBe("rework");
    const specialistOk = parseSpecialistResult(JSON.stringify({
      status: "block", summary: "stop", findings: [], evidence,
      rubric: [
        { id: "risk", result: "ok", evidence: "no high or critical risk is in the plan" },
        { id: "mitigation", result: "ok", evidence: "nothing is left without a mitigation" },
      ],
    }));
    expect(specialistOk.status).toBe("pass");
  });

  it("the prompts name the rubric ids and the ok and fail results", () => {
    const packet = buildCandidateEvidence({ produced: [], hashes: {}, verification: [], output: "", ownsPaths: [], neverTouch: [], dirtOk: true });
    expect(codeCritiquePrompt({ evidence: packet, task: {} })).toContain('"ok" or "fail"');
    expect(critiquePrompt({ plan: "p", task: {} })).toContain("acceptance, dependencies, scope, read_first");
    expect(specialistPrompt({ task: {}, plan: "p" })).toContain("risk, mitigation");
  });
});
