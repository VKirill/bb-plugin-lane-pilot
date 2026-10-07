import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { END, MAX_SUBWORKFLOW_DEPTH, START, workflowSchema } from "./schema";
import type { Condition, Field, Workflow, WorkflowNode } from "./schema";

export type WorkflowProblem = { level: "error" | "warning"; code: string; message: string; node?: string; edge?: number };

/** What the validator can ask the outside: the child of a subworkflow node, and whether an executor key exists. */
export type ValidateOptions = {
  resolve?: (id: string, version?: number) => Workflow | null;
  hasExecutor?: (key: string) => boolean;
};

export class WorkflowError extends Error {
  constructor(readonly problems: WorkflowProblem[]) {
    super(`invalid workflow: ${problems.filter((problem) => problem.level === "error").map((problem) => problem.message).join("; ")}`);
  }
}

const RESERVED = new Set([START, END, "input", "item", "index"]);
const HANDOFF: Field = { name: "handoff", type: "string", required: true, description: "What was done, where the result is, what is left." };

/** The fields a condition or a mapping may read from a node: its declared output (agents always carry a handoff). */
export function outputFields(workflow: Workflow, node: WorkflowNode | typeof START | typeof END): Field[] {
  if (node === START) return workflow.inputs;
  if (node === END) return workflow.outputs;
  if (node.type === "note") return [];
  if (node.type === "agent") return node.output.some((field) => field.name === "handoff") ? node.output : [...node.output, HANDOFF];
  if (node.type === "decision" && node.output.length === 0 && node.reads) {
    const source = workflow.nodes.find((candidate) => candidate.id === node.reads);
    return source ? outputFields(workflow, source) : [];
  }
  return node.output;
}

export type PathType = { type: Field["type"]; values?: string[]; required: boolean; length?: boolean };

/** `name`, `name.sub...` or `name.length`: the type the path ends on, or why it cannot. */
export function resolvePath(fields: readonly Field[], path: readonly string[]): PathType | { error: string } {
  const [head, ...rest] = path;
  const field = fields.find((candidate) => candidate.name === head);
  if (!field) return { error: `unknown field "${head}" (declared: ${fields.map((candidate) => candidate.name).join(", ") || "none"})` };
  const base: PathType = { type: field.type, values: field.values, required: field.required };
  if (rest.length === 0) return base;
  if (field.type === "object" || field.type === "json") return { type: "json", required: false };
  if ((field.type === "array" || field.type === "string") && rest.length === 1 && rest[0] === "length") return { type: "number", required: field.required, length: true };
  return { error: `"${field.name}" is a ${field.type}; "${rest.join(".")}" cannot be read from it` };
}

export type Ref = { kind: "input" | "node" | "item" | "index"; node?: string; path: string[] };

export function parseRef(text: string): Ref | null {
  const parts = text.trim().split(".");
  if (parts.some((part) => part === "")) return null;
  const [head, ...rest] = parts;
  if (head === "input" || head === START) return rest.length ? { kind: "input", path: rest } : null;
  if (head === "item") return { kind: "item", path: rest };
  if (head === "index") return rest.length ? null : { kind: "index", path: [] };
  if (!head || rest.length === 0) return null;
  return { kind: "node", node: head, path: rest };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
export const placeholdersIn = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);

function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, into));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => stringsIn(item, into));
  return into;
}

function tarjan(ids: string[], next: (id: string) => string[]): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = [], out: string[][] = [];
  let counter = 0;
  const visit = (id: string) => {
    index.set(id, counter); low.set(id, counter); counter += 1; stack.push(id); onStack.add(id);
    for (const to of next(id)) {
      if (!index.has(to)) { visit(to); low.set(id, Math.min(low.get(id)!, low.get(to)!)); }
      else if (onStack.has(to)) low.set(id, Math.min(low.get(id)!, index.get(to)!));
    }
    if (low.get(id) === index.get(id)) {
      const group: string[] = [];
      for (let top = stack.pop()!; ; top = stack.pop()!) { onStack.delete(top); group.push(top); if (top === id) break; }
      out.push(group);
    }
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  return out;
}

