import { describe, expect, it } from "vitest";
import { taskBrief } from "../../src/rooms/critique/task-brief";
import { critiquePrompt } from "../../src/rooms/critique/critique";
import { specialistPrompt } from "../../src/rooms/critique/specialist";
import { pmReadPrompt } from "../../src/rooms/critique/pm-read";
import { codeCritiquePrompt, codeRepairPrompt, buildCandidateEvidence } from "../../src/rooms/critique/code-critique";

/** A realistic contract with every field a stage could print, plus a secret name and a hidden flag that must never reach a prompt. */
const TASK = {
  schema_version: 2,
  id: "T-9",
  title: "Add rate limit to /login",
  risk: "high",
  lane: "write",
  project_cwd: "/repo",
  read_first: ["src/auth/login.ts", "src/auth/rate-limit.ts"],
  interfaces: ["POST /login"],
  invariants: ["no schema change"],
  out_of_scope: ["the signup flow"],
  expected_outputs: ["src/auth/login.ts"],
  owns_paths: ["src/auth/**"],
  never_touch: ["migrations/**"],
  depends_on: ["T-3"],
  test_removals: ["tests/legacy-login.test.ts"],
  objective: "Throttle repeated login failures per IP.",
  acceptance: ["5 failures in a minute return 429", "existing logins stay unaffected"],
  verify: "tests",
  verification: [{ command: "npx vitest run tests/auth", cwd: "/repo", timeout_sec: 60, secrets: ["DB_PASS"], hidden: true }],
  display_title: "Лимит входов",
};

const EVIDENCE = buildCandidateEvidence({ produced: [], hashes: {}, verification: [], output: "", ownsPaths: [], neverTouch: [], dirtOk: true });

describe("taskBrief prints the contract as readable lines", () => {
  it("the base set: title, objective, acceptance, invariants, out_of_scope, owns_paths; empty fields are absent", () => {
    const brief = taskBrief({ title: "t", objective: "o", acceptance: ["a1"], owns_paths: ["src/**"] });
    expect(brief).toBe("<task_goal>\ntitle: t\nobjective: o\n</task_goal>\n\n<boundaries>\nowns_paths: src/**\n</boundaries>\n\n<acceptance>\nacceptance:\n- a1\n</acceptance>");
    expect(brief).not.toContain("invariants:");
    expect(brief).not.toContain("out_of_scope:");
  });

  it("a requested field prints; one the task does not carry does not", () => {
    const brief = taskBrief(TASK, { fields: ["title", "risk", "depends_on", "test_removals", "verification"] });
    expect(brief).toContain("risk: high");
    expect(brief).toContain("depends_on:\n- T-3");
    expect(brief).toContain("test_removals:\n- tests/legacy-login.test.ts");
    expect(brief).toContain("verification:\n- npx vitest run tests/auth  (cwd: /repo)");
    expect(brief).not.toContain("objective:");
    const thin = taskBrief({ title: "t" }, { fields: ["title", "depends_on", "verification"] });
    expect(thin).toBe("<task_goal>\ntitle: t\n</task_goal>");
  });

  it("verification shows command and cwd only: no secret names, no flags", () => {
    const brief = taskBrief(TASK, { fields: ["verification"] });
    expect(brief).not.toContain("DB_PASS");
    expect(brief).not.toContain("hidden");
    expect(brief).not.toContain("timeout_sec");
  });

  it("a non-object task still degrades to JSON, and an object with no printable fields does too", () => {
    expect(taskBrief("raw")).toBe('"raw"');
    expect(taskBrief({ id: "x" })).toBe('{"id":"x"}');
  });
});

describe("each review stage hands the model a readable task, not the JSON contract", () => {
  const noContractJson = (prompt: string) => {
    expect(prompt).not.toContain('"schema_version"');
    expect(prompt).not.toContain('"owns_paths"');
    expect(prompt).not.toContain('"acceptance"');
    expect(prompt).toContain("TASK BRIEF:");
    expect(prompt).toContain("title: Add rate limit to /login");
    expect(prompt).toContain("objective: Throttle repeated login failures per IP.");
    expect(prompt).toContain("- 5 failures in a minute return 429");
    expect(prompt).not.toContain("DB_PASS");
  };

  it("plan critique: the fields it judges, including verification commands and depends_on", () => {
    const prompt = critiquePrompt({ plan: "plan text", task: TASK });
    noContractJson(prompt);
    expect(prompt).toContain("risk: high");
    expect(prompt).toContain("read_first:\n- src/auth/login.ts");
    expect(prompt).toContain("expected_outputs:\n- src/auth/login.ts");
    expect(prompt).toContain("depends_on:\n- T-3");
    expect(prompt).toContain("test_removals:\n- tests/legacy-login.test.ts");
    expect(prompt).toContain("verification:\n- npx vitest run tests/auth  (cwd: /repo)");
  });

  it("specialist: the risk surface, not the check commands", () => {
    const prompt = specialistPrompt({ task: TASK, plan: "plan text" });
    noContractJson(prompt);
    expect(prompt).toContain("risk: high");
    expect(prompt).toContain("expected_outputs:\n- src/auth/login.ts");
    expect(prompt).toContain("depends_on:\n- T-3");
    expect(prompt).not.toContain("npx vitest run tests/auth");
  });

  it("pm-read: what the task wants and the files it reads, no check commands", () => {
    const prompt = pmReadPrompt({ agent: "pm-read", packet: "excerpt", task: TASK });
    noContractJson(prompt);
    expect(prompt).toContain("read_first:\n- src/auth/login.ts");
    expect(prompt).toContain("expected_outputs:\n- src/auth/login.ts");
    expect(prompt).not.toContain("risk:");
    expect(prompt).not.toContain("npx vitest run tests/auth");
  });

  it("writer repair: title, objective, acceptance and owns_paths only", () => {
    const prompt = codeRepairPrompt({ task: TASK, findings: [] });
    noContractJson(prompt);
    expect(prompt).toContain("owns_paths: src/auth/**");
    expect(prompt).not.toContain("risk:");
    expect(prompt).not.toContain("invariants:");
    expect(prompt).not.toContain("npx vitest run tests/auth");
    expect(prompt).not.toContain("migrations/**");
  });

  it("code critique keeps its base set inside <task>", () => {
    const prompt = codeCritiquePrompt({ evidence: EVIDENCE, task: TASK });
    expect(prompt).toContain("<task>\n<task_goal>\ntitle: Add rate limit to /login\nobjective: Throttle repeated login failures per IP.");
    expect(prompt).toContain("- no schema change"); // invariants stay in the code critic's set
    expect(prompt).toContain("never_touch (on top of the standard trusted tooling): migrations/**");
    expect(prompt).not.toContain('"schema_version"');
    expect(prompt).not.toContain("npx vitest run tests/auth  (cwd: /repo)"); // verification commands are not in the base set
  });
});
