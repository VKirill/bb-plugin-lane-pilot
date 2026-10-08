import type { I18nKey } from "@lane-pilot/i18n";
import type { DraftOp } from "../draft";
import type { WorkflowView } from "../view-core";
import type { GraphProblems } from "./workflow-graph";

/**
 * What the editor knows about a workflow draft, as pure functions: the raw definition (the authoring spelling the architect
 * writes too) read into the pieces a form edits, and the draft operations a form's change turns into. The server checks
 * everything again (the validator runs on every patch); what is checked here is what can be told at once, so a mistyped field
 * is refused at the keyboard instead of coming back as a problem.
 */
export type Raw = Record<string, unknown>;
export const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export const NODE_TYPES = ["agent", "lp-task", "action", "decision", "human", "parallel", "join", "subworkflow", "note"] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const FIELD_TYPES = ["string", "number", "boolean", "enum", "array", "object", "json"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const PASS_MODES = ["artifact", "same-session", "read-prior-session", "fork"] as const;
export const CONDITION_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "exists"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const START_KEY = "$start";
export const END_KEY = "$end";
const RESERVED_IDS = new Set(["input", "item", "index", "ctx", "start", "end"]);

/** An error the form can show: the key of its sentence and what to put in it. */
export type ModelError = { key: I18nKey; vars?: Record<string, string> };

export const nodesOf = (definition: Raw): Raw[] => (Array.isArray(definition.nodes) ? definition.nodes.filter(isRaw) : []);
export const edgesOf = (definition: Raw): Raw[] => (Array.isArray(definition.edges) ? definition.edges.filter(isRaw) : []);
export const nodeById = (definition: Raw, id: string): Raw | null => nodesOf(definition).find((node) => node.id === id) ?? null;
/** The id a canvas key stands for in an edge: the ends are `start` and `end` in a file. */
export const endName = (key: string) => (key === START_KEY ? "start" : key === END_KEY ? "end" : key);
const edgeEnd = (value: unknown) => (value === "$start" ? "start" : value === "$end" ? "end" : text(value));

// ------------------------------------------------------------------ fields

export type FieldRow = { name: string; type: FieldType; values?: string[]; required?: boolean; note?: string };

const HINT: Record<string, FieldType> = { string: "string", str: "string", int: "number", integer: "number", number: "number", float: "number", bool: "boolean", boolean: "boolean", any: "json", json: "json", object: "object" };
/** A field list in either spelling: an array of fields or a `{name: "type hint"}` map. */
export function readFields(value: unknown): FieldRow[] {
  const row = (name: string, spec: unknown): FieldRow => {
    if (typeof spec === "string") {
      const hint = spec.trim().replace(/\?$/, "");
      const parts = hint.split("|").map((part) => part.trim()).filter((part) => part && part !== "null");
      const type: FieldType = hint.endsWith("[]") ? "array" : HINT[hint] ?? (parts.length > 1 && parts.every((part) => /^[a-z0-9][\w.-]*$/.test(part)) ? "enum" : /^[A-Z]/.test(hint) ? "object" : "json");
      return { name, type, ...(type === "enum" ? { values: parts } : {}), ...(spec.trim().endsWith("?") ? { required: false } : {}) };
    }
    if (isRaw(spec)) {
      const type = (FIELD_TYPES as readonly string[]).includes(text(spec.type)) ? spec.type as FieldType : typeof spec.type === "string" ? row(name, spec.type).type : "json";
      const values = Array.isArray(spec.values) ? spec.values.filter((item): item is string => typeof item === "string") : typeof spec.type === "string" && type === "enum" ? row(name, spec.type).values : undefined;
      return { name, type, ...(values?.length ? { values } : {}), ...(typeof spec.required === "boolean" ? { required: spec.required } : {}), ...(typeof spec.note === "string" ? { note: spec.note } : {}) };
    }
    return { name, type: "json" };
  };
  if (Array.isArray(value)) return value.flatMap((item) => (isRaw(item) && typeof item.name === "string" ? [row(item.name, item)] : []));
  if (isRaw(value)) return Object.entries(value).map(([name, spec]) => row(name, spec));
  return [];
}

/** What a field list is written back as: the array spelling, with only what is set. */
export const writeFields = (rows: readonly FieldRow[]): Raw[] => rows.map((row) => ({
  name: row.name, type: row.type, ...(row.type === "enum" ? { values: row.values?.length ? row.values : ["value"] } : {}),
  ...(row.required === false ? { required: false } : {}), ...(row.note ? { note: row.note } : {}),
}));

const HANDOFF: FieldRow = { name: "handoff", type: "string" };
/** The fields a condition or a reference may read from a node: what it declares (an agent also gives a handoff); the inputs for the start. */
export function outFields(definition: Raw, node: Raw | "start" | "end"): FieldRow[] {
  if (node === "start") return readFields(definition.inputs);
  if (node === "end") return readFields(definition.outputs);
  const own = readFields(node.out ?? node.output);
  if (node.type === "agent") return own.some((field) => field.name === "handoff") ? own : [...own, HANDOFF];
  if (node.type === "decision" && !own.length && typeof node.reads_node === "string") { const source = nodeById(definition, node.reads_node); return source ? outFields(definition, source) : []; }
  return own;
}
export const fieldsOfKey = (definition: Raw, key: string): FieldRow[] => {
  if (key === START_KEY || key === "start") return outFields(definition, "start");
  const node = nodeById(definition, key);
  return node ? outFields(definition, node) : [];
};

// ------------------------------------------------------------------ ids and new nodes

const slug = (base: string) => base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/g, "").slice(0, 40) || "step";
export function uniqueId(definition: Raw, base: string): string {
  const taken = new Set(nodesOf(definition).map((node) => text(node.id)));
  const stem = slug(base);
  let id = RESERVED_IDS.has(stem) ? `${stem}-step` : stem;
  for (let number = 2; taken.has(id); number += 1) id = `${stem}-${number}`;
  return id;
}

