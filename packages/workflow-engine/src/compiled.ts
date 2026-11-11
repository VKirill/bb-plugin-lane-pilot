import { toExpr } from "./expr";
import type { Expr } from "./expr";
import { START } from "./schema";
import type { GraphNode as WorkflowNode, Workflow, WorkflowEdge } from "./schema";

export type Out = Array<{ edge: WorkflowEdge; index: number }>;
export type Compiled = {
  wf: Workflow; nodes: Map<string, WorkflowNode>; out: Map<string, Out>;
  /** Conditions parsed once, by edge index and by node id (skip_when). */
  when: Map<number, Expr>; skip: Map<string, Expr>;
  joinOf: Map<string, Extract<WorkflowNode, { type: "join" }>>;
};

export function compile(wf: Workflow): Compiled {
  const nodes = new Map<string, WorkflowNode>(wf.nodes.filter((node): node is WorkflowNode => node.type !== "note").map((node) => [node.id, node]));
  const out = new Map<string, Out>();
  const when = new Map<number, Expr>(), skip = new Map<string, Expr>();
  wf.edges.forEach((edge, index) => {
    const list = out.get(edge.from) ?? []; list.push({ edge, index }); out.set(edge.from, list);
    if (edge.when !== undefined && edge.from !== START) when.set(index, toExpr(edge.when, edge.from));
  });
  for (const node of nodes.values()) if (node.skip_when !== undefined) skip.set(node.id, toExpr(node.skip_when, node.id));
  const joinOf = new Map<string, Extract<WorkflowNode, { type: "join" }>>();
  for (const node of nodes.values()) if (node.type === "join") joinOf.set(node.parallel, node);
  return { wf, nodes, out, when, skip, joinOf };
}
