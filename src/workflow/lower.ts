import { END, START } from "./schema";
import type { Field, GraphNode, Workflow, WorkflowEdge, WorkflowNode } from "./schema";

/**
 * The authoring spelling to the form the engine runs: explicit edges from `start` and into `end`, `emit` nodes as ordinary
 * nodes with an edge to the exit, and the all-in-one `parallel` (for_each + child + join) as three nodes — the fan-out
 * `<id>:fan`, the branch body `<id>:child` and the join, which keeps the original id so that `<id>.field` still reads the
 * joined result. Pure and idempotent: lowering a lowered workflow changes nothing. Validation and the engine both work on
 * the lowered form, so what is checked is what runs.
 */
export const fanId = (id: string) => `${id}:fan`;
export const childId = (id: string) => `${id}:child`;
export const EMIT = "emit";

const HANDOFF: Field = { name: "handoff", type: "string", required: true, description: "What was done, where the result is, what is left." };

export type ResolveWorkflow = (id: string, version?: number) => Workflow | null;

/** The fields a condition or a reference may read from a node: its declared output (agents always carry a handoff). */
export function outputFields(workflow: Workflow, node: WorkflowNode | typeof START | typeof END | undefined, resolve?: ResolveWorkflow): Field[] | "unknown" {
  if (node === START) return workflow.inputs;
  if (node === END) return workflow.outputs;
  if (!node || node.type === "note") return [];
  if (node.type === "agent") return node.out.some((field) => field.name === "handoff") ? node.out : [...node.out, HANDOFF];
  if (node.type === "decision" && node.out.length === 0 && node.reads_node) {
    const source = workflow.nodes.find((candidate) => candidate.id === node.reads_node);
    return source ? outputFields(workflow, source, resolve) : [];
  }
  if (node.type === "subworkflow" && node.out.length === 0) {
    const child = resolve?.(node.workflow, node.version);
    return child ? child.outputs : "unknown";
  }
  return node.out;
}

/** The key of the executor that runs a node; null when it needs one and has none (an action without a name). */
export function executorKey(node: GraphNode): string | null {
  switch (node.type) {
    case "parallel": return "builtin:parallel";
    case "join": return node.uses ?? "builtin:join";
    case "subworkflow": return "builtin:subworkflow";
    case "decision": return node.uses ?? (node.reads_node ? "builtin:decision" : null);
    case "human": return node.uses ?? "builtin:human";
    case "agent": return node.uses ?? "agent";
    case "lp-task": return node.uses ?? "lp-task";
    case "action": return node.action === EMIT ? (node.uses ?? "builtin:emit") : node.uses ?? node.action ?? null;
  }
}

const isEmit = (node: WorkflowNode): node is Extract<WorkflowNode, { type: "action" }> => node.type === "action" && node.action === EMIT;

export function lowerWorkflow(workflow: Workflow, resolve?: ResolveWorkflow): Workflow {
  const retarget = new Map<string, string>();
  const nodes: WorkflowNode[] = [];
  const extraEdges: WorkflowEdge[] = [];

  for (const node of workflow.nodes) {
    if (node.type === "parallel" && node.child) {
      const { child, join, ...fanBody } = node;
      const fan: WorkflowNode = { ...fanBody, id: fanId(node.id), out: [] };
      const body = { ...child, id: childId(node.id) } as GraphNode;
      const joined: WorkflowNode = {
        id: node.id, type: "join", parallel: fanId(node.id), wait: "all", policy: join?.policy ?? "all", out: join?.out ?? [], maxAttempts: 1,
        ...(join?.uses ? { uses: join.uses } : {}), ...(node.title ? { title: node.title } : {}), ...(node.src ? { src: node.src } : {}),
        ...(node.applicable_modes ? { applicable_modes: node.applicable_modes } : {}), ...(node.skip_when ? { skip_when: node.skip_when } : {}), ...(node.skip_out ? { skip_out: node.skip_out } : {}),
      };
      nodes.push(fan, body, joined);
      retarget.set(node.id, fanId(node.id));
      extraEdges.push({ from: fanId(node.id), to: childId(node.id), pass: "artifact" });
      const childFields = outputFields({ ...workflow, nodes: [body] }, body, resolve);
      extraEdges.push({
        from: childId(node.id), to: node.id, pass: "artifact",
        ...(childFields !== "unknown" && childFields.length ? { with: Object.fromEntries(childFields.map((field) => [field.name, `${childId(node.id)}.${field.name}`])) } : {}),
      });
      continue;
    }
    if (isEmit(node)) {
      const map = node.map ?? {};
      const declared = new Map(workflow.outputs.map((field) => [field.name, field]));
      const out: Field[] = Object.keys(map).map((key) => declared.get(key) ?? { name: key, type: "json", required: false });
      nodes.push({ ...node, uses: node.uses ?? "builtin:emit", out });
      const names = workflow.outputs.length ? Object.keys(map).filter((key) => declared.has(key)) : Object.keys(map);
      extraEdges.push({ from: node.id, to: END, pass: "artifact", ...(names.length ? { with: Object.fromEntries(names.map((name) => [name, `${node.id}.${name}`])) } : {}) });
      continue;
    }
    if (node.type === "subworkflow" && node.out.length === 0) {
      const child = resolve?.(node.workflow, node.version);
      nodes.push(child ? { ...node, out: child.outputs } : node);
      continue;
    }
    nodes.push(node);
  }

  const edges: WorkflowEdge[] = workflow.edges.map((edge) => (retarget.has(edge.to) ? { ...edge, to: retarget.get(edge.to)! } : edge));
  const present = (edge: WorkflowEdge) => edges.some((candidate) => candidate.from === edge.from && candidate.to === edge.to);
  for (const edge of extraEdges) if (!present(edge)) edges.push(edge);
  if (workflow.entry && !edges.some((edge) => edge.from === START)) edges.unshift({ from: START, to: retarget.get(workflow.entry) ?? workflow.entry, pass: "artifact" });
  const { entry: _entry, ...rest } = workflow;
  return { ...rest, nodes, edges };
}