/** A new node of a type, with the least that makes the form usable; the validator says what is still missing. */
export function newNode(definition: Raw, type: NodeType, options: { after?: string | null } = {}): Raw {
  const id = uniqueId(definition, type === "lp-task" ? "code-task" : type);
  switch (type) {
    case "agent": return { id, type, role: "worker", prompt: "", out: [{ name: "result", type: "string" }] };
    case "lp-task": return { id, type, out: [{ name: "status", type: "string" }] };
    case "action": return { id, type, out: [{ name: "result", type: "string" }] };
    case "decision": return { id, type, ...(options.after && options.after !== "start" && nodeById(definition, options.after) ? { reads_node: options.after } : {}) };
    case "human": return { id, type, question: "Question for the owner", options: [], out: [{ name: "answer", type: "string" }] };
    case "parallel": return { id, type };
    case "join": {
      const fan = nodesOf(definition).find((node) => node.type === "parallel" && !isRaw(node.child));
      return { id, type, parallel: fan ? text(fan.id) : "" };
    }
    case "subworkflow": return { id, type, workflow: "" };
    case "note": return { id, type, text: "Note" };
  }
}

// ------------------------------------------------------------------ the graph in the file

/** Indexes of the edges a node starts (by file spelling). */
const outgoing = (definition: Raw, from: string) => edgesOf(definition).flatMap((edge, index) => (edgeEnd(edge.from) === from ? [index] : []));

/** The nodes a node's data can come from: those that reach it along the edges. */
export function upstreamOf(definition: Raw, id: string): string[] {
  const edges = edgesOf(definition).map((edge) => [edgeEnd(edge.from), edgeEnd(edge.to)] as const);
  const seen = new Set<string>();
  const queue = [id];
  for (let at = 0; at < queue.length; at += 1) {
    for (const [from, to] of edges) if (to === queue[at] && !seen.has(from)) { seen.add(from); queue.push(from); }
  }
  return [...seen].filter((from) => from !== id && from !== "start");
}

/** What a prompt or a mapping may refer to: the workflow's inputs and the outputs of the nodes before this one. */
export function refCandidates(definition: Raw, id: string | null): string[] {
  const refs = readFields(definition.inputs).map((field) => `input.${field.name}`);
  const before = id ? upstreamOf(definition, id) : [];
  const sources = before.length ? before : nodesOf(definition).map((node) => text(node.id)).filter((other) => other !== id);
  for (const source of sources) { const node = nodeById(definition, source); if (node && node.type !== "note") for (const field of outFields(definition, node)) refs.push(`${source}.${field.name}`); }
  return refs;
}

// ------------------------------------------------------------------ operations

export const addNodeOps = (node: Raw): DraftOp[] => [{ op: "add_node", node }];

/**
 * A step added after another. When that step has one way out, the new one goes in between (the way out is re-pointed to it and a
 * second edge, carrying the same inputs, continues to the old target); otherwise it is only joined to it. A note has no edges.
 */
