import { describe, expect, it } from "vitest";
import { artifactEnums, loadWorkflow, outputContract, promptCoverageProblems } from "@lane-pilot/workflow-engine";

const SEVERITY = "#/properties/findings/items/properties/severity/enum";

/** A two-node chain whose agent step has the given prompt and out fields. */
const chain = (prompt: string, produces: Array<{ kind: string; version: number }>, out: Array<Record<string, unknown>>) => ({
  id: "t", name: { en: "t", ru: "t" }, description: { en: "t", ru: "t" }, version: 1, status: "draft", scope: { level: "global" },
  nodes: [
    { id: "scan", type: "agent", role: "reviewer", prompt, out, produces },
    { id: "done", type: "action", action: "emit", map: {} },
  ],
  edges: [{ from: "start", to: "scan" }, { from: "scan", to: "done" }],
});
const warningsOf = (definition: unknown) => {
  const loaded = loadWorkflow(definition);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.problems));
  return loaded.warnings.filter((problem) => problem.code === "prompt_vocabulary");
};

describe("prompt vocabulary of a workflow step", () => {
  it("reads the enums of an artifact kind out of its schema", () => {
    expect(artifactEnums("verdict", 1).map((group) => group.path)).toEqual(["#/properties/status/enum", SEVERITY]);
    expect(artifactEnums("report", 1)).toEqual([]);
    expect(artifactEnums("no-such-kind", 1)).toEqual([]);
  });

  it("warns for the severity words a prompt leaves out, naming the missing ones", () => {
    const warnings = warningsOf(chain("Review the code. Severity is critical or high.", [{ kind: "findings", version: 1 }], [{ name: "findings", type: "array", ref: "Finding" }]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warning", node: "scan" });
    expect(warnings[0]!.message).toContain(`produces findings/1, which accepts critical | high | medium | low | info at ${SEVERITY}`);
    expect(warnings[0]!.message).toContain('does not name "medium", "low", "info"');
  });

  it("says nothing once the prompt names every member", () => {
    expect(warningsOf(chain("Severity is one of critical, high, medium, low, info.", [{ kind: "findings", version: 1 }], [{ name: "findings", type: "array" }]))).toEqual([]);
  });

  it("does not ask the prompt for the members of a step's own enum fields: the engine's contract lists them", () => {
    const fields = [{ name: "status", type: "enum", values: ["pass", "rework", "block"], required: true }];
    expect(outputContract(fields as never)).toContain('"pass" | "rework" | "block"');
    const prompt = "Judge the work. Severity is one of critical, high, medium, low, info.";
    expect(warningsOf(chain(prompt, [{ kind: "verdict", version: 1 }], [{ name: "status", type: "enum", values: ["pass", "rework", "block"] }, { name: "findings", type: "array" }]))).toEqual([]);
    // The same prompt without a declared status field gets no help from the contract for the artifact's own status words.
    const bare = promptCoverageProblems({ id: "s", prompt, produces: [{ kind: "verdict", version: 1 }] }, []);
    expect(bare).toHaveLength(1);
    // "block" is in the contract's own words (a fenced JSON block), and a mention anywhere counts: the match is on whole words, not on meaning.
    expect(bare[0]).toContain('does not name "pass", "rework"');
  });

  it("checks nothing for a step that produces no artifact kind with enums", () => {
    expect(warningsOf(chain("Do it.", [{ kind: "report", version: 1 }], []))).toEqual([]);
  });
});
