import { z } from "zod";
import { TIER_RANK, type ToolTier } from "@lane-pilot/contracts";
import { isLearnedDraftSource } from "./draft-guard";
import { loadWorkflow } from "./validate";
import type { ValidateOptions, WorkflowProblem } from "./validate";
import { isEvaluatorRole } from "./validate-rails";

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
export const META_KEYS = ["id", "name", "description", "examples", "not_for", "tags", "category", "kind", "internal", "inputs", "outputs", "requires", "budget", "guards", "quality_mode", "goal_audit",
  "triggers", "entry", "test", "common_inputs", "ui"] as const;
const META_SET = new Set<string>(META_KEYS);

export type Refusal = { index: number; op: string; reason: string; node?: string };
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

const tierRankOf = (value: unknown): number | undefined =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(TIER_RANK, value)
    ? TIER_RANK[value as ToolTier]
    : undefined;

const MODEL_ONLY_KEYS = new Set(["provider", "model", "reasoning", "service_tier"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isAdditiveVerifyOnly(existing: unknown, next: unknown): boolean {
  if (next === null || next === undefined) return false;
  const hasCommand = (val: unknown): boolean => isRecord(val) && (val.command !== undefined || val.cmd !== undefined);
  if (hasCommand(next)) {
    if (!hasCommand(existing)) return false;
    const exRec = existing as Record<string, unknown>;
    const nxRec = next as Record<string, unknown>;
    if (exRec.command !== nxRec.command || exRec.cmd !== nxRec.cmd) return false;
  } else if (hasCommand(existing)) {
    return false;
  }
  if (existing === undefined || existing === null) return true;
  if (typeof existing === "string") {
    if (typeof next === "string") return next === existing;
    if (isRecord(next)) {
      const expr = next.expr;
      if (typeof expr === "string") return expr === existing;
      if (Array.isArray(expr)) return expr.includes(existing);
    }
    return false;
  }
  if (isRecord(existing) && isRecord(next)) {
    const exReq = Array.isArray(existing.requiredFields) ? existing.requiredFields : [];
    const nxReq = Array.isArray(next.requiredFields) ? next.requiredFields : [];
    if (exReq.some((f) => !nxReq.includes(f))) return false;
    const exExpr = typeof existing.expr === "string" ? [existing.expr] : Array.isArray(existing.expr) ? existing.expr : [];
    const nxExpr = typeof next.expr === "string" ? [next.expr] : Array.isArray(next.expr) ? next.expr : [];
    if (exExpr.some((e) => !nxExpr.includes(e))) return false;
    return true;
  }
  return false;
}

/** Applies operations in order to a copy. One that cannot be applied refuses the whole patch, and nothing is changed. */
export function applyDraftOps(definition: RawDefinition, ops: readonly DraftOp[], options: { evolutionGate?: boolean; source?: string } = {}): AppliedOps {
  const next = clone(definition);
  next.nodes = nodesOf(next);
  next.edges = edgesOf(next);
  const nodes = next.nodes as Array<Record<string, unknown>>;
  const edges = next.edges as Array<Record<string, unknown>>;
  const changes: string[] = [];
  const refused: Refusal[] = [];
  const isOwner = options.source === "owner";
  const isLearned = isLearnedDraftSource(options.source);

  ops.forEach((op, index) => {
    const refuse = (reason: string, node?: string) => { refused.push({ index, op: op.op, reason, ...(node !== undefined ? { node } : {}) }); };
    switch (op.op) {
      case "add_node": {
        const id = op.node.id, type = op.node.type;
        if (typeof id !== "string" || !id) return refuse("node.id is required");
        if (typeof type !== "string" || !type) return refuse("node.type is required (agent, lp-task, action, decision, human, parallel, join, subworkflow, note)");
        if (nodes.some((node) => node.id === id)) return refuse(`node "${id}" already exists; use update_node`);
        if (!isOwner) {
          if (typeof op.node.role === "string" && isEvaluatorRole(op.node.role)) {
            return refuse("only the owner may add a judge or critic node", id);
          }
          if (op.node.verify !== undefined) {
            return refuse("only the owner may set verify", id);
          }
        }
        if (op.node.form !== undefined && op.node.form !== "agent" && !options.evolutionGate) {
          return refuse("only the evolution gate may change a node's form");
        }
        nodes.push(clone(op.node));
        changes.push(`added node ${id} (${type})`);
        return;
      }
      case "update_node": {
        const set = op.set ?? {};
        const unset = op.unset ?? [];
        const node = nodes.find((candidate) => candidate.id === op.id);
        if (!node) return refuse(`node "${op.id}" does not exist`);
        if ("id" in set || "type" in set) return refuse("the id and the type of a node do not change: remove the node and add it again");
        if (!isOwner) {
          const existingEvaluator = typeof node.role === "string" && isEvaluatorRole(node.role);
          const setsEvaluatorRole = typeof set.role === "string" && isEvaluatorRole(set.role);
          if (existingEvaluator || setsEvaluatorRole) {
            const setKeys = Object.keys(set);
            const modelOnlyEvolution = options.evolutionGate === true
              && !("role" in set)
              && unset.length === 0
              && setKeys.length > 0
              && setKeys.every((k) => MODEL_ONLY_KEYS.has(k));
            if (!modelOnlyEvolution) {
              return refuse("only the owner may edit a judge or critic node", op.id);
            }
          }
          if ("verify" in set || unset.includes("verify")) {
            const allowedEvolveCheck = options.evolutionGate === true
              && (options.source === "evolve" || options.source === undefined)
              && !unset.includes("verify")
              && isAdditiveVerifyOnly(node.verify, set.verify);
            if (!allowedEvolveCheck) {
              return refuse("only the owner may edit verify", op.id);
            }
          }
        }
        const curForm = node.form ?? "agent";
        const formChanged = ("form" in set && (set.form ?? "agent") !== curForm) || (unset.includes("form") && curForm !== "agent");
        if (formChanged && !options.evolutionGate) return refuse("only the evolution gate may change a node's form");
        const oldRank = tierRankOf(node.effect);
        const removesEffect = unset.includes("effect") || ("effect" in set && (set.effect === null || set.effect === undefined));
        const newRank = removesEffect ? undefined : "effect" in set ? tierRankOf(set.effect) : oldRank;
        if (oldRank !== undefined && (removesEffect || (newRank !== undefined && newRank < oldRank)) && options.evolutionGate !== true) {
          return refuse("effect_lowered", op.id);
        }
        for (const [key, value] of Object.entries(set)) { if (value === null) delete node[key]; else node[key] = clone(value); }
        for (const key of unset) delete node[key];
        changes.push(`updated node ${op.id} (${[...Object.keys(set), ...unset].join(", ") || "nothing"})`);
        return;
      }
      case "remove_node": {
        const at = nodes.findIndex((candidate) => candidate.id === op.id);
        if (at < 0) return refuse(`node "${op.id}" does not exist`);
        const target = nodes[at]!;
        if (!isOwner) {
          if (typeof target.role === "string" && isEvaluatorRole(target.role)) {
            return refuse("only the owner may remove a judge or critic node", op.id);
          }
          if (target.verify !== undefined) {
            return refuse("only the owner may remove a node with verify", op.id);
          }
        }
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
        if (isLearned && "test" in op.set) return refuse("case sets are not editable through a learned source");
        const bad = Object.keys(op.set).filter((key) => !META_SET.has(key));
        if (bad.length) return refuse(`${bad.join(", ")}: not a meta field (allowed: ${META_KEYS.join(", ")}; nodes and edges have their own operations; status and version are set by test and publish)`);
        if ("id" in op.set && (typeof op.set.id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,47}$/.test(op.set.id))) return refuse("id: lowercase letters, digits, . and -; at most 48 characters");
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
