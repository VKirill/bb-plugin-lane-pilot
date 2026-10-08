import { z } from "zod";
import { loadWorkflow } from "./validate";
import type { ValidateOptions, WorkflowProblem } from "./validate";

/**
 * A workflow draft is the same value as a workflow file in the authoring spelling (`normalizeWorkflow` reads it), kept
 * while it is built. The architect changes it with small operations; every change is checked by the workflow validator
 * and the problems come back, but an unfinished draft is still saved: a graph is invalid for most of the time it is
 * being assembled. Only an operation that cannot be applied at all (a node that does not exist, an id taken) is refused.
 */
export type RawDefinition = Record<string, unknown>;

const rawObject = z.record(z.string(), z.unknown());
const nodeRef = z.string().min(1).max(48);

export const edgeSelector = z.object({
  index: z.number().int().min(0).optional(),
  from: z.string().min(1).max(48).optional(),
  to: z.string().min(1).max(48).optional(),
  when: z.unknown().optional(),
}).strict().refine((value) => value.index !== undefined || (value.from !== undefined && value.to !== undefined), "an edge is named by index, or by from and to");
export type EdgeSelector = z.infer<typeof edgeSelector>;

export const draftOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: rawObject }).strict(),
  z.object({ op: z.literal("update_node"), id: nodeRef, set: rawObject.default({}), unset: z.array(z.string().min(1).max(60)).max(30).optional() }).strict(),
  z.object({ op: z.literal("remove_node"), id: nodeRef, cascade: z.boolean().default(true) }).strict(),
  z.object({ op: z.literal("add_edge"), edge: rawObject }).strict(),
  z.object({ op: z.literal("update_edge"), edge: edgeSelector, set: rawObject.default({}), unset: z.array(z.string().min(1).max(60)).max(10).optional() }).strict(),
  z.object({ op: z.literal("remove_edge"), edge: edgeSelector }).strict(),
  z.object({ op: z.literal("set_meta"), set: rawObject }).strict(),
]);
export type DraftOp = z.input<typeof draftOpSchema>;

/** What `set_meta` may change: everything of a workflow but its graph, its version and its status (those have their own ways). */
export const META_KEYS = ["id", "name", "description", "examples", "not_for", "tags", "internal", "inputs", "outputs", "requires", "budget", "guards", "quality_mode",
  "triggers", "entry", "test", "common_inputs", "ui"] as const;
const META_SET = new Set<string>(META_KEYS);

export type Refusal = { index: number; op: string; reason: string };
export type AppliedOps = { ok: true; definition: RawDefinition; changes: string[] } | { ok: false; refused: Refusal[] };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sentinel = (id: unknown): unknown => (id === "$start" ? "start" : id === "$end" ? "end" : id);

const nodesOf = (definition: RawDefinition): Array<Record<string, unknown>> => (Array.isArray(definition.nodes) ? definition.nodes as Array<Record<string, unknown>> : []);
const edgesOf = (definition: RawDefinition): Array<Record<string, unknown>> => (Array.isArray(definition.edges) ? definition.edges as Array<Record<string, unknown>> : []);

/** Indexes of the edges a selector names. */
function selectEdges(definition: RawDefinition, selector: EdgeSelector): number[] {
  const edges = edgesOf(definition);
  if (selector.index !== undefined) return selector.index < edges.length ? [selector.index] : [];
  return edges.flatMap((edge, index) => {
    if (sentinel(edge.from) !== sentinel(selector.from) || sentinel(edge.to) !== sentinel(selector.to)) return [];
    if (selector.when !== undefined && JSON.stringify(edge.when) !== JSON.stringify(selector.when)) return [];
    return [index];
  });
}

const edgeLabel = (edge: Record<string, unknown>) => `${String(edge.from)} -> ${String(edge.to)}`;

