import type { WorkflowInput } from "../../src/workflow/schema";

type Node = Record<string, unknown>;
type Edge = Record<string, unknown>;

/** A small valid workflow; tests change one thing at a time. */
export function workflow(extra: Partial<Record<string, unknown>> & { nodes?: Node[]; edges?: Edge[] } = {}): WorkflowInput {
  return {
    schemaVersion: 1, id: "demo", name: "Demo",
    description: { en: "A demo chain", ru: "Учебная цепочка" },
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    nodes: [
      { id: "search", type: "action", action: "search", output: [{ name: "items", type: "array" }, { name: "count", type: "number" }, { name: "kind", type: "enum", values: ["fresh", "stale"] }] },
      { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] },
    ],
    edges: [
      { from: "start", to: "search", with: { query: "input.query" } },
      { from: "search", to: "write", with: { items: "search.items" } },
      { from: "write", to: "end", with: { result: "write.text" } },
    ],
    ...extra,
  } as WorkflowInput;
}

export const codes = (problems: Array<{ code: string; level: string }>, level: "error" | "warning" = "error") =>
  problems.filter((problem) => problem.level === level).map((problem) => problem.code);
