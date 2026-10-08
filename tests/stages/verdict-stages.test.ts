import { describe, expect, it } from "vitest";
import { actionableFindings, buildCandidateEvidence, codeCritiquePrompt, critiqueFromStageResult, parseCodeCritique, parseCodeCritiqueSettings, shouldRequestRepair } from "../../src/rooms/critique/code-critique";
import { critiquePrompt, parseCritique } from "../../src/rooms/critique/critique";
import { reasonForStatus } from "../../src/rooms/critique/verdict";
import { parseSpecialistResult, specialistPrompt } from "../../src/rooms/critique/specialist";

const evidence = buildCandidateEvidence({ produced: [], hashes: {}, verification: [], output: "", ownsPaths: [], neverTouch: [], dirtOk: true });
const f = (over: Record<string, unknown> = {}) => ({ file: "src/a.ts", line: 12, severity: "high", evidence: "export const login = () => null; // TODO: implement", finding: "login handler is a stub", criterion: "acceptance 2", ...over });
const answer = (status: string, findings: unknown[], over: Record<string, unknown> = {}) => JSON.stringify({ status, summary: "reviewed", findings, evidence: "read src/a.ts and the vitest output", ...over });
const settings = parseCodeCritiqueSettings({ "code_critique.enabled": true });

describe("plan critique: unified verdict, old output still read", () => {
  it("old approve and changes_requested map to pass and rework and keep their decision", () => {
    expect(parseCritique('{"decision":"approve","summary":"ok","findings":[]}')).toMatchObject({ decision: "approve", status: "pass" });
    const old = parseCritique('{"decision":"changes_requested","summary":"gap","findings":[{"severity":"blocking","finding":"no test","criterion":"verify"}]}');
    expect(old).toMatchObject({ decision: "changes_requested", status: "rework" });
    expect(old.verdict.findings[0]).toMatchObject({ severity: "high", file: "" });
  });

  it("a new answer carries status, findings with file and line, and the evidence", () => {
    const parsed = parseCritique(answer("rework", [f({ file: "TASK", line: 1 })]));
    expect(parsed).toMatchObject({ decision: "changes_requested", status: "rework", summary: "reviewed" });
    expect(parsed.findings[0]).toMatchObject({ severity: "blocking", file: "TASK", line: 1 });
    expect(parsed.verdict.evidence).toContain("vitest output");
  });

  it("block stays a block, pass stays a pass, and a blocking finding with no line does not count", () => {
    expect(parseCritique(answer("block", [f()])).status).toBe("block");
    expect(parseCritique(answer("pass", [])).decision).toBe("approve");
    const unlocated = parseCritique(answer("rework", [f({ line: null })]));
    expect(unlocated.demoted).toBe(1);
    expect(unlocated.findings[0]!.severity).toBe("warning");
  });

  it("the prompt asks for the unified answer and counts only findings with file:line", () => {
    const prompt = critiquePrompt({ plan: "p", task: {} });
    expect(prompt).toContain('status ("pass", "rework" or "block")');
    expect(prompt).toMatch(/findings \(at most 30 objects, each with file, line, severity "critical", "high", "medium", "low" or "info", evidence/);
    expect(prompt).toContain("evidence (string, what you examined");
    expect(prompt).toMatch(/block: the task cannot be saved by editing/);
  });
});

describe("code critique: unified verdict, old output still read", () => {
  it("old output keeps its shape and gets a status", () => {
    const old = parseCodeCritique('{"decision":"changes_requested","summary":"gap","findings":[{"id":"f1","severity":"blocking","finding":"missing test","criterion":"verify"}]}');
    expect(old).toMatchObject({ decision: "changes_requested", status: "rework" });
    const warn = parseCodeCritique('{"decision":"changes_requested","summary":"naming","findings":[{"id":"n","severity":"warning","finding":"rename","criterion":"naming"}]}');
    expect(warn).toMatchObject({ decision: "approve", status: "pass" });
  });

  it("rework is the existing repair path: its blocking findings are the ones the writer fixes", () => {
    const parsed = parseCodeCritique(answer("rework", [f(), f({ severity: "medium", line: 30 })]));
    expect(parsed).toMatchObject({ decision: "changes_requested", status: "rework" });
    expect(actionableFindings(parsed)).toHaveLength(1);
    expect(actionableFindings(parsed)[0]).toMatchObject({ path: "src/a.ts", line: 12, severity: "blocking" });
    expect(shouldRequestRepair({ settings, result: parsed, round: 0 })).toBe(true);
  });

  it("block stops: one critical finding, no repair round", () => {
    const parsed = parseCodeCritique(answer("rework", [f({ severity: "critical", finding: "writes the owner's token to the log" })]));
    expect(parsed.status).toBe("block");
    expect(parsed.decision).toBe("changes_requested");
    expect(shouldRequestRepair({ settings, result: parsed, round: 0 })).toBe(false);
  });

  it("a critical unmet requirement is a rework with a repair round; the block is the single-model verdict the PM is told about", () => {
    const parsed = parseCodeCritique(answer("block", [f({ severity: "critical", finding: "acceptance line 2 is unmet: the handler is a stub" })]));
    expect(parsed.status).toBe("rework");
    expect(shouldRequestRepair({ settings, result: parsed, round: 0 })).toBe(true);
    // the round limit ends it: a requirement still unmet after the repair round stops the task
    expect(shouldRequestRepair({ settings, result: parsed, round: settings.maxRounds })).toBe(false);
    const blocked = parseCodeCritique(answer("rework", [f({ severity: "critical", dimension: "security", finding: "writes the owner's token to the log" })]));
    expect(reasonForStatus(blocked.status, "code-critique", blocked, "code_critique_blocked")).toContain("single-model verdict");
  });

  it("more than 5 high findings are a block, five are a rework", () => {
    expect(parseCodeCritique(answer("rework", Array.from({ length: 6 }, (_, i) => f({ line: i + 1 })))).status).toBe("block");
    expect(parseCodeCritique(answer("block", Array.from({ length: 5 }, (_, i) => f({ line: i + 1 })))).status).toBe("rework");
  });

  it("a high finding with no quoted evidence or no line does not count: the answer is a pass", () => {
    const parsed = parseCodeCritique(answer("rework", [f({ line: null }), f({ evidence: "bad" })]));
    expect(parsed).toMatchObject({ status: "pass", decision: "approve", demoted: 2 });
  });

  it("a stored result keeps its status for a replay", () => {
    const stored = { ...parseCodeCritique(answer("rework", [f({ severity: "critical", finding: "writes the owner's token to the log" })])) };
    expect(critiqueFromStageResult(stored)?.status).toBe("block");
    expect(critiqueFromStageResult({ decision: "changes_requested", summary: "s", findings: [{ id: "a", severity: "blocking", finding: "f", criterion: "c" }] })?.status).toBe("rework");
    expect(critiqueFromStageResult({ decision: "approve", summary: "s", findings: [] })?.status).toBe("pass");
  });

  it("the prompt asks for the unified answer, with block and rework told apart", () => {
    const prompt = codeCritiquePrompt({ evidence, task: {} });
    expect(prompt).toContain('status ("pass", "rework" or "block")');
    expect(prompt).toMatch(/block: the task stops/);
    expect(prompt).toMatch(/rework: the writer fixes the findings/);
    expect(prompt).toContain("evidence (string, what you examined");
  });
});

describe("specialist review: unified verdict, old output still read", () => {
  it("old approve is pass; an old block keeps its decision and is a rework (the plan lacks a mitigation), never a stop", () => {
    expect(parseSpecialistResult('{"decision":"approve","summary":"ok","risks":[]}')).toMatchObject({ decision: "approve", status: "pass" });
    expect(parseSpecialistResult('{"decision":"block","summary":"s","risks":[{"severity":"high","path":"a.ts","concern":"c","mitigation":"m"}]}'))
      .toMatchObject({ decision: "block", status: "rework" });
  });

  it("a new answer: block stops, rework sends the plan back, pass goes on; the risks are its serious findings", () => {
    const block = parseSpecialistResult(answer("block", [f({ severity: "critical", file: "scripts/deploy.sh", line: undefined, finding: "deletes the data folder", criterion: "a backup before the delete" })]));
    expect(block).toMatchObject({ decision: "block", status: "block" });
    expect(block.risks[0]).toMatchObject({ severity: "critical", path: "scripts/deploy.sh", concern: "deletes the data folder", mitigation: "a backup before the delete" });
    expect(parseSpecialistResult(answer("rework", [f()]))).toMatchObject({ decision: "block", status: "rework" });
    expect(parseSpecialistResult(answer("pass", []))).toMatchObject({ decision: "approve", status: "pass" });
  });

  it("an unknown severity in an old risk is still refused", () => {
    expect(() => parseSpecialistResult('{"decision":"block","summary":"s","risks":[{"severity":"low","path":"a","concern":"c","mitigation":"m"}]}')).toThrow();
  });

  it("the prompt asks for the unified answer", () => {
    expect(specialistPrompt({ task: {}, plan: "p" })).toContain('status ("pass", "rework" or "block")');
  });
});