export function insertAfterOps(definition: Raw, afterKey: string | null, node: Raw): DraftOp[] {
  const ops: DraftOp[] = [{ op: "add_node", node }];
  if (node.type === "note") return ops;
  const id = text(node.id);
  if (afterKey === null) { if (!nodesOf(definition).length) ops.push({ op: "add_edge", edge: { from: "start", to: id } }); return ops; }
  const from = endName(afterKey);
  const leaving = outgoing(definition, from);
  if (leaving.length === 1) {
    const old = edgesOf(definition)[leaving[0]!]!;
    ops.push({ op: "update_edge", edge: { index: leaving[0]! }, set: { to: id } });
    ops.push({ op: "add_edge", edge: { from: id, to: edgeEnd(old.to), ...(isRaw(old.with) ? { with: old.with } : {}) } });
  } else ops.push({ op: "add_edge", edge: { from, to: id } });
  return ops;
}

export function connectOps(definition: Raw, fromKey: string, toKey: string): { ops: DraftOp[] } | { error: ModelError } {
  const from = endName(fromKey), to = endName(toKey);
  if (from === "end") return { error: { key: "wfEditErr_fromEnd" } };
  if (to === "start") return { error: { key: "wfEditErr_toStart" } };
  const note = (id: string) => nodeById(definition, id)?.type === "note";
  if (note(from) || note(to)) return { error: { key: "wfEditErr_noteEdge" } };
  if (edgesOf(definition).some((edge) => edgeEnd(edge.from) === from && edgeEnd(edge.to) === to && edge.when === undefined)) return { error: { key: "wfEditErr_duplicateEdge" } };
  return { ops: [{ op: "add_edge", edge: { from, to } }] };
}

/** `null` removes a key (the draft operation's rule), so a cleared field leaves the file as if it had never been set. */
const clean = (set: Raw): Raw => Object.fromEntries(Object.entries(set).map(([key, value]) => [key, value === undefined || value === "" ? null : value]));
export const setNodeOps = (id: string, set: Raw, unset: string[] = []): DraftOp[] => [{ op: "update_node", id, set: clean(set), ...(unset.length ? { unset } : {}) }];
export const removeNodeOps = (id: string): DraftOp[] => [{ op: "remove_node", id, cascade: true }];
export const setEdgeOps = (index: number, set: Raw, unset: string[] = []): DraftOp[] => [{ op: "update_edge", edge: { index }, set: clean(set), ...(unset.length ? { unset } : {}) }];
export const removeEdgeOps = (index: number): DraftOp[] => [{ op: "remove_edge", edge: { index } }];
export const setMetaOps = (set: Raw): DraftOp[] => [{ op: "set_meta", set: clean(set) }];

/**
 * The guards of a node (visits, attempts, timeout) may sit in a `guards` object, which the schema applies over the plain keys.
 * Editing one value moves them all to the plain keys and drops the object, so the edit is the one that counts.
 */
export function guardOps(node: Raw, key: "maxVisits" | "maxAttempts" | "timeoutSec", value: number | null): DraftOp[] {
  const id = text(node.id);
  if (!isRaw(node.guards)) return setNodeOps(id, { [key]: value });
  const guards = node.guards;
  const effective: Raw = { maxVisits: guards.maxVisits ?? node.maxVisits, maxAttempts: guards.maxAttempts ?? node.maxAttempts,
    timeoutSec: typeof guards.timeoutSec === "number" ? guards.timeoutSec : typeof guards.timeoutMin === "number" ? Math.round(guards.timeoutMin * 60) : node.timeoutSec, [key]: value };
  return setNodeOps(id, effective, ["guards"]);
}
export const guardValue = (node: Raw, key: "maxVisits" | "maxAttempts" | "timeoutSec"): number | null => {
  const guards = isRaw(node.guards) ? node.guards : {};
  const value = key === "timeoutSec" ? (typeof guards.timeoutSec === "number" ? guards.timeoutSec : typeof guards.timeoutMin === "number" ? Math.round(guards.timeoutMin * 60) : node.timeoutSec) : guards[key] ?? node[key];
  return typeof value === "number" ? value : null;
};

/** The question of a human node lives in `question` or, in the authoring spelling, `prompt`. */
export const questionOps = (node: Raw, value: string): DraftOp[] => setNodeOps(text(node.id), { question: value }, "prompt" in node ? ["prompt"] : []);
export const questionOf = (node: Raw) => text(node.question ?? node.prompt);
export const forEachOf = (node: Raw): string => (typeof (node.for_each ?? node.foreach) === "string" ? text(node.for_each ?? node.foreach) : "");
export const forEachOps = (node: Raw, value: string): DraftOp[] => setNodeOps(text(node.id), { for_each: value }, "foreach" in node ? ["foreach"] : []);
export const fieldsOps = (node: Raw, rows: readonly FieldRow[]): DraftOp[] => setNodeOps(text(node.id), { out: writeFields(rows) }, "output" in node ? ["output"] : []);

