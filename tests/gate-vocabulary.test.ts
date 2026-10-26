import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { literalCoverage } from "@lane-pilot/kit";
import { EXISTENCE_ONLY_WORDS, isExistenceOnly } from "../src/rooms/baseline/logic";
import { taskV2Schema } from "../src/rooms/contracts";
import { GATE_CODES, gateVocabularyLines } from "../src/rooms/tasks/gate-vocabulary";
import { INVARIANT_ITEM, INVARIANT_WORDS } from "../src/rooms/tasks/plan-fact";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { writerBriefSegments, writerPrompt } from "../src/rooms/writer/server/writer-task";

const task = taskV2Schema.parse({
  schema_version: 2, id: "t1", title: "t", risk: "low", lane: "writer", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["a.txt"], owns_paths: ["a.txt"], never_touch: [], depends_on: [], objective: "o", acceptance: ["a.txt exists"], verify: "tests", verification: [],
});
const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

/** Every word a gate decides by. */
const GATE_WORDS = [...INVARIANT_WORDS, ...EXISTENCE_ONLY_WORDS, ...Object.keys(GATE_CODES)];

describe("the gate vocabulary is made of the constants the gates read", () => {
  it("every invariant word is read by the pattern, every existence-only word by the red-check rule", () => {
    for (const word of INVARIANT_WORDS) expect(INVARIANT_ITEM.test(`Bar ${word} here`), word).toBe(true);
    for (const word of EXISTENCE_ONLY_WORDS) expect(isExistenceOnly(`${word} src/a.ts`), word).toBe(true);
    // and the gates do not read ordinary words
    expect(INVARIANT_ITEM.test("The bar is centred and has 12 pt margins")).toBe(false);
    expect(isExistenceOnly("npx vitest run tests/a.test.ts")).toBe(false);
  });

  it("every code is a code the lint or the baseline really writes", () => {
    const source = [read("src/rooms/tasks/server/contract-lint.ts"), read("src/rooms/baseline/server/baseline.ts"), read("src/rooms/writer/server/question-timeout.ts")].join("\n");
    for (const code of Object.keys(GATE_CODES)) expect(source, code).toContain(code);
  });
});

describe("the judged agents are told every gate word", () => {
  it("the writer's brief names every word of the two rules that judge its answer and its checks", () => {
    const brief = writerBriefSegments(task).map((segment) => segment.text);
    expect(literalCoverage([...INVARIANT_WORDS, ...EXISTENCE_ONLY_WORDS], brief).missing).toEqual([]);
    expect(writerPrompt(task)).toContain(gateVocabularyLines("writer").join("\n"));
    // the contract's codes are the planner's: a writer never writes a contract
    expect(gateVocabularyLines("writer").join("\n")).not.toContain("check_cannot_run");
  });

  it("the planner's instructions (lp.plan, where acceptance items are written) name all of them", () => {
    const plan = builtinWorkflow("lp.plan")!;
    const prompt = (plan.nodes.find((node) => node.id === "plan") as { prompt: string }).prompt;
    expect(literalCoverage(GATE_WORDS, prompt).missing).toEqual([]);
    expect(prompt).toContain(gateVocabularyLines().join("\n"));
    // the workflow file itself is untouched: the block is added where the built-ins load
    expect(read("workflows/lp.plan.json")).not.toContain("Gate vocabulary");
  });

  it("the block is short enough to ride in every brief", () => {
    expect(gateVocabularyLines().join("\n").length).toBeLessThan(2600);
    expect(gateVocabularyLines("writer").join("\n").length).toBeLessThan(1100);
  });
});