/** Applies operations in order to a copy. One that cannot be applied refuses the whole patch, and nothing is changed. */
export function applyDraftOps(definition: RawDefinition, ops: readonly DraftOp[]): AppliedOps {
  const next = clone(definition);
  next.nodes = nodesOf(next);
  next.edges = edgesOf(next);
  const nodes = next.nodes as Array<Record<string, unknown>>;
  const edges = next.edges as Array<Record<string, unknown>>;
  const changes: string[] = [];
  const refused: Refusal[] = [];

  ops.forEach((op, index) => {
    const refuse = (reason: string) => { refused.push({ index, op: op.op, reason }); };
    switch (op.op) {
      case "add_node": {
        const id = op.node.id, type = op.node.type;
        if (typeof id !== "string" || !id) return refuse("node.id is required");
        if (typeof type !== "string" || !type) return refuse("node.type is required (agent, lp-task, action, decision, human, parallel, join, subworkflow, note)");
        if (nodes.some((node) => node.id === id)) return refuse(`node "${id}" already exists; use update_node`);
        nodes.push(clone(op.node));
        changes.push(`added node ${id} (${type})`);
        return;
      }
      case "update_node": {
        const set = op.set ?? {};
        const node = nodes.find((candidate) => candidate.id === op.id);
        if (!node) return refuse(`node "${op.id}" does not exist`);
        if ("id" in set || "type" in set) return refuse("the id and the type of a node do not change: remove the node and add it again");
        for (const [key, value] of Object.entries(set)) { if (value === null) delete node[key]; else node[key] = clone(value); }
        for (const key of op.unset ?? []) delete node[key];
        changes.push(`updated node ${op.id} (${[...Object.keys(set), ...(op.unset ?? [])].join(", ") || "nothing"})`);
        return;
      }
      case "remove_node": {
        const at = nodes.findIndex((candidate) => candidate.id === op.id);
        if (at < 0) return refuse(`node "${op.id}" does not exist`);
        const touching = edges.filter((edge) => edge.from === op.id || edge.to === op.id);
        if (touching.length && op.cascade === false) return refuse(`node "${op.id}" has ${touching.length} edge(s); remove them first or use cascade`);
        nodes.splice(at, 1);
        for (let i = edges.length - 1; i >= 0; i -= 1) if (edges[i]!.from === op.id || edges[i]!.to === op.id) edges.splice(i, 1);
        if (next.entry === op.id) delete next.entry;
        changes.push(`removed node ${op.id}${touching.length ? ` and ${touching.length} edge(s)` : ""}`);
        return;
      }
      case "add_edge": {
        const { from, to } = op.edge;
        if (typeof from !== "string" || typeof to !== "string" || !from || !to) return refuse("edge.from and edge.to are required (node ids, or start and end)");
        const known = (id: string) => id === "start" || id === "end" || id === "$start" || id === "$end" || nodes.some((node) => node.id === id);
        if (!known(from)) return refuse(`edge from "${from}": no such node (add the node first)`);
        if (!known(to)) return refuse(`edge to "${to}": no such node (add the node first)`);
        edges.push(clone(op.edge));
        changes.push(`added edge ${edgeLabel(op.edge)}`);
        return;
      }
      case "update_edge": {
        const found = selectEdges(next, op.edge);
        if (!found.length) return refuse("no such edge");
        if (found.length > 1) return refuse(`${found.length} edges match (indexes ${found.join(", ")}); name one by index`);
        const edge = edges[found[0]!]!;
        for (const [key, value] of Object.entries(op.set ?? {})) { if (value === null) delete edge[key]; else edge[key] = clone(value); }
        for (const key of op.unset ?? []) delete edge[key];
        changes.push(`updated edge ${edgeLabel(edge)}`);
        return;
      }
      case "remove_edge": {
        const found = selectEdges(next, op.edge);
        if (!found.length) return refuse("no such edge");
        if (found.length > 1) return refuse(`${found.length} edges match (indexes ${found.join(", ")}); name one by index`);
        const [removed] = edges.splice(found[0]!, 1);
        changes.push(`removed edge ${edgeLabel(removed!)}`);
        return;
      }
      case "set_meta": {
        const bad = Object.keys(op.set).filter((key) => !META_SET.has(key));
        if (bad.length) return refuse(`${bad.join(", ")}: not a meta field (allowed: ${META_KEYS.join(", ")}; nodes and edges have their own operations; status and version are set by test and publish)`);
        if ("id" in op.set && (typeof op.set.id !== "string" || !/^[a-z][a-z0-9.-]{0,47}$/.test(op.set.id))) return refuse("id: lowercase letters, digits, . and -; starts with a letter; at most 48 characters");
        for (const [key, value] of Object.entries(op.set)) { if (value === null) delete next[key]; else next[key] = clone(value); }
        changes.push(`set ${Object.keys(op.set).join(", ")}`);
        return;
      }
    }
  });

  return refused.length ? { ok: false, refused } : { ok: true, definition: next, changes };
}

export type DraftCheck = { valid: boolean; errors: number; warnings: number; problems: WorkflowProblem[]; nodes: number; edges: number };

/** The validator's verdict on a draft, in the shape the tools and the screen use. */
export function checkDraft(definition: RawDefinition, options: ValidateOptions = {}): DraftCheck {
  const loaded = loadWorkflow(definition, options);
  const problems = loaded.ok ? loaded.warnings : loaded.problems;
  const errors = problems.filter((problem) => problem.level === "error").length;
  return { valid: loaded.ok, errors, warnings: problems.length - errors, problems, nodes: nodesOf(definition).length, edges: edgesOf(definition).length };
}

/** A lowercase id from a name; a name with no Latin letters (a Russian one) gets a short suffix instead. */
export function slugWorkflowId(name: string, fallbackSuffix: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return /^[a-z]/.test(slug) && slug.length >= 3 ? slug : `workflow-${fallbackSuffix}`;
}

export type DraftScope = { level: "global" | "project"; projectId?: string };

export function newDraftDefinition(input: { id: string; name: string | { en: string; ru: string }; description: string | { en: string; ru: string }; scope: DraftScope }): RawDefinition {
  const both = (value: string | { en: string; ru: string }) => (typeof value === "string" ? { en: value, ru: value } : value);
  return {
    schemaVersion: 1,
    id: input.id,
    name: both(input.name),
    description: both(input.description),
    status: "draft",
    version: 1,
    scope: input.scope.level === "project" ? { level: "project", ...(input.scope.projectId ? { projectId: input.scope.projectId } : {}) } : { level: "global" },
    nodes: [],
    edges: [],
  };
}
