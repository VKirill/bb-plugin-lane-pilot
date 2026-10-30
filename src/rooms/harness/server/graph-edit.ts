import type { Tree } from "@lane-pilot/harness-core";
import { loadWorkflow, type Workflow } from "@lane-pilot/workflow-engine";

const GRAPH_RX = /^workflows\/[a-z0-9][a-z0-9._-]*\.json$/;

function hasExpectPath(workflow: Workflow): boolean {
  const sim = workflow.test?.sim;
  if (!sim || typeof sim !== "object" || Array.isArray(sim)) return false;
  const path = (sim as { expect_path?: unknown }).expect_path;
  return Array.isArray(path) && path.length > 0 && path.every((step) => typeof step === "string" && step.length > 0);
}

/** Engine problems of every workflows/*.json in a tree. Other files are ignored. */
export function graphEditProblems(tree: Tree): string[] {
  const problems: string[] = [];
  for (const [rel, body] of Object.entries(tree)) {
    if (!GRAPH_RX.test(rel)) continue;
    const loaded = loadWorkflow(body);
    if (!loaded.ok) {
      const text = loaded.problems.filter((problem) => problem.level === "error").map((problem) => problem.message).join("; ");
      problems.push(`${rel} is not a workflow the engine accepts: ${text}`);
      continue;
    }
    if (!hasExpectPath(loaded.workflow)) problems.push(`${rel} needs test.sim.expect_path: the nodes the graph test walks`);
  }
  return problems;
}
