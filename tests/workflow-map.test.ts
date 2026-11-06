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

it("keeps only the map's two counters when the library hands over its full stats row", async () => {
  const { rpcContract } = await import("../src/rooms/contracts");
  const { parseWorkflowObject } = await import("@lane-pilot/workflow-engine");
  const { BUILTIN_SOURCES } = await import("../src/rooms/workflow/builtin");
  const items = BUILTIN_SOURCES.slice(0, 3).map((source) => ({ workflow: parseWorkflowObject(source.value).data, origin: "builtin" })) as never;
  const fullStats = () => ({ runs: 4, succeeded: 3, failed: 1, active: 0, runs30d: 2, successRate: 0.75, lastRunAt: 1, lastStatus: "done" }) as never;
  const data = { ...buildWorkflowMap(items, fullStats, "v"), project: "not_requested" as const };
  expect(rpcContract.workflow_map.output.safeParse(data).success).toBe(true);
});

it("lays the built-in library out twice — uniform chips and step frames — clusters never overlap, titles fit", async () => {
  const { layoutMap, CHIP_W, CHIP_H } = await import("../src/rooms/workflow/ui/workflow-map");
  const data = await map();
  const layout = await layoutMap(data, "ru");
  expect(layout.categories.length).toBeGreaterThan(3);
  for (const mode of ["overview", "detail"] as const) {
    const nodes = layout[mode].nodes;
    const box = (id: string) => {
      const node = nodes.find((item) => item.id === id)!;
      const parent = node.parentId ? nodes.find((item) => item.id === node.parentId)! : null;
      const x = node.position.x + (parent?.position.x ?? 0), y = node.position.y + (parent?.position.y ?? 0);
      return { x, y, w: Number(node.style!.width), h: Number(node.style!.height) };
    };
    const apart = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
    const cats = nodes.filter((node) => node.type === "category").map((node) => box(node.id));
    const cells = nodes.filter((node) => node.type === "graphGroup");
    expect(cells.length).toBe(data.graphs.length);
    for (let i = 0; i < cats.length; i++) for (let j = i + 1; j < cats.length; j++) expect(apart(cats[i]!, cats[j]!)).toBe(true);
    const boxes = cells.map((node) => box(node.id));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(apart(boxes[i]!, boxes[j]!)).toBe(true);
    // A cluster is at least as wide as its one-line title (≈0.64 em per character at 170 px).
    for (const node of nodes.filter((item) => item.type === "category")) {
      expect(Number(node.style!.width)).toBeGreaterThanOrEqual(String(node.data.label).length * 170 * 0.64);
    }
    if (mode === "overview") {
      // One size for every chip, whatever its step count; no steps drawn.
      expect(new Set(cells.map((node) => `${node.style!.width}x${node.style!.height}`))).toEqual(new Set([`${CHIP_W}x${CHIP_H}`]));
      expect(nodes.some((node) => node.type === "step")).toBe(false);
    } else {
      for (const node of nodes.filter((item) => item.type === "step")) {
        const cell = nodes.find((item) => item.id === node.parentId)!;
        expect(node.position.x + Number(node.style!.width)).toBeLessThanOrEqual(Number(cell.style!.width) + 1);
        expect(node.position.y + Number(node.style!.height)).toBeLessThanOrEqual(Number(cell.style!.height) + 1);
      }
    }
  }
}, 60_000);

it("hover and search keep every unrelated node and edge object identical (nothing re-measures, nothing blinks)", async () => {
  const { layoutMap, viewNodes, viewEdges } = await import("../src/rooms/workflow/ui/workflow-map");
  const layout = await layoutMap(await map(), "ru");
  for (const mode of ["overview", "detail"] as const) {
    const base = viewNodes(layout, mode, new Set());
    base.forEach((node, index) => expect(node).toBe(layout[mode].nodes[index]));
    // Search dims one graph: only that node is a new object.
    const one = base.find((node) => node.type === "graphGroup")!;
    const dimmed = viewNodes(layout, mode, new Set([one.id]));
    dimmed.forEach((node, index) => (node.id === one.id ? expect(node).not.toBe(base[index]) : expect(node).toBe(base[index])));
    // Hover lights only the calls of that graph.
    const call = layout.callEdges[0]!;
    const still = viewEdges(layout, mode, [null]);
    const lit = viewEdges(layout, mode, [call.data!.from as string]);
    lit.forEach((edge, index) => {
      const mine = edge.data?.from === call.data!.from || edge.data?.to === call.data!.from;
      if (mine) expect(edge.style!.opacity).toBe(0.9); else expect(edge).toBe(still[index]);
    });
  }
}, 60_000);

it("hyphenates long Russian words at syllables, leaves short and Latin words alone", async () => {
  const { softHyphens } = await import("../src/rooms/workflow/ui/workflow-map");
  const show = (text: string) => softHyphens(text).replace(/­/g, "-");
  expect(show("Исследовательский пакет SEO")).toBe("Ис-сле-до-ва-тель-ский пакет SEO");
  expect(show("Семантический кокон (Cocoon Engine X4)")).toBe("Се-ман-ти-чес-кий кокон (Cocoon Engine X4)");
  expect(show("Review and fix")).toBe("Review and fix");
});