function checkLiteral(field: PathType, value: unknown, where: string, problems: WorkflowProblem[], node?: string): void {
  const bad = (message: string) => problems.push({ level: "error", code: "condition_value", message: `${where}: ${message}`, node });
  if (field.type === "enum") {
    if (typeof value !== "string" || !field.values!.includes(value)) bad(`${JSON.stringify(value)} is not one of ${field.values!.join(", ")}`);
  } else if (field.type === "number") { if (typeof value !== "number") bad(`${JSON.stringify(value)} is not a number`); }
  else if (field.type === "boolean") { if (typeof value !== "boolean") bad(`${JSON.stringify(value)} is not a boolean`); }
  else if (field.type === "string") { if (typeof value !== "string") bad(`${JSON.stringify(value)} is not a string`); }
  else bad(`a value of type ${field.type} cannot be compared`);
}

/** A condition may read only fields the source node declares, with a value of the field's type. */
export function checkCondition(condition: Condition, fields: readonly Field[], where: string, problems: WorkflowProblem[], node?: string): void {
  if ("all" in condition) { condition.all.forEach((item) => checkCondition(item, fields, where, problems, node)); return; }
  if ("any" in condition) { condition.any.forEach((item) => checkCondition(item, fields, where, problems, node)); return; }
  if ("not" in condition) { checkCondition(condition.not, fields, where, problems, node); return; }
  const path = condition.field.split(".");
  const resolved = resolvePath(fields, path);
  if ("error" in resolved) { problems.push({ level: "error", code: "condition_field", message: `${where}: condition on ${condition.field}: ${resolved.error}`, node }); return; }
  const label = `${where}: condition ${condition.field} ${condition.op}`;
  if (condition.op === "exists") {
    if (condition.value !== undefined && typeof condition.value !== "boolean") problems.push({ level: "error", code: "condition_value", message: `${label}: value must be true or false`, node });
    return;
  }
  if (condition.op === "gt" || condition.op === "gte" || condition.op === "lt" || condition.op === "lte") {
    if (resolved.type !== "number") problems.push({ level: "error", code: "condition_type", message: `${label}: ${condition.field} is a ${resolved.type}, not a number`, node });
    else if (typeof condition.value !== "number") problems.push({ level: "error", code: "condition_value", message: `${label}: value must be a number`, node });
    return;
  }
  if (condition.op === "in" || condition.op === "notIn") {
    if (!Array.isArray(condition.value) || condition.value.length === 0) { problems.push({ level: "error", code: "condition_value", message: `${label}: value must be a non-empty list`, node }); return; }
    condition.value.forEach((item) => checkLiteral(resolved, item, label, problems, node));
    return;
  }
  checkLiteral(resolved, condition.value, label, problems, node);
}

export function conditionPaths(condition: Condition): string[] {
  if ("all" in condition) return condition.all.flatMap(conditionPaths);
  if ("any" in condition) return condition.any.flatMap(conditionPaths);
  if ("not" in condition) return conditionPaths(condition.not);
  return [condition.field];
}

/** How deep the subworkflow calls of a workflow go (0 without any); null when it calls itself. */
export function subworkflowDepth(workflow: Workflow, resolve: NonNullable<ValidateOptions["resolve"]>, trail: string[] = []): number | null {
  if (trail.includes(workflow.id)) return null;
  let deepest = 0;
  for (const node of workflow.nodes) {
    if (node.type !== "subworkflow") continue;
    const child = resolve(node.workflow, node.version);
    if (!child) continue;
    const depth = subworkflowDepth(child, resolve, [...trail, workflow.id]);
    if (depth === null) return null;
    deepest = Math.max(deepest, depth + 1);
  }
  return deepest;
}

