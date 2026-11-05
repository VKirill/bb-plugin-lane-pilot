import { describe, expect, it } from "vitest";
import { loadWorkflowStore } from "@lane-pilot/workflow-engine";
import { BUILTIN_SOURCES } from "../src/rooms/workflow/builtin";
import { buildWorkflowMap } from "../src/rooms/workflow/server/workflow-map";

const noRuns = () => ({ runs30d: 0, successRate: null });

async function map() {
  const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES });
  return buildWorkflowMap(store.list(), noRuns, "test-sha");
}

describe("workflow map builder", () => {
  it("lists every built-in graph with a category, and its steps and edges", async () => {
    const { graphs, steps, edges, calls, commit, generatedAt } = await map();
    expect(commit).toBe("test-sha");
    expect(generatedAt).toBeGreaterThan(0);
    expect(graphs.length).toBe(BUILTIN_SOURCES.length);
    expect(steps.length).toBeGreaterThan(0);
    expect(edges.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
    for (const graph of graphs) expect(graph.category.length).toBeGreaterThan(0);

    // Every edge end is a step of its graph or the `start`/`end` marker.
    const stepsByGraph = new Map<string, Set<string>>();
    for (const step of steps) {
      if (!stepsByGraph.has(step.graph)) stepsByGraph.set(step.graph, new Set());
      stepsByGraph.get(step.graph)!.add(step.id);
    }
    for (const edge of edges) {
      const ids = stepsByGraph.get(edge.graph);
      expect(ids, `graph ${edge.graph} has steps`).toBeTruthy();
      for (const end of [edge.from, edge.to]) expect(ids!.has(end) || ["$start", "$end", "start", "end"].includes(end), `${edge.graph}:${end}`).toBe(true);
    }
  });

  it("records the graphs seo-cocoon calls, a subworkflow node and a parallel branch alike", async () => {
    const { calls, steps } = await map();
    const direct = calls.find((call) => call.fromGraph === "seo-cocoon" && call.fromStep === "research");
    const branch = calls.find((call) => call.fromGraph === "seo-cocoon" && call.fromStep === "briefs");
    expect(direct?.toGraph).toBe("seo-research");
    expect(branch?.toGraph).toBe("seo-brief");
    // A step carries its type, role, skills and a clipped prompt.
    const chainsmith = steps.find((step) => step.graph === "seo-cocoon" && step.id === "chainsmith");
    expect(chainsmith?.type).toBe("agent");
    expect(chainsmith?.role).toBe("specialist:seo-specialist");
    expect(chainsmith?.skills).toContain("cocoon-chainsmith");
    expect(chainsmith!.prompt!.length).toBeLessThanOrEqual(200);
  });
});