/** The parameters of an action: its `params` and, in the authoring spelling, the keys written beside it. */
const ACTION_OWN = new Set(["id", "type", "title", "label", "src", "out", "output", "uses", "maxVisits", "maxAttempts", "timeoutSec", "guards", "applicable_modes", "skip_when", "skip_out", "with", "reads", "model_preset", "profile", "position", "action", "params", "map", "test_mode"]);
export function actionParams(node: Raw): Raw {
  const beside = Object.fromEntries(Object.entries(node).filter(([key]) => !ACTION_OWN.has(key)));
  return { ...(isRaw(node.params) ? node.params : {}), ...beside };
}
export const paramsOps = (node: Raw, params: Raw): DraftOp[] => setNodeOps(text(node.id), { params }, Object.keys(node).filter((key) => !ACTION_OWN.has(key)));

// ------------------------------------------------------------------ conditions

export type Clause = { field: string; op: ConditionOp; value?: unknown };
export type WhenModel =
  | { kind: "none" }
  | { kind: "clauses"; join: "all" | "any"; clauses: Clause[] }
  | { kind: "expression"; text: string }
  /** A nested condition (not, groups): shown as text, replaced as a whole. */
  | { kind: "complex"; text: string };

const isClause = (value: unknown): value is Clause => isRaw(value) && typeof value.field === "string" && (CONDITION_OPS as readonly string[]).includes(text(value.op));

export function readWhen(when: unknown, describe: (when: unknown) => string): WhenModel {
  if (when === undefined || when === null || when === "") return { kind: "none" };
  if (typeof when === "string") return { kind: "expression", text: when };
  if (isClause(when)) return { kind: "clauses", join: "all", clauses: [{ field: when.field, op: when.op, ...("value" in when ? { value: when.value } : {}) }] };
  if (isRaw(when)) {
    const key = Array.isArray(when.all) ? "all" : Array.isArray(when.any) ? "any" : null;
    const list = key ? when[key] as unknown[] : [];
    if (key && list.length && list.every(isClause)) return { kind: "clauses", join: key, clauses: list.map((item) => ({ field: item.field, op: item.op, ...("value" in item ? { value: item.value } : {}) })) };
  }
  return { kind: "complex", text: describe(when) };
}

export function writeWhen(model: WhenModel): unknown {
  if (model.kind === "none" || model.kind === "complex") return undefined;
  if (model.kind === "expression") return model.text.trim() || undefined;
  const clauses = model.clauses.map((clause) => (clause.op === "exists" ? { field: clause.field, op: clause.op } : { field: clause.field, op: clause.op, value: clause.value }));
  if (!clauses.length) return undefined;
  return clauses.length === 1 ? clauses[0] : { [model.join]: clauses };
}

/** A value typed in a form, as the field's type wants it: numbers and booleans are not strings, `in` takes a list. */
export function parseClauseValue(op: ConditionOp, raw: string, field: FieldRow | undefined): unknown {
  if (op === "exists") return undefined;
  const one = (part: string): unknown => {
    if (field?.type === "number" || op === "gt" || op === "gte" || op === "lt" || op === "lte") { const number = Number(part); return part.trim() !== "" && Number.isFinite(number) ? number : part; }
    if (field?.type === "boolean") return part.trim() === "true" ? true : part.trim() === "false" ? false : part;
    return part;
  };
  if (op === "in" || op === "notIn") return raw.split(",").map((part) => part.trim()).filter(Boolean).map(one);
  return one(raw);
}
export const clauseValueText = (value: unknown): string => (Array.isArray(value) ? value.map(String).join(", ") : value === undefined || value === null ? "" : String(value));

/** The field of a clause must be declared by the edge's source: its first path segment is a field, and a deeper path needs a structured type. */
export function clauseError(clause: Clause, fields: readonly FieldRow[]): ModelError | null {
  if (!clause.field.trim()) return { key: "wfEditErr_fieldRequired" };
  const [head, ...rest] = clause.field.trim().split(".");
  const declared = fields.find((field) => field.name === head);
  if (!declared) return { key: "wfEditErr_unknownField", vars: { field: clause.field.trim(), known: fields.map((field) => field.name).join(", ") || "-" } };
  if (rest.length && !["object", "array", "json"].includes(declared.type)) return { key: "wfEditErr_unknownField", vars: { field: clause.field.trim(), known: fields.map((field) => field.name).join(", ") } };
  if (declared.type === "enum" && declared.values && !rest.length && clause.op !== "exists" && clause.op !== "in" && clause.op !== "notIn" && typeof clause.value === "string" && clause.value !== "" && !declared.values.includes(clause.value)) {
    return { key: "wfEditErr_unknownValue", vars: { value: clause.value, values: declared.values.join(", ") } };
  }
  if (clause.op !== "exists" && (clause.value === undefined || clause.value === "" || (Array.isArray(clause.value) && !clause.value.length))) return { key: "wfEditErr_valueRequired" };
  return null;
}