/** Everything a save or a load checks. Errors make the workflow unusable; warnings are shown. */
export function validateWorkflow(workflow: Workflow, options: ValidateOptions = {}): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const error = (code: string, message: string, extra: { node?: string; edge?: number } = {}) => problems.push({ level: "error", code, message, ...extra });
  const warn = (code: string, message: string, extra: { node?: string; edge?: number } = {}) => problems.push({ level: "warning", code, message, ...extra });

  const byId = new Map<string, WorkflowNode>();
  for (const node of workflow.nodes) {
    if (RESERVED.has(node.id)) error("reserved_id", `node id "${node.id}" is reserved`, { node: node.id });
    if (byId.has(node.id)) error("duplicate_id", `duplicate node id "${node.id}"`, { node: node.id });
    byId.set(node.id, node);
  }
  const known = (id: string) => byId.has(id) || id === START || id === END;
  const live = workflow.nodes.filter((node) => node.type !== "note");

  // Names inside one field list are unique.
  const dupField = (fields: readonly Field[], where: string, node?: string) => {
    const seen = new Set<string>();
    for (const field of fields) { if (seen.has(field.name)) error("duplicate_field", `${where}: field "${field.name}" is declared twice`, { node }); seen.add(field.name); }
  };
  dupField(workflow.inputs, "inputs"); dupField(workflow.outputs, "outputs");
  for (const node of workflow.nodes) if (node.type !== "note") dupField(node.output, node.id, node.id);

  // Edges: endpoints, entry, notes.
  workflow.edges.forEach((edge, index) => {
    if (!known(edge.from)) error("edge_from", `edge ${index}: unknown source "${edge.from}"`, { edge: index });
    if (!known(edge.to)) error("edge_to", `edge ${index}: unknown target "${edge.to}"`, { edge: index });
    if (edge.from === END) error("edge_from_end", `edge ${index}: nothing leaves "${END}"`, { edge: index });
    if (edge.to === START) error("edge_to_start", `edge ${index}: nothing enters "${START}"`, { edge: index });
    for (const end of [edge.from, edge.to]) if (byId.get(end)?.type === "note") error("edge_note", `edge ${index}: note "${end}" takes no edges`, { edge: index });
  });
  const entries = workflow.edges.filter((edge) => edge.from === START);
  if (entries.length !== 1) error("entry", entries.length === 0 ? `no entry: add one edge from "${START}"` : `${entries.length} edges leave "${START}"; a run has one entry`);
  else if (entries[0]!.when) error("entry", `the entry edge from "${START}" cannot have a condition`);
  if (!workflow.edges.some((edge) => edge.to === END)) error("no_exit", `no edge reaches "${END}"`);

  const outgoing = (id: string) => workflow.edges.map((edge, index) => ({ edge, index })).filter((item) => item.edge.from === id);
  const next = (id: string) => outgoing(id).map((item) => item.edge.to).filter((to) => known(to));
  const reach = (from: string, skip?: string): Set<string> => {
    const seen = new Set<string>(), queue = [from];
    while (queue.length) for (const to of next(queue.pop()!)) if (!seen.has(to) && to !== skip) { seen.add(to); queue.push(to); }
    return seen;
  };
  const ancestorOf = (candidate: string, node: string, strict = false) => (candidate === node ? !strict : reach(candidate).has(node));

  // Per-node edge shape.
  for (const node of live) {
    const out = outgoing(node.id);
    if (out.length === 0) { error("dead_end", `"${node.id}" has no outgoing edge`, { node: node.id }); continue; }
    const conditional = out.filter((item) => item.edge.when), plain = out.filter((item) => !item.edge.when);
    if (node.type === "parallel") {
      if (conditional.length) error("parallel_condition", `parallel "${node.id}": its edges are branches and cannot have conditions`, { node: node.id });
      if (node.foreach && out.length !== 1) error("parallel_foreach", `parallel "${node.id}" with foreach has one outgoing edge (the branch body)`, { node: node.id });
      continue;
    }
    if (plain.length > 1) error("many_plain_edges", `"${node.id}" has ${plain.length} unconditional edges; use a parallel node to run branches together`, { node: node.id });
    if (conditional.length && plain.length === 0) warn("no_fallback", `"${node.id}" has no fallback edge; the run fails if no condition matches`, { node: node.id });
  }
  if (outgoing(START).length > 1) error("entry", `"${START}" has more than one edge`);

  // Conditions read only declared fields of the source node.
  workflow.edges.forEach((edge, index) => {
    if (!edge.when || !known(edge.from)) return;
    const source = edge.from === START ? START : byId.get(edge.from);
    if (!source || (typeof source !== "string" && source.type === "note")) return;
    checkCondition(edge.when, outputFields(workflow, source), `edge ${edge.from} -> ${edge.to}`, problems, edge.from);
  });

  // Cycles carry a visit limit.
  const ids = live.map((node) => node.id);
  for (const group of tarjan(ids, (id) => next(id).filter((to) => byId.has(to)))) {
    const loops = group.length > 1 || next(group[0]!).includes(group[0]!);
    if (loops && !group.some((id) => (byId.get(id) as { maxVisits?: number }).maxVisits !== undefined)) {
      error("cycle_unbounded", `the loop ${group.join(" -> ")} has no node with maxVisits`, { node: group[0] });
    }
  }

  // References: mappings, placeholders, foreach.
  const checkRef = (text: string, from: string, where: string, node?: string, edge?: number, strictSelf = false): Field | null => {
    const ref = parseRef(text);
    if (!ref) { error("bad_ref", `${where}: "${text}" is not a reference (use node.field, input.name, item or index)`, { node, edge }); return null; }
    if (ref.kind === "index") return { name: "index", type: "number", required: true };
    if (ref.kind === "item") {
      const inBranch = workflow.nodes.some((candidate) => candidate.type === "parallel" && candidate.foreach && (candidate.id === from || reach(candidate.id).has(from)));
      if (!inBranch) error("bad_ref", `${where}: "${text}" is only available inside a parallel foreach`, { node, edge });
      return { name: "item", type: "json", required: true };
    }
    const fields = ref.kind === "input" ? workflow.inputs : (() => {
      const target = byId.get(ref.node!);
      if (!target || target.type === "note") { error("bad_ref", `${where}: "${text}" names an unknown node "${ref.node}"`, { node, edge }); return null; }
      if (!ancestorOf(ref.node!, from, strictSelf)) error("bad_ref", `${where}: "${text}" reads "${ref.node}", which does not run before "${from}"`, { node, edge });
      return outputFields(workflow, target);
    })();
    if (!fields) return null;
    const resolved = resolvePath(fields, ref.path);
    if ("error" in resolved) { error("bad_ref", `${where}: "${text}": ${resolved.error}`, { node, edge }); return null; }
    return { name: ref.path.join("."), type: resolved.type, values: resolved.values, required: resolved.required };
  };

  workflow.edges.forEach((edge, index) => {
    if (!known(edge.from) || !known(edge.to)) return;
    const where = `edge ${edge.from} -> ${edge.to}`;
    for (const [name, text] of Object.entries(edge.with ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(name)) error("bad_mapping", `${where}: mapping name "${name}" is not a field name`, { edge: index });
      checkRef(text, edge.from, `${where} with.${name}`, undefined, index);
    }
    if (edge.to === END) {
      for (const field of workflow.outputs.filter((candidate) => candidate.required)) {
        if (!(edge.with && field.name in edge.with)) error("output_missing", `${where}: the workflow output "${field.name}" is not provided (add it to "with")`, { edge: index });
      }
    }
    if (edge.pass !== "artifact") {
      const ends = [byId.get(edge.from), byId.get(edge.to)];
      if (ends.some((end) => end?.type !== "agent")) error("pass_mode", `${where}: pass "${edge.pass}" needs an agent on both ends`, { edge: index });
    }
  });

  for (const node of live) {
    const texts: string[] = [];
    if (node.type === "agent") texts.push(node.prompt);
    if (node.type === "human") texts.push(node.question);
    if (node.type === "action") stringsIn(node.params, texts);
    for (const text of texts) for (const holder of placeholdersIn(text)) checkRef(holder, node.id, `${node.id} placeholder {{${holder}}}`, node.id, undefined, true);
  }

  // Node specifics.
  for (const node of live) {
    if (node.uses && options.hasExecutor && !options.hasExecutor(node.uses)) error("executor_missing", `${node.id}: no executor "${node.uses}"`, { node: node.id });
    if (node.type === "agent") {
      const handoff = node.output.find((field) => field.name === "handoff");
      if (handoff && handoff.type !== "string") error("handoff_type", `${node.id}: handoff must be a string`, { node: node.id });
      if (!node.prompt.trim() && !node.uses) warn("empty_prompt", `agent "${node.id}" has an empty prompt`, { node: node.id });
    }
    if (node.type === "human" && node.onTimeout === "default" && !(node.defaultOption && node.options.includes(node.defaultOption))) {
      error("human_default", `${node.id}: onTimeout "default" needs defaultOption from options`, { node: node.id });
    }
    if (node.type === "decision" && node.reads) {
      const source = byId.get(node.reads);
      if (!source || source.type === "note") error("decision_reads", `${node.id}: reads unknown node "${node.reads}"`, { node: node.id });
      else {
        if (!ancestorOf(node.reads, node.id, true)) error("decision_reads", `${node.id}: reads "${node.reads}", which does not run before it`, { node: node.id });
        const have = outputFields(workflow, source);
        for (const field of node.output) {
          const there = have.find((candidate) => candidate.name === field.name);
          if (!there || there.type !== field.type) error("decision_reads", `${node.id}: field "${field.name}" is not declared with the same type by "${node.reads}"`, { node: node.id });
        }
      }
    }
    if (node.type === "parallel") {
      if (node.foreach) {
        const field = checkRef(node.foreach, node.id, `${node.id} foreach`, node.id, undefined, true);
        if (field && field.type !== "array") error("foreach_type", `${node.id}: foreach "${node.foreach}" is a ${field.type}, not an array`, { node: node.id });
      }
      const joins = workflow.nodes.filter((candidate) => candidate.type === "join" && candidate.parallel === node.id);
      if (joins.length === 0) error("no_join", `parallel "${node.id}" has no join`, { node: node.id });
      if (joins.length > 1) error("many_joins", `parallel "${node.id}" has ${joins.length} joins`, { node: node.id });
      const join = joins[0];
      if (join) {
        const within = new Set<string>(), queue = outgoing(node.id).map((item) => item.edge.to);
        while (queue.length) {
          const id = queue.pop()!;
          if (id === join.id || within.has(id) || !known(id)) continue;
          within.add(id); queue.push(...next(id));
        }
        if (within.has(END)) error("branch_escapes", `a branch of "${node.id}" can reach "${END}" without passing its join "${join.id}"`, { node: node.id });
        for (const item of outgoing(node.id)) if (item.edge.to !== join.id && !reach(item.edge.to).has(join.id)) error("branch_no_join", `a branch of "${node.id}" (via ${item.edge.to}) never reaches its join "${join.id}"`, { node: node.id });
      }
    }
    if (node.type === "join") {
      const target = byId.get(node.parallel);
      if (!target || target.type !== "parallel") error("join_parallel", `join "${node.id}" names "${node.parallel}", which is not a parallel node`, { node: node.id });
    }
    if (node.type === "subworkflow") {
      for (const [name, text] of Object.entries(node.inputs)) checkRef(text, node.id, `${node.id} inputs.${name}`, node.id, undefined, true);
      const child = options.resolve?.(node.workflow, node.version);
      if (options.resolve && !child) error("subworkflow_missing", `${node.id}: workflow "${node.workflow}" was not found`, { node: node.id });
      if (child) {
        for (const field of child.inputs) {
          if (field.required && !(field.name in node.inputs)) error("subworkflow_input", `${node.id}: input "${field.name}" of "${child.id}" is not mapped`, { node: node.id });
        }
        for (const name of Object.keys(node.inputs)) if (!child.inputs.some((field) => field.name === name)) error("subworkflow_input", `${node.id}: "${child.id}" has no input "${name}"`, { node: node.id });
        for (const field of node.output) {
          const there = child.outputs.find((candidate) => candidate.name === field.name);
          if (!there || there.type !== field.type) error("subworkflow_output", `${node.id}: "${child.id}" declares no output "${field.name}" of type ${field.type}`, { node: node.id });
        }
      }
    }
  }

  if (options.resolve) {
    const depth = subworkflowDepth(workflow, options.resolve);
    if (depth === null) error("subworkflow_cycle", `workflow "${workflow.id}" calls itself through its subworkflows`);
    else if (depth > Math.min(workflow.guards.maxSubworkflowDepth, MAX_SUBWORKFLOW_DEPTH)) error("subworkflow_depth", `subworkflows go ${depth} deep; the limit is ${Math.min(workflow.guards.maxSubworkflowDepth, MAX_SUBWORKFLOW_DEPTH)}`);
  }
  return problems;
}

