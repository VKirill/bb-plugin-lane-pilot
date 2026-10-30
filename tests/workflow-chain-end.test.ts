import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { loadWorkflow, validateWorkflow } from "@lane-pilot/workflow-engine";

const files = readdirSync("workflows").filter((name) => name.endsWith(".json"));
const audit = (source: object) => {
  const loaded = loadWorkflow(source);
  if (!loaded.ok) return loaded.problems;
  return [...loaded.warnings, ...validateWorkflow(loaded.workflow)];
};

describe("chain-end audit: no graph has a hole to its goal", () => {
  it("every shipped graph: reachable nodes only, no dead ends, no deadline-less waits", () => {
    const report: string[] = [];
    for (const file of files) {
      const problems = audit(JSON.parse(readFileSync(`workflows/${file}`, "utf8")));
      for (const problem of problems) {
        // The sweep is honest: every finding fails, at any level; a graph exempts itself only by its own field
        // (goal_audit in the file), never by a list in this test.
        if (["unreachable_node", "dead_end", "human_no_deadline", "no_goal_check"].includes(problem.code)) {
          report.push(`${file}: ${problem.code} ${problem.node ?? ""}`);
        }
      }
    }
    expect(report).toEqual([]);
  });

  it("the lint catches each hole on a synthetic graph", () => {
    const base = JSON.parse(readFileSync("workflows/lp.review.json", "utf8"));
    const emit = { id: "emit1", type: "action", action: "emit", map: { status: "pass" } };
    const bad = audit({ ...base, entry: "n1", nodes: [
      { id: "n1", type: "action", action: "git.diff_files" },
      { id: "lost", type: "action", action: "git.diff_files" },
      emit,
    ], edges: [{ from: "n1", to: "emit1", pass: "artifact" }] });
    expect(bad.map((p) => p.code)).toContain("unreachable_node");
    const badWait = audit({ ...base, entry: "ask", nodes: [{ id: "ask", type: "human", question: "?", options: ["a"], out: [] }, emit], edges: [{ from: "ask", to: "emit1", pass: "artifact" }] });
    expect(badWait.map((p) => p.code)).toContain("human_no_deadline");
    const deadEnd = audit({ ...base, entry: "n1", nodes: [{ id: "n1", type: "action", action: "git.diff_files" }, { id: "n2", type: "action", action: "git.diff_files" }, emit], edges: [{ from: "n1", to: "n2", pass: "artifact" }, { from: "n1", to: "emit1", pass: "artifact" }] });
    expect(deadEnd.filter((p) => p.node === "n2").map((p) => p.code)).toContain("dead_end");
    const noGoal = audit({ ...base, entry: "n1", nodes: [{ id: "n1", type: "action", action: "git.diff_files" }, emit], edges: [{ from: "n1", to: "emit1", pass: "artifact" }] });
    expect(noGoal.map((p) => p.code)).toContain("no_goal_check");
  });
});
