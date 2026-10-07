import { lowerWorkflow, type ResolveWorkflow } from "./lower";
import { END, START, type Workflow, type WorkflowEdge, type WorkflowNode } from "./schema";
import { conditionText, cut, flat, roleTone, type ViewEdge, type ViewNode, type WorkflowView } from "./view-core";

export { conditionText, roleTone };
export type { NodeTone, ViewEdge, ViewNode, WorkflowView } from "./view-core";

/**
 * What a screen needs to draw a workflow: the lowered graph (the form that runs, so a run's step node ids and edge indexes
 * match it) reduced to plain data. Prompts are cut to an excerpt; the file stays the place to read the rest.
 */
const EXCERPT = 160;

function viewNode(node: WorkflowNode): ViewNode {
  const base: ViewNode = {
    id: node.id, kind: node.type, tone: "agent", title: null, label: null, role: null, excerpt: null, uses: null,
    out: [], maxVisits: null, stages: [], calls: null, modes: null,
  };
  if (node.type === "note") return { ...base, tone: "note", excerpt: cut(flat(node.text), 400) || null };
  const common = {
    title: node.title ?? null, label: node.label ?? null, uses: node.uses ?? null, out: node.out.map((field) => field.name),
    maxVisits: node.maxVisits ?? null, modes: node.applicable_modes ?? null,
  };
  switch (node.type) {
    case "agent": return { ...base, ...common, tone: roleTone(node.role), role: node.role, excerpt: node.prompt ? cut(flat(node.prompt)) : null };
    case "lp-task": return { ...base, ...common, tone: "build", role: "writer", stages: node.stages };
    case "action": return { ...base, ...common, tone: "action", excerpt: node.action ?? null };
    case "decision": return { ...base, ...common, tone: "decision", excerpt: node.reads_node ? `← ${node.reads_node}` : null };
    case "human": return { ...base, ...common, tone: "human", role: node.role ?? null, excerpt: cut(flat(node.question)) };
    case "parallel": return { ...base, ...common, tone: "flow", excerpt: typeof node.for_each === "string" ? `for each ${node.for_each}` : node.for_each ? "for each" : null };
    case "join": return { ...base, ...common, tone: "flow", excerpt: `← ${node.parallel}` };
    case "subworkflow": return { ...base, ...common, tone: "sub", calls: { id: node.workflow, version: node.version ?? null } };
  }
}

const sentinel = (id: string): ViewNode => ({
  id, kind: id === START ? "start" : "end", tone: "terminal", title: null, label: id === START ? "start" : "end", role: null, excerpt: null, uses: null,
  out: [], maxVisits: null, stages: [], calls: null, modes: null,
});

const viewEdge = (edge: WorkflowEdge, index: number): ViewEdge => ({
  index, from: edge.from, to: edge.to, when: conditionText(edge.when), label: edge.label ?? null, pass: edge.pass,
  carries: Object.keys(edge.with ?? {}),
});

/** Lowered, because that is what runs: `<id>:fan` and `<id>:child` appear for a `for_each` parallel, `start` and `end` are explicit. */
export function workflowView(workflow: Workflow, resolve?: ResolveWorkflow): WorkflowView {
  const lowered = lowerWorkflow(workflow, resolve);
  const used = new Set(lowered.edges.flatMap((edge) => [edge.from, edge.to]));
  const nodes = lowered.nodes.map(viewNode);
  if (used.has(START)) nodes.unshift(sentinel(START));
  if (used.has(END)) nodes.push(sentinel(END));
  return { nodes, edges: lowered.edges.map(viewEdge) };
}