export type LoadResult = { ok: true; workflow: Workflow; warnings: WorkflowProblem[] } | { ok: false; problems: WorkflowProblem[] };

/** Text (JSON with comments allowed) or an object to a checked workflow, without throwing. */
export function loadWorkflow(source: unknown, options: ValidateOptions = {}): LoadResult {
  let value = source;
  if (typeof source === "string") {
    const errors: ParseError[] = [];
    value = parseJsonc(source, errors, { allowTrailingComma: true });
    if (errors.length) return { ok: false, problems: errors.map((item) => ({ level: "error" as const, code: "syntax", message: `JSON syntax: ${printParseErrorCode(item.error)} at offset ${item.offset}` })) };
  }
  const parsed = workflowSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => ({ level: "error" as const, code: "schema", message: `${issue.path.join(".") || "workflow"}: ${issue.message}` })) };
  }
  const problems = validateWorkflow(parsed.data, options);
  return problems.some((problem) => problem.level === "error") ? { ok: false, problems } : { ok: true, workflow: parsed.data, warnings: problems };
}

/** As `loadWorkflow`, but a bad workflow throws a `WorkflowError` listing every problem. */
export function parseWorkflow(source: unknown, options: ValidateOptions = {}): Workflow {
  const loaded = loadWorkflow(source, options);
  if (!loaded.ok) throw new WorkflowError(loaded.problems);
  return loaded.workflow;
}