const STRING = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
const REF = /(?<![\w.$'"])([A-Za-z_$][\w$-]*)\.([A-Za-z_]\w*)/g;
/** An expression reads `node.field` references; each must name a node of the draft and a field it declares. */
export function expressionError(source: string, definition: Raw): ModelError | null {
  const bare = source.replace(STRING, "''");
  for (const match of bare.matchAll(REF)) {
    const [, head, field] = match as unknown as [string, string, string];
    if (["input", "$inputs", "item", "index", "ctx", "$mode"].includes(head)) {
      if ((head === "input" || head === "$inputs") && !readFields(definition.inputs).some((candidate) => candidate.name === field)) return { key: "wfEditErr_unknownField", vars: { field: `${head}.${field}`, known: readFields(definition.inputs).map((candidate) => candidate.name).join(", ") || "-" } };
      continue;
    }
    const node = nodeById(definition, head);
    if (!node) return { key: "wfEditErr_unknownNode", vars: { node: head } };
    const fields = outFields(definition, node);
    if (node.type !== "subworkflow" && !fields.some((candidate) => candidate.name === field)) return { key: "wfEditErr_unknownField", vars: { field: `${head}.${field}`, known: fields.map((candidate) => candidate.name).join(", ") || "-" } };
  }
  return null;
}

/** What is wrong with a condition as written, before it is sent. */
export function whenError(model: WhenModel, definition: Raw, fromKey: string): ModelError | null {
  if (model.kind === "expression") return model.text.trim() ? expressionError(model.text, definition) : null;
  if (model.kind !== "clauses") return null;
  const fields = fieldsOfKey(definition, endName(fromKey));
  for (const clause of model.clauses) { const found = clauseError(clause, fields); if (found) return found; }
  return null;
}

// ------------------------------------------------------------------ problems on the graph

export type Problem = { level: "error" | "warning"; code: string; message: string; node?: string; edge?: number };

/** Problems by the card or edge they name, and those that name neither. Edge indexes are the file's; the canvas's are in `viewEdges`. */
export function problemMaps(problems: readonly Problem[], definition: Raw, viewEdges: readonly number[]): { graph: GraphProblems; general: Problem[] } {
  const nodes = new Map<string, string[]>(), edges = new Map<string, string[]>(), errors = new Set<string>(), general: Problem[] = [];
  const viewOf = new Map(viewEdges.map((raw, view) => [raw, view]));
  // With `entry`, the validator counts a synthetic edge from start first; the file's edge i is its i + 1.
  const shifted = typeof definition.entry === "string" && !edgesOf(definition).some((edge) => edgeEnd(edge.from) === "start") ? 1 : 0;
  const add = (map: Map<string, string[]>, key: string, message: string) => map.set(key, [...(map.get(key) ?? []), message]);
  for (const problem of problems) {
    if (problem.node) {
      const id = problem.node.replace(/:(child|fan)$/, "");
      add(nodes, id, problem.message);
      if (problem.level === "error") errors.add(`node:${id}`);
      continue;
    }
    if (problem.edge !== undefined) {
      const view = viewOf.get(problem.edge - shifted);
      if (view !== undefined) { add(edges, `e${view}`, problem.message); if (problem.level === "error") errors.add(`edge:e${view}`); continue; }
    }
    general.push(problem);
  }
  return { graph: { nodes, edges, errors }, general };
}

/** The file's edge index behind each edge of the canvas (the draft view leaves out an edge to a node that is not there yet). */
export function viewEdgeIndexes(definition: Raw, view: WorkflowView): number[] {
  const raw = edgesOf(definition);
  const used = new Set<number>();
  return view.edges.map((edge) => {
    const found = raw.findIndex((candidate, index) => !used.has(index) && (edgeEnd(candidate.from) === endName(edge.from)) && (edgeEnd(candidate.to) === endName(edge.to)));
    if (found >= 0) used.add(found);
    return found;
  });
}
