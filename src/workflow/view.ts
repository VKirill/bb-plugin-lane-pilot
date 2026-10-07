import type { z } from "zod";
import type { workflowViewSchema } from "../contracts";
import { lowerWorkflow, type ResolveWorkflow } from "./lower";
import { END, START, type Condition, type Workflow, type WorkflowEdge, type WorkflowNode } from "./schema";

/**
 * What a screen needs to draw a workflow: the lowered graph (the form that runs, so a run's step node ids and edge indexes
 * match it) reduced to plain data. Prompts are cut to an excerpt; the file stays the place to read the rest.
 */
export type WorkflowView = z.infer<typeof workflowViewSchema>;
export type ViewNode = WorkflowView["nodes"][number];
export type ViewEdge = WorkflowView["edges"][number];
export type NodeTone = ViewNode["tone"];

const EXCERPT = 160;

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const cut = (text: string, max = EXCERPT) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The colour family of an agent by what its role does: plan blue, build green, QA orange, review violet. */
export function roleTone(role: string | null | undefined): NodeTone {
  const name = (role ?? "").toLowerCase();
  if (/review|critic|judge|audit|verdict/.test(name)) return "review";
  if (/qa|test|check|verif|browser/.test(name)) return "qa";
  if (/plan|analy|research|read|search|scout|discover/.test(name)) return "plan";
  if (/build|writ|work|code|implement|fix|develop|edit/.test(name)) return "build";
  return "agent";
}

const OPS: Record<string, string> = { eq: "==", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", in: "in", notIn: "not in" };
const literal = (value: unknown) => (typeof value === "string" ? `'${value}'` : JSON.stringify(value));

/** A condition as the text an owner reads: `verdict == 'rework'`, `a && b`, `!(…)`. */
export function conditionText(when: Condition | string | undefined): string | null {
  if (when === undefined) return null;
  if (typeof when === "string") return flat(when);
  if ("all" in when) return when.all.map((part) => groupText(part)).join(" && ");
  if ("any" in when) return when.any.map((part) => groupText(part)).join(" || ");
  if ("not" in when) return `!(${conditionText(when.not)})`;
  if (when.op === "exists") return `${when.field} exists`;
  return `${when.field} ${OPS[when.op] ?? when.op} ${literal(when.value)}`;
}
const groupText = (part: Condition) => ("all" in part || "any" in part ? `(${conditionText(part)})` : conditionText(part)!);

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
