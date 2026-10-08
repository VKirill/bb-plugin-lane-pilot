import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repairPrompt } from "../../src/rooms/self-repair/server/self-repair";
import { qaThreadPrompt } from "../../src/rooms/qa/server/qa-thread";
import { buildCandidateEvidence, codeCritiquePrompt } from "../../src/rooms/critique/code-critique";
import { critiquePrompt } from "../../src/rooms/critique/critique";
import { CODE_CRITIC_METHOD, FAILURE_TRIAGE_METHOD, FRONTEND_VERIFY_METHOD, PLAN_CRITIC_METHOD, SCIENTIFIC_DEBUG_METHOD } from "../../src/rooms/critique/role-method";

const evidence = buildCandidateEvidence({ produced: [], hashes: {}, verification: [], output: "", ownsPaths: [], neverTouch: [], dirtOk: true });
const workspace = { path: "/wt/r/lane-pilot", branch: "lane/r", basePath: "/repo/lane-pilot" };
/** Commands and tools of the Maestro-Flow runtime that Lane Pilot does not have: its text must not send a role to look for them. */
const MAESTRO_ONLY = /maestro|AskUserQuestion|spawn_agents|workflow-(planner|reviewer|plan-checker)|chrome-devtools|e2e-results|evidence\.ndjson|\.workflow\//i;

describe("K1: role texts adapted from Maestro-Flow", () => {
  it("plan critic: reads read_first, wants checkable criteria without subjective words, ignores a finding or a question without file:line", () => {
    const prompt = critiquePrompt({ plan: "p", task: {} });
    expect(prompt).toContain("read_first");
    expect(prompt).toContain("subjective words");
    expect(prompt).toMatch(/exit code/);
    expect(prompt).toMatch(/without a file:line does not count/);
    expect(prompt).toContain("15 to 60 minutes");
    expect(prompt).toContain("PM read context");
    expect(prompt).not.toMatch(MAESTRO_ONLY);
  });

  it("code critic: three acceptance layers, anti-patterns, six dimensions, BLOCK/REWORK/PASS, a single-reviewer self-check (no vote) for critical and high", () => {
    const prompt = codeCritiquePrompt({ evidence, task: {} });
    for (const layer of ["existence", "substance", "wiring"]) expect(prompt).toContain(layer);
    expect(prompt).toMatch(/Anti-patterns/);
    expect(prompt).toMatch(/placeholder/i);
    expect(prompt).toMatch(/six: correctness.*security.*performance.*architecture.*maintainability.*best practices/);
    expect(prompt).toMatch(/BLOCK: a critical finding that is a security hole, data loss or a break of a rule the task forbids, or more than 5 high/);
    expect(prompt).toMatch(/REWORK: a critical unmet or stubbed requirement \(the writer repairs it first\), or 1 to 5 high/);
    expect(prompt).toMatch(/PASS: no critical and no high/);
    expect(prompt).not.toMatch(/at least 2 of the 3|Majority of three/);
    expect(prompt).toMatch(/this is not a vote and you must not write a tally/);
    expect(prompt).toMatch(/no quoted code at a file:line is not accepted/);
    expect(prompt).toMatch(/what the candidate implements/);
    expect(prompt).not.toMatch(MAESTRO_ONLY);
  });

  it("self-repair: scientific debugging with at most 3 hypotheses, each with evidence, and the failure triage", () => {
    const text = repairPrompt([], "blocked:abc:x", workspace);
    expect(text).toMatch(/No fix without a confirmed root cause/);
    expect(text).toMatch(/at most 3 hypotheses/);
    expect(text).toMatch(/the evidence you gathered/);
    expect(text).toMatch(/After 3 refuted hypotheses/);
    for (const kind of ["test_defect", "code_defect", "env_issue"]) expect(text).toContain(kind);
    expect(text).not.toMatch(MAESTRO_ONLY);
    expect(text.trim().split("\n").at(-3)).toMatch(/SELF-REPAIR-VERDICT: fixed \| already-fixed \| not-lane-pilot \| needs-owner/);
  });

  it("browser check: three layers per feature, an unasserted case is blocked, never passed", () => {
    const prompt = qaThreadPrompt({ url: "http://localhost:3000/", cases: ["Loads"], viewports: "375", envClass: "local", authorized: false, qaHostId: "h" });
    expect(prompt).toMatch(/three layers/);
    expect(prompt).toMatch(/entry point/);
    expect(prompt).toMatch(/Silence is never a pass/);
    expect(prompt).toMatch(/blocked, never passed/);
    expect(prompt).not.toMatch(MAESTRO_ONLY);
  });

  it("every method block is plain text lines and none names a Maestro command", () => {
    for (const block of [PLAN_CRITIC_METHOD, CODE_CRITIC_METHOD, SCIENTIFIC_DEBUG_METHOD, FAILURE_TRIAGE_METHOD, FRONTEND_VERIFY_METHOD]) {
      expect(block.length).toBeGreaterThan(0);
      for (const line of block) expect(line).not.toMatch(MAESTRO_ONLY);
    }
  });

  it("THIRD_PARTY_NOTICES.md carries the MIT notice and lists the files with adapted text", () => {
    const notices = readFileSync(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
    expect(notices).toContain("catlog22/maestro-flow");
    expect(notices).toContain("Permission is hereby granted, free of charge");
    for (const file of ["src/rooms/critique/role-method.ts", "src/rooms/critique/critique.ts", "src/rooms/critique/code-critique.ts", "src/rooms/self-repair/server/self-repair.ts", "src/rooms/qa/server/qa-thread.ts"]) expect(notices).toContain(file);
  });
});
