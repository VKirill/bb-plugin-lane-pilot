import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser/lib/esm/main.js";
import type { ParseError } from "jsonc-parser/lib/esm/main.js";
import { ExprSyntaxError, checkExpr, checkRef, exprRefs, parseExpr, placeholdersIn, refOf, toExpr, valueSpecOf } from "./expr";
import type { CheckEnv, Ref, Typed } from "./expr";
import { EMIT, executorKey, lowerWorkflow, outputFields } from "./lower";
import { END, MAX_SUBWORKFLOW_DEPTH, QUALITY_MODES, START, parseWorkflowObject } from "./schema";
import type { Field, GraphNode, Workflow, WorkflowNode } from "./schema";

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

const RESERVED = new Set(["input", "item", "index", "ctx"]);

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

/** How deep the subworkflow calls of a workflow go (0 without any); null when it calls itself. */
export function subworkflowDepth(workflow: Workflow, resolve: NonNullable<ValidateOptions["resolve"]>, trail: string[] = []): number | null {
  if (trail.includes(workflow.id)) return null;
  let deepest = 0;
  const calls = workflow.nodes.flatMap((node) => (node.type === "subworkflow" ? [node] : node.type === "parallel" && node.child?.type === "subworkflow" ? [node.child] : []));
  for (const node of calls) {
    const child = resolve(node.workflow, node.version);
    if (!child) continue;
    const depth = subworkflowDepth(child, resolve, [...trail, workflow.id]);
    if (depth === null) return null;
    deepest = Math.max(deepest, depth + 1);
  }
  return deepest;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Everything a save or a load checks. Errors make the workflow unusable; warnings are shown. */
export function validateWorkflow(workflow: Workflow, options: ValidateOptions = {}): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const error = (code: string, message: string, extra: { node?: string; edge?: number } = {}) => problems.push({ level: "error", code, message, ...extra });
  const warn = (code: string, message: string, extra: { node?: string; edge?: number } = {}) => problems.push({ level: "warning", code, message, ...extra });

  // Authoring-level checks on the file as written; the structure is checked on the form the engine runs.
  const originals = new Set<string>();
  for (const node of workflow.nodes) {
    if (RESERVED.has(node.id)) error("reserved_id", `node id "${node.id}" is reserved`, { node: node.id });
    if (originals.has(node.id)) error("duplicate_id", `duplicate node id "${node.id}"`, { node: node.id });
    originals.add(node.id);
  }
  if (workflow.entry && !originals.has(workflow.entry)) error("entry", `entry "${workflow.entry}" is not a node`);
  if (workflow.entry && workflow.edges.some((edge) => edge.from === START)) error("entry", `both "entry" and an edge from "${START}" name the first node`);
  const dupField = (fields: readonly Field[], where: string, node?: string) => {
    const seen = new Set<string>();
    for (const field of fields) { if (seen.has(field.name)) error("duplicate_field", `${where}: field "${field.name}" is declared twice`, { node }); seen.add(field.name); }
  };
  dupField(workflow.inputs, "inputs"); dupField(workflow.outputs, "outputs");
  for (const node of workflow.nodes) if (node.type !== "note") dupField(node.out, node.id, node.id);
  for (const node of workflow.nodes) {
    if (node.type !== "action" || node.action !== EMIT) continue;
    if (!isRecord(node.map)) { error("emit_map", `emit "${node.id}" needs a map of the fields it ends with`, { node: node.id }); continue; }
    const map = node.map;
    for (const field of workflow.outputs.filter((candidate) => candidate.required)) {
      if (!(field.name in map)) error("output_missing", `emit "${node.id}" does not give the workflow output "${field.name}"`, { node: node.id });
    }
    for (const key of Object.keys(map)) if (workflow.outputs.length && !workflow.outputs.some((field) => field.name === key)) warn("emit_extra", `emit "${node.id}" gives "${key}", which the workflow does not declare as an output`, { node: node.id });
    const status = workflow.outputs.find((field) => field.name === "status");
    if (status?.values && typeof map.status === "string" && /^[A-Za-z_][\w-]*$/.test(map.status.trim()) && !status.values.includes(map.status.trim())) {
      error("emit_status", `emit "${node.id}": status "${map.status}" is not one of ${status.values.join(", ")}`, { node: node.id });
    }
    if (workflow.edges.some((edge) => edge.from === node.id)) error("emit_edge", `emit "${node.id}" ends the workflow and cannot have outgoing edges`, { node: node.id });
  }
  for (const node of workflow.nodes) {
    if (node.type !== "parallel") continue;
    if (node.child && !node.join) error("parallel_join", `parallel "${node.id}" has a child and needs a join`, { node: node.id });
    if (node.join && !node.child) error("parallel_join", `parallel "${node.id}" has a join but no child`, { node: node.id });
    if (node.child && !node.for_each) error("parallel_for_each", `parallel "${node.id}" with a child needs for_each`, { node: node.id });
    if (node.child?.type === "action" && node.child.action === EMIT) error("parallel_child", `parallel "${node.id}": a child cannot be emit`, { node: node.id });
  }

  // ---- the lowered form
  const L = lowerWorkflow(workflow, options.resolve);
  const byId = new Map<string, GraphNode>();
  for (const node of L.nodes) if (node.type !== "note") byId.set(node.id, node);
  const known = (id: string) => byId.has(id) || id === START || id === END;
  const edgeLabel = (index: number) => `${L.edges[index]!.from} -> ${L.edges[index]!.to}`;

  L.edges.forEach((edge, index) => {
    if (!known(edge.from)) error("edge_from", `edge ${index}: unknown source "${edge.from}"`, { edge: index });
    if (!known(edge.to)) error("edge_to", `edge ${index}: unknown target "${edge.to}"`, { edge: index });
    if (edge.from === END) error("edge_from_end", `edge ${index}: nothing leaves "${END}"`, { edge: index });
    if (edge.to === START) error("edge_to_start", `edge ${index}: nothing enters "${START}"`, { edge: index });
    for (const end of [edge.from, edge.to]) if (L.nodes.find((node) => node.id === end)?.type === "note") error("edge_note", `edge ${index}: note "${end}" takes no edges`, { edge: index });
  });
  const entries = L.edges.filter((edge) => edge.from === START);
  if (entries.length !== 1) error("entry", entries.length === 0 ? `no entry: set "entry" or add one edge from "${START}"` : `${entries.length} edges leave "${START}"; a run has one entry`);
  else if (entries[0]!.when) error("entry", `the entry edge from "${START}" cannot have a condition`);
  if (!L.edges.some((edge) => edge.to === END)) error("no_exit", `no edge reaches "${END}" (end every path with an emit node)`);

  const outgoing = (id: string) => L.edges.map((edge, index) => ({ edge, index })).filter((item) => item.edge.from === id);
  const next = (id: string) => outgoing(id).map((item) => item.edge.to).filter((to) => known(to));
  const reach = (from: string, skip?: string): Set<string> => {
    const seen = new Set<string>(), queue = [from];
    while (queue.length) for (const to of next(queue.pop()!)) if (!seen.has(to) && to !== skip) { seen.add(to); queue.push(to); }
    return seen;
  };
  const ancestorOf = (candidate: string, node: string, strict: boolean) => (candidate === node ? !strict : reach(candidate).has(node));
  const forEachScopes = [...byId.values()].filter((node) => node.type === "parallel" && node.for_each !== undefined).map((node) => {
    const join = L.nodes.find((candidate) => candidate.type === "join" && candidate.parallel === node.id);
    return new Set([node.id, ...reach(node.id, join?.id)]);
  });
  const inBranch = (id: string) => forEachScopes.some((scope) => scope.has(id));

  for (const node of byId.values()) {
    const out = outgoing(node.id);
    if (out.length === 0) { error("dead_end", `"${node.id}" has no outgoing edge`, { node: node.id }); continue; }
    const conditional = out.filter((item) => item.edge.when), plain = out.filter((item) => !item.edge.when);
    if (node.type === "parallel") {
      if (conditional.length) error("parallel_condition", `parallel "${node.id}": its edges are branches and cannot have conditions`, { node: node.id });
      if (node.for_each !== undefined && out.length !== 1) error("parallel_foreach", `parallel "${node.id}" with for_each has one outgoing edge (the branch body)`, { node: node.id });
      continue;
    }
    if (plain.length > 1) error("many_plain_edges", `"${node.id}" has ${plain.length} unconditional edges; use a parallel node to run branches together`, { node: node.id });
    if (conditional.length && plain.length === 0) warn("no_fallback", `"${node.id}" has no fallback edge; the run fails if no condition matches`, { node: node.id });
  }

  // ---- expressions and references
  const skippable = (node: GraphNode) => node.applicable_modes !== undefined || node.skip_when !== undefined;
  const readFields = new Map<string, Set<string>>();
  const noteRead = (ref: Ref) => {
    if (ref.kind !== "node" || !ref.node) return;
    const set = readFields.get(ref.node) ?? new Set<string>();
    set.add(ref.path[0] ?? "*");
    readFields.set(ref.node, set);
  };
  const fieldsOf = (id: string): Field[] | "unknown" | null => {
    const node = byId.get(id);
    return node ? outputFields(L, node, options.resolve) : null;
  };
  const envFor = (from: string, strict: boolean, item: boolean): CheckEnv => ({
    nodeFields: (id) => fieldsOf(id),
    nodeExists: (id) => byId.has(id),
    inputs: L.inputs,
    before: (id) => ancestorOf(id, from, strict),
    inLoop: item,
    hasMode: true,
  });
  const exprCode = (message: string, fallback: string) => (/unknown field|cannot be read from it/.test(message) ? "condition_field" : /never matches|needs numbers|compares numbers|cannot compare/.test(message) ? "condition_type"
    : /is not one of/.test(message) ? "condition_value" : fallback);
  const emit = (list: string[], code: string, extra: { node?: string; edge?: number }) => list.forEach((message) => error(code === "condition" ? exprCode(message, code) : code, message, extra));
  const checkRefText = (text: string, from: string, where: string, extra: { node?: string; edge?: number }, strict: boolean) => {
    const ref = refOf(text);
    const list: string[] = [];
    if (ref.kind === "item" && !inBranch(from)) list.push(`${where}: "${text}" is only available inside a parallel for_each`);
    checkRef(ref, envFor(from, strict, true), list, `${where} "${text}"`);
    noteRead(ref);
    emit(list, "bad_ref", extra);
    return ref;
  };
  const checkExprText = (expr: ReturnType<typeof parseExpr>, from: string, where: string, extra: { node?: string; edge?: number }, strict: boolean): Typed => {
    const list: string[] = [];
    const refs = exprRefs(expr);
    refs.refs.forEach(noteRead);
    if (refs.refs.some((ref) => ref.kind === "item") && !inBranch(from)) list.push(`${where}: item/index are only available inside a parallel for_each`);
    const typed = checkExpr(expr, envFor(from, strict, true), list, where);
    emit(list, "condition", extra);
    return typed;
  };
  const parseOrReport = <T>(make: () => T, where: string, extra: { node?: string; edge?: number }): T | null => {
    try { return make(); } catch (cause) { error("bad_expr", `${where}: ${cause instanceof ExprSyntaxError ? cause.message : String(cause)}`, extra); return null; }
  };

  L.edges.forEach((edge, index) => {
    if (!known(edge.from) || !known(edge.to)) return;
    const where = `edge ${edgeLabel(index)}`;
    if (edge.when !== undefined && edge.from !== START) {
      const expr = parseOrReport(() => toExpr(edge.when!, edge.from), `${where} when`, { edge: index });
      if (expr) checkExprText(expr, edge.from, `${where} when`, { edge: index }, false);
    }
    for (const [name, text] of Object.entries(edge.with ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(name)) error("bad_mapping", `${where}: mapping name "${name}" is not a field name`, { edge: index });
      checkRefText(text, edge.from === START ? START : edge.from, `${where} with.${name}`, { edge: index }, false);
    }
    if (edge.to === END) {
      for (const field of L.outputs.filter((candidate) => candidate.required)) {
        if (!(edge.with && field.name in edge.with)) error("output_missing", `${where}: the workflow output "${field.name}" is not provided (add it to "with")`, { edge: index });
      }
    }
    if (edge.pass !== "artifact") {
      // The target is the agent that goes on in a session (its own earlier one, or the one the source left behind).
      if (byId.get(edge.to)?.type !== "agent") error("pass_mode", `${where}: pass "${edge.pass}" needs an agent as its target`, { edge: index });
    }
  });

  const checkTemplate = (value: unknown, from: string, where: string, extra: { node?: string }) => {
    if (typeof value === "string") { for (const holder of placeholdersIn(value)) checkRefText(holder, from, `${where} {{${holder}}}`, extra, true); return; }
    if (Array.isArray(value)) { value.forEach((item) => checkTemplate(item, from, where, extra)); return; }
    if (!isRecord(value)) return;
    if ("by_mode" in value && Object.keys(value).length === 1 && isRecord(value.by_mode)) {
      const table = value.by_mode;
      for (const key of Object.keys(table)) if (!(QUALITY_MODES as readonly string[]).includes(key) && key !== "default") error("by_mode", `${where}: by_mode key "${key}" is not a quality mode`, extra);
      if (!("default" in table) && QUALITY_MODES.some((mode) => !(mode in table))) error("by_mode", `${where}: by_mode needs quick, standard and full, or a default`, extra);
      Object.values(table).forEach((item) => checkTemplate(item, from, where, extra));
      return;
    }
    Object.values(value).forEach((item) => checkTemplate(item, from, where, extra));
  };
  const checkSpec = (value: unknown, from: string, where: string, extra: { node?: string }) => {
    if (typeof value !== "string") { if (Array.isArray(value) || isRecord(value)) checkTemplate(value, from, where, extra); return; }
    const spec = parseOrReport(() => valueSpecOf(value), where, extra);
    if (spec && "expr" in spec) checkExprText(spec.expr, from, where, extra, true);
    if (typeof value === "string") for (const holder of placeholdersIn(value)) checkRefText(holder, from, `${where} {{${holder}}}`, extra, true);
  };

  for (const node of byId.values()) {
    const extra = { node: node.id };
    if (node.skip_when !== undefined) {
      const expr = parseOrReport(() => toExpr(node.skip_when!, node.id), `${node.id} skip_when`, extra);
      if (expr) checkExprText(expr, node.id, `${node.id} skip_when`, extra, true);
    }
    for (const [name, value] of Object.entries(node.skip_out ?? {})) {
      const field = (node.type === "join" ? node.out : outputFields(L, node, options.resolve)) as Field[] | "unknown";
      if (field !== "unknown" && !field.some((candidate) => candidate.name === name) && node.type !== "parallel") error("skip_out", `${node.id}: skip_out gives "${name}", which the node does not declare`, extra);
      checkSpec(value, node.id, `${node.id} skip_out.${name}`, extra);
    }
    const texts: unknown[] = [];
    if (node.type === "agent") texts.push(node.prompt);
    if (node.type === "human") texts.push(node.question);
    if (node.type === "action") texts.push(node.params);
    if (node.type === "lp-task") texts.push(node.contract, node.contract_template, node.quality_mode);
    if (node.type === "subworkflow") texts.push(node.inputs);
    texts.push(node.with);
    for (const text of texts) checkTemplate(text, node.id, node.id, extra);
    if (node.type === "action" && node.action === EMIT) for (const [name, value] of Object.entries(isRecord(node.map) ? node.map : {})) checkSpec(value, node.id, `${node.id} map.${name}`, extra);
    for (const ref of node.reads ?? []) checkRefText(ref, node.id, `${node.id} reads`, extra, true);
  }

  // Cycles carry a visit limit.
  const ids = [...byId.keys()];
  for (const group of tarjan(ids, (id) => next(id).filter((to) => byId.has(to)))) {
    const loops = group.length > 1 || next(group[0]!).includes(group[0]!);
    // A loop is bounded by a node's maxVisits, or by a condition on one of its own edges that counts visits('node') of the loop.
    const boundedByVisits = L.edges.some((edge) => {
      if (!group.includes(edge.from) || !group.includes(edge.to) || edge.when === undefined) return false;
      try { return exprRefs(toExpr(edge.when, edge.from)).visits.some((id) => group.includes(id)); } catch { return false; }
    });
    if (loops && !boundedByVisits && !group.some((id) => byId.get(id)!.maxVisits !== undefined)) error("cycle_unbounded", `the loop ${group.join(" -> ")} has no node with maxVisits`, { node: group[0] });
  }

  // A node that can be skipped still has the output others read.
  for (const node of byId.values()) {
    if (!skippable(node)) continue;
    const readers = readFields.get(node.id);
    if (!readers) continue;
    const given = new Set(Object.keys(node.skip_out ?? {}));
    if (node.skip_out === undefined && readers.size) { error("skip_out_missing", `${node.id} can be skipped and others read it, but it has no skip_out`, { node: node.id }); continue; }
    for (const name of readers) {
      if (name === "*") continue;
      if (node.type === "join" || node.type === "parallel") { if (!given.has(name)) error("skip_out_missing", `${node.id} can be skipped and "${name}" is read, but skip_out does not give it`, { node: node.id }); continue; }
      if (!given.has(name)) error("skip_out_missing", `${node.id} can be skipped and "${name}" is read, but skip_out does not give it`, { node: node.id });
    }
  }

  // Node specifics.
  for (const node of byId.values()) {
    const extra = { node: node.id };
    if (options.hasExecutor) {
      const key = executorKey(node);
      if (!key) error("executor_missing", `${node.id}: no executor (set "uses"${node.type === "action" ? " or \"action\"" : ""})`, extra);
      else if (!options.hasExecutor(key)) error("executor_missing", `${node.id}: no executor "${key}"`, extra);
    }
    if (node.type === "agent") {
      const handoff = node.out.find((field) => field.name === "handoff");
      if (handoff && handoff.type !== "string") error("handoff_type", `${node.id}: handoff must be a string`, extra);
      if (!node.prompt.trim() && !node.uses) warn("empty_prompt", `agent "${node.id}" has an empty prompt`, extra);
    }
    if (node.type === "human" && node.onTimeout === "default" && !(node.defaultOption && node.options.includes(node.defaultOption))) error("human_default", `${node.id}: onTimeout "default" needs defaultOption from options`, extra);
    if (node.type === "decision" && node.reads_node) {
      const source = byId.get(node.reads_node);
      if (!source) error("decision_reads", `${node.id}: reads unknown node "${node.reads_node}"`, extra);
      else {
        if (!ancestorOf(node.reads_node, node.id, true)) error("decision_reads", `${node.id}: reads "${node.reads_node}", which does not run before it`, extra);
        const have = outputFields(L, source, options.resolve);
        if (have !== "unknown") for (const field of node.out) {
          const there = have.find((candidate) => candidate.name === field.name);
          if (!there || there.type !== field.type) error("decision_reads", `${node.id}: field "${field.name}" is not declared with the same type by "${node.reads_node}"`, extra);
        }
      }
    }
    if (node.type === "parallel") {
      if (typeof node.for_each === "string") {
        const [source, where] = node.for_each.split(/\s+where\s+/, 2) as [string, string | undefined];
        const ref = checkRefText(source.trim(), node.id, `${node.id} for_each`, extra, true);
        const fields = ref.kind === "node" && ref.node ? fieldsOf(ref.node) : ref.kind === "input" ? L.inputs : null;
        if (fields && fields !== "unknown" && ref.path.length) {
          const typed = checkRef(ref, envFor(node.id, true, false), [], "for_each");
          if (typed.kind !== "array" && typed.kind !== "any") error("for_each_type", `${node.id}: for_each "${source.trim()}" is a ${typed.kind}, not a list`, extra);
        }
        if (where !== undefined) {
          const expr = parseOrReport(() => parseExpr(where, { itemScope: true }), `${node.id} for_each where`, extra);
          if (expr) checkExprText(expr, node.id, `${node.id} for_each where`, extra, true);
        }
      } else if (isRecord(node.for_each) && !Array.isArray(node.for_each)) {
        const by = (node.for_each as { by: string }).by;
        const ref = refOf(by);
        const typed = checkRef(ref, envFor(node.id, true, false), [], "for_each");
        noteRead(ref);
        const keys = Object.keys(node.for_each).filter((key) => key !== "by");
        const allowed = ref.kind === "mode" ? [...QUALITY_MODES] : typed.values;
        if (allowed) {
          for (const key of keys) if (!allowed.includes(key)) error("for_each_by", `${node.id}: for_each has a list for "${key}", which "${by}" can never be (${allowed.join(", ")})`, extra);
          for (const value of allowed) if (!keys.includes(value) && !keys.includes("default")) warn("for_each_by", `${node.id}: for_each has no list for "${value}"`, extra);
        }
      }
      const join = L.nodes.find((candidate) => candidate.type === "join" && candidate.parallel === node.id);
      if (!join) error("no_join", `parallel "${node.id}" has no join`, extra);
      else {
        const within = new Set<string>(), queue = outgoing(node.id).map((item) => item.edge.to);
        while (queue.length) {
          const id = queue.pop()!;
          if (id === join.id || within.has(id) || !known(id)) continue;
          within.add(id); queue.push(...next(id));
        }
        if (within.has(END)) error("branch_escapes", `a branch of "${node.id}" can reach "${END}" without passing its join "${join.id}"`, extra);
        for (const item of outgoing(node.id)) if (item.edge.to !== join.id && !reach(item.edge.to).has(join.id)) error("branch_no_join", `a branch of "${node.id}" (via ${item.edge.to}) never reaches its join "${join.id}"`, extra);
      }
    }
    if (node.type === "join") {
      const target = byId.get(node.parallel);
      if (!target || target.type !== "parallel") error("join_parallel", `join "${node.id}" names "${node.parallel}", which is not a parallel node`, extra);
      else if (!node.uses && node.out.length) {
        const childEdge = outgoing(target.id)[0]?.edge.to;
        const childFields = childEdge && childEdge !== node.id ? fieldsOf(childEdge) : null;
        if (childFields && childFields !== "unknown") {
          for (const field of node.out) {
            if (field.type === "array" && childFields.some((candidate) => candidate.name === field.name && candidate.type === "array")) continue;
            warn("join_reducer", `join "${node.id}": "${field.name}" is not built by the default reducer (arrays of the same name are concatenated); set join.uses`, extra);
          }
        }
      }
    }
    if (node.type === "subworkflow") {
      const given = new Set([...Object.keys(node.inputs), ...Object.keys(node.with ?? {})]);
      const child = options.resolve?.(node.workflow, node.version);
      if (options.resolve && !child) error("subworkflow_missing", `${node.id}: workflow "${node.workflow}" was not found`, extra);
      if (child) {
        for (const field of child.inputs) {
          if (field.required && !given.has(field.name) && field.name !== "quality_mode") error("subworkflow_input", `${node.id}: input "${field.name}" of "${child.id}" is not mapped`, extra);
        }
        for (const name of given) if (!child.inputs.some((field) => field.name === name)) error("subworkflow_input", `${node.id}: "${child.id}" has no input "${name}"`, extra);
        for (const field of node.out) {
          const there = child.outputs.find((candidate) => candidate.name === field.name);
          const fits = there && (there.type === field.type || field.type === "json" || there.type === "json" || (field.type === "string" && there.type === "enum"));
          if (!fits) error("subworkflow_output", `${node.id}: "${child.id}" declares no output "${field.name}" of type ${field.type}`, extra);
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
  const parsed = parseWorkflowObject(value);
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

export { outputFields };
export type { WorkflowNode };
