import type { Condition, Field } from "./schema";

/**
 * The small expression language of edge conditions, `skip_when`, `for_each ... where` and value specs (workflow chains spec
 * section 0.1): `== != < <= > >= && || !`, `+ -`, `in [..]`, `.length`, `visits('node')`, `$inputs.x`, `$mode`, `ctx.x`,
 * `node.field`, `item.field`, literals. Parsed once, checked at save time against the declared fields, evaluated at run time.
 * A value that is not there fails closed (MissingValueError) instead of reading as 0 or false.
 */

export class MissingValueError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export type RefKind = "input" | "mode" | "ctx" | "node" | "item" | "index" | "var";
export type Ref = { kind: RefKind; node?: string; path: string[] };

export type Expr =
  | { t: "lit"; v: unknown }
  | { t: "ref"; ref: Ref }
  | { t: "visits"; node: string }
  | { t: "not"; e: Expr }
  | { t: "list"; items: Expr[] }
  | { t: "bin"; op: "&&" | "||" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "+" | "-"; l: Expr; r: Expr };

/** Names a run provides without any node: `{{date}}`, `{{run_id}}`, `{{slug}}` (the `slug` input, else a slug of the first of topic, question, query, subject, goal, source, title). */
export const RUN_VARS = ["date", "run_id", "slug"] as const;
/** What `ctx.` holds: the run id, the goal input, and the merged commits accumulated from every step that reports them. */
export const CTX_VARS = ["run_id", "goal", "merged_commits"] as const;

export class ExprSyntaxError extends Error {}

type Token = { k: "num" | "str" | "id" | "op" | "end"; v: string; at: number };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const ch = text[at]!;
    if (/\s/.test(ch)) { at += 1; continue; }
    if (/\d/.test(ch)) { const m = /^\d+(?:\.\d+)?/.exec(text.slice(at))!; out.push({ k: "num", v: m[0], at }); at += m[0].length; continue; }
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, at + 1);
      if (end < 0) throw new ExprSyntaxError(`unterminated string at ${at}`);
      out.push({ k: "str", v: text.slice(at + 1, end), at }); at = end + 1; continue;
    }
    const two = text.slice(at, at + 2);
    if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) { out.push({ k: "op", v: two, at }); at += 2; continue; }
    if ("!<>()[],+-".includes(ch)) { out.push({ k: "op", v: ch, at }); at += 1; continue; }
    const id = /^\$?[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*(?:\.[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*)*/.exec(text.slice(at));
    if (id) { out.push({ k: "id", v: id[0], at }); at += id[0].length; continue; }
    throw new ExprSyntaxError(`unexpected "${ch}" at ${at}`);
  }
  out.push({ k: "end", v: "", at: text.length });
  return out;
}

export function refOf(text: string, options: { itemScope?: boolean } = {}): Ref {
  const parts = text.split(".");
  const [head, ...rest] = parts;
  if (head === "$inputs") return { kind: "input", path: rest };
  if (head === "$mode") return { kind: "mode", path: [] };
  if (head === "input") return { kind: "input", path: rest };
  if (head === "ctx") return { kind: "ctx", path: rest };
  if (head === "item") return { kind: "item", path: rest };
  if (head === "index") return { kind: "index", path: [] };
  if ((RUN_VARS as readonly string[]).includes(head!) && rest.length === 0) return { kind: "var", path: [head!] };
  if (options.itemScope) return { kind: "item", path: parts };
  return { kind: "node", node: head, path: rest };
}

/** Parses an expression. `itemScope` reads bare names as fields of the current item (the `where` of a for_each). */
export function parseExpr(text: string, options: { itemScope?: boolean } = {}): Expr {
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at]!;
  const take = () => tokens[at++]!;
  const isOp = (value: string) => peek().k === "op" && peek().v === value;
  const expectOp = (value: string) => { if (!isOp(value)) throw new ExprSyntaxError(`expected "${value}" at ${peek().at}`); at += 1; };

  const primary = (): Expr => {
    const token = take();
    if (token.k === "num") return { t: "lit", v: Number(token.v) };
    if (token.k === "str") return { t: "lit", v: token.v };
    if (token.k === "op" && token.v === "(") { const inner = or(); expectOp(")"); return inner; }
    if (token.k === "op" && token.v === "[") {
      const items: Expr[] = [];
      while (!isOp("]")) {
        const item = peek();
        // A bare word inside a list is a string: `severity in [critical, high]`.
        if (item.k === "id" && !item.v.includes(".") && !item.v.startsWith("$") && !["true", "false", "null", "visits"].includes(item.v)) { take(); items.push({ t: "lit", v: item.v }); }
        else items.push(or());
        if (isOp(",")) take(); else break;
      }
      expectOp("]");
      return { t: "list", items };
    }
    if (token.k === "id") {
      if (token.v === "true") return { t: "lit", v: true };
      if (token.v === "false") return { t: "lit", v: false };
      if (token.v === "null") return { t: "lit", v: null };
      if (token.v === "visits" && isOp("(")) {
        take();
        const name = take();
        if (name.k !== "str" && name.k !== "id") throw new ExprSyntaxError(`visits() needs a node id at ${name.at}`);
        expectOp(")");
        return { t: "visits", node: name.v };
      }
      return { t: "ref", ref: refOf(token.v, options) };
    }
    throw new ExprSyntaxError(`unexpected ${token.k === "end" ? "end of expression" : `"${token.v}"`} at ${token.at}`);
  };
  const unary = (): Expr => { if (isOp("!")) { take(); return { t: "not", e: unary() }; } return primary(); };
  const add = (): Expr => {
    let left = unary();
    while (isOp("+") || isOp("-")) { const op = take().v as "+" | "-"; left = { t: "bin", op, l: left, r: unary() }; }
    return left;
  };
  const cmp = (): Expr => {
    const left = add();
    const token = peek();
    if (token.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(token.v)) { take(); return { t: "bin", op: token.v as "==", l: left, r: add() }; }
    if (token.k === "id" && token.v === "in") { take(); return { t: "bin", op: "in", l: left, r: add() }; }
    return left;
  };
  const and = (): Expr => { let left = cmp(); while (isOp("&&")) { take(); left = { t: "bin", op: "&&", l: left, r: cmp() }; } return left; };
  const or = (): Expr => { let left = and(); while (isOp("||")) { take(); left = { t: "bin", op: "||", l: left, r: and() }; } return left; };

  const result = or();
  if (peek().k !== "end") throw new ExprSyntaxError(`unexpected "${peek().v}" at ${peek().at}`);
  return result;
}

/** A structured condition of the first schema form, as the same expression (fields read from `source`). */
export function conditionToExpr(condition: Condition, source: string): Expr {
  if ("all" in condition) return condition.all.map((item) => conditionToExpr(item, source)).reduce((l, r) => ({ t: "bin", op: "&&", l, r }));
  if ("any" in condition) return condition.any.map((item) => conditionToExpr(item, source)).reduce((l, r) => ({ t: "bin", op: "||", l, r }));
  if ("not" in condition) return { t: "not", e: conditionToExpr(condition.not, source) };
  const parts = condition.field.split(".");
  const ref: Expr = { t: "ref", ref: { kind: "node", node: source, path: parts } };
  const value: Expr = Array.isArray(condition.value) ? { t: "list", items: condition.value.map((v) => ({ t: "lit", v })) } : { t: "lit", v: condition.value };
  switch (condition.op) {
    case "exists": return condition.value === false ? { t: "not", e: { t: "bin", op: "==", l: ref, r: { t: "lit", v: null } } } : { t: "bin", op: "!=", l: ref, r: { t: "lit", v: null } };
    case "eq": return { t: "bin", op: "==", l: ref, r: value };
    case "ne": return { t: "bin", op: "!=", l: ref, r: value };
    case "gt": return { t: "bin", op: ">", l: ref, r: value };
    case "gte": return { t: "bin", op: ">=", l: ref, r: value };
    case "lt": return { t: "bin", op: "<", l: ref, r: value };
    case "lte": return { t: "bin", op: "<=", l: ref, r: value };
    case "in": return { t: "bin", op: "in", l: ref, r: value };
    default: return { t: "not", e: { t: "bin", op: "in", l: ref, r: value } };
  }
}

export const toExpr = (when: Condition | string, source: string, options: { itemScope?: boolean } = {}): Expr =>
  typeof when === "string" ? parseExpr(when, options) : conditionToExpr(when, source);

/** Every reference and visits() an expression reads. */
export function exprRefs(expr: Expr, into: { refs: Ref[]; visits: string[] } = { refs: [], visits: [] }): { refs: Ref[]; visits: string[] } {
  switch (expr.t) {
    case "ref": into.refs.push(expr.ref); break;
    case "visits": into.visits.push(expr.node); break;
    case "not": exprRefs(expr.e, into); break;
    case "list": expr.items.forEach((item) => exprRefs(item, into)); break;
    case "bin": exprRefs(expr.l, into); exprRefs(expr.r, into); break;
    default: break;
  }
  return into;
}

// ------------------------------------------------------------------ static check

export type Kind = "bool" | "number" | "string" | "enum" | "array" | "any";
export type Typed = { kind: Kind; values?: string[] };

/** What the checker can ask of the workflow: the declared fields behind a reference. */
export type CheckEnv = {
  /** The declared fields of a node's output; null when the node is unknown or its fields cannot be known (a child workflow not loaded). */
  nodeFields(node: string): Field[] | null | "unknown";
  nodeExists(node: string): boolean;
  inputs: readonly Field[];
  /** Whether `node` runs before the expression is read. */
  before(node: string): boolean;
  inLoop: boolean;
  hasMode: boolean;
};

const kindOf = (field: { type: Field["type"]; values?: string[] }): Typed =>
  field.type === "number" ? { kind: "number" } : field.type === "boolean" ? { kind: "bool" } : field.type === "string" ? { kind: "string" }
    : field.type === "enum" ? { kind: "enum", values: field.values } : field.type === "array" ? { kind: "array" } : { kind: "any" };

/** Resolves `a.b.length` on a field list: its type, or why not. */
export function fieldPath(fields: readonly Field[], path: readonly string[]): Typed | { error: string } {
  const [head, ...rest] = path;
  const field = fields.find((candidate) => candidate.name === head);
  if (!field) return { error: `unknown field "${head}" (declared: ${fields.map((candidate) => candidate.name).join(", ") || "none"})` };
  if (rest.length === 0) return kindOf(field);
  if (field.type === "object" || field.type === "json") return { kind: "any" };
  if ((field.type === "array" || field.type === "string") && rest.length === 1 && rest[0] === "length") return { kind: "number" };
  if (field.type === "array" && field.ref) return { kind: "any" };
  return { error: `"${field.name}" is a ${field.type}; "${rest.join(".")}" cannot be read from it` };
}

export function checkRef(ref: Ref, env: CheckEnv, problems: string[], at: string): Typed {
  switch (ref.kind) {
    case "mode": if (!env.hasMode) problems.push(`${at}: $mode is not available here`); return { kind: "enum", values: ["quick", "standard", "full"] };
    case "var": return { kind: "string" };
    case "index": return { kind: "number" };
    case "item": return { kind: "any" };
    case "ctx": {
      if (!(CTX_VARS as readonly string[]).includes(ref.path[0] ?? "")) problems.push(`${at}: unknown context value "ctx.${ref.path.join(".")}" (available: ${CTX_VARS.join(", ")})`);
      return ref.path[0] === "merged_commits" ? { kind: "array" } : { kind: "any" };
    }
    case "input": {
      if (ref.path.length === 0) return { kind: "any" };
      const resolved = fieldPath(env.inputs, ref.path);
      if ("error" in resolved) { problems.push(`${at}: $inputs.${ref.path.join(".")}: ${resolved.error}`); return { kind: "any" }; }
      return resolved;
    }
    default: {
      const node = ref.node!;
      if (!env.nodeExists(node)) { problems.push(`${at}: "${node}" is not a node of this workflow`); return { kind: "any" }; }
      if (!env.before(node)) problems.push(`${at}: "${node}" does not run before this point`);
      if (ref.path.length === 0) return { kind: "any" };
      const fields = env.nodeFields(node);
      if (fields === "unknown" || fields === null) return { kind: "any" };
      const resolved = fieldPath(fields, ref.path);
      if ("error" in resolved) { problems.push(`${at}: ${node}.${ref.path.join(".")}: ${resolved.error}`); return { kind: "any" }; }
      return resolved;
    }
  }
}

/** Type-checks an expression; every problem is a string (the caller attaches the node or edge). Returns the type of the whole. */
export function checkExpr(expr: Expr, env: CheckEnv, problems: string[], at: string): Typed {
  switch (expr.t) {
    case "lit": return typeof expr.v === "number" ? { kind: "number" } : typeof expr.v === "boolean" ? { kind: "bool" } : typeof expr.v === "string" ? { kind: "string" } : { kind: "any" };
    case "ref": return checkRef(expr.ref, env, problems, at);
    case "visits": if (!env.nodeExists(expr.node)) problems.push(`${at}: visits('${expr.node}') names an unknown node`); return { kind: "number" };
    case "not": checkExpr(expr.e, env, problems, at); return { kind: "bool" };
    case "list": expr.items.forEach((item) => checkExpr(item, env, problems, at)); return { kind: "array" };
    case "bin": {
      const left = checkExpr(expr.l, env, problems, at), right = checkExpr(expr.r, env, problems, at);
      if (expr.op === "&&" || expr.op === "||") return { kind: "bool" };
      if (expr.op === "+" || expr.op === "-") {
        for (const side of [left, right]) if (side.kind !== "number" && side.kind !== "any") problems.push(`${at}: "${expr.op}" needs numbers, got ${side.kind}`);
        return { kind: "number" };
      }
      if (["<", "<=", ">", ">="].includes(expr.op)) {
        for (const side of [left, right]) if (side.kind !== "number" && side.kind !== "any") problems.push(`${at}: "${expr.op}" compares numbers, got ${side.kind}`);
        return { kind: "bool" };
      }
      if (expr.op === "in" && expr.r.t === "list" && expr.r.items.length === 0) problems.push(`${at}: in [] never matches`);
      if ((expr.op === "==" || expr.op === "!=") && (left.kind === "array" || right.kind === "array")) problems.push(`${at}: cannot compare a list with ${expr.op}`);
      const enumSide = left.kind === "enum" ? { typed: left, other: expr.r } : right.kind === "enum" ? { typed: right, other: expr.l } : null;
      if (enumSide?.typed.values) {
        const literals = enumSide.other.t === "lit" ? [enumSide.other.v] : enumSide.other.t === "list" ? enumSide.other.items.map((item) => (item.t === "lit" ? item.v : undefined)) : [];
        for (const value of literals) if (value !== undefined && value !== null && value !== "" && !enumSide.typed.values.includes(String(value))) problems.push(`${at}: ${JSON.stringify(value)} is not one of ${enumSide.typed.values.join(", ")}`);
      }
      if (left.kind !== "any" && right.kind !== "any" && left.kind !== right.kind && expr.op !== "in"
        && !((left.kind === "enum" && right.kind === "string") || (left.kind === "string" && right.kind === "enum"))) {
        problems.push(`${at}: ${left.kind} ${expr.op} ${right.kind} never matches`);
      }
      return { kind: "bool" };
    }
  }
}

// ------------------------------------------------------------------ evaluation

export type EvalEnv = {
  /** The value of a reference; `ran: false` when the node has not run (or the name is unknown). */
  read(ref: Ref): { ran: boolean; value: unknown };
  visits(node: string): number;
};

const truthy = (value: unknown): boolean => (Array.isArray(value) ? true : Boolean(value));
const blank = (v: unknown) => v === undefined || v === null || v === "";
const same = (a: unknown, b: unknown): boolean => a === b || (blank(a) && blank(b)) || (a !== null && b !== null && typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

export function evalExpr(expr: Expr, env: EvalEnv, at = "expression"): unknown {
  switch (expr.t) {
    case "lit": return expr.v;
    case "visits": return env.visits(expr.node);
    case "not": return !truthy(evalExpr(expr.e, env, at));
    case "list": return expr.items.map((item) => evalExpr(item, env, at));
    case "ref": {
      const read = env.read(expr.ref);
      if (!read.ran) throw new MissingValueError("condition_field_missing", `${at}: ${expr.ref.kind === "node" ? `"${expr.ref.node}" has not produced ${expr.ref.path.join(".") || "an output"} yet` : `${expr.ref.kind}.${expr.ref.path.join(".")} has no value`}`);
      return read.value;
    }
    case "bin": {
      if (expr.op === "&&") { const left = evalExpr(expr.l, env, at); return truthy(left) ? truthy(evalExpr(expr.r, env, at)) : false; }
      if (expr.op === "||") { const left = evalExpr(expr.l, env, at); return truthy(left) ? true : truthy(evalExpr(expr.r, env, at)); }
      const left = evalExpr(expr.l, env, at), right = evalExpr(expr.r, env, at);
      switch (expr.op) {
        case "==": return same(left, right);
        case "!=": return !same(left, right);
        case "in": return Array.isArray(right) && right.some((item) => same(item, left));
        case "+": case "-":
          if (typeof left !== "number" || typeof right !== "number") throw new MissingValueError("condition_type", `${at}: "${expr.op}" needs two numbers`);
          return expr.op === "+" ? left + right : left - right;
        default: {
          // Compared with nothing, a number is neither smaller nor larger: the branch is not taken, as before; a missing node already threw.
          if (typeof left !== "number" || typeof right !== "number") return false;
          return expr.op === "<" ? left < right : expr.op === "<=" ? left <= right : expr.op === ">" ? left > right : left >= right;
        }
      }
    }
  }
}

export const evalCondition = (expr: Expr, env: EvalEnv, at?: string): boolean => truthy(evalExpr(expr, env, at));

// ------------------------------------------------------------------ value specs and templates

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
export const placeholdersIn = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);

/** A string in an expression-valued position (`emit.map`, `skip_out`): literal or expression, by the rules of spec section 0.3. */
export type ValueSpec = { literal: unknown } | { expr: Expr };
export function valueSpecOf(value: unknown): ValueSpec {
  if (typeof value !== "string") return { literal: value };
  const text = value.trim();
  if (text === "") return { literal: "" };
  // `{{node}}` or `{{node.field}}`: the whole value of a node (a bare word alone is a literal, `refactor` metrics are not).
  const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(text);
  if (whole) return { expr: { t: "ref", ref: refOf(whole[1]!) } };
  if (/^'.*'$/s.test(text) || /^".*"$/s.test(text)) return { literal: text.slice(1, -1) };
  if (/^[[{]/.test(text)) { try { return { literal: JSON.parse(text) as unknown }; } catch { /* an expression with a list in it */ } }
  if (/^(true|false|null)$/.test(text)) return { literal: text === "true" ? true : text === "false" ? false : null };
  if (/^-?\d+(\.\d+)?$/.test(text)) return { literal: Number(text) };
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(text)) return { literal: text };
  // A path (`docs/specs/x.md`) is text, not a division.
  if (/^[\w@.~-]*\/[\w@./~-]*$/.test(text)) return { literal: text };
  return { expr: parseExpr(text) };
}

export const evalSpec = (spec: ValueSpec, env: EvalEnv, at?: string): unknown => ("literal" in spec ? spec.literal : evalExpr(spec.expr, env, at));

/** A `{{ref}}` template: a string that is one placeholder keeps the value's type; otherwise the values are written into the text. */
export function renderValue(value: unknown, read: (ref: Ref, text: string) => unknown, mode: string | null): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
    if (whole) return read(refOf(whole[1]!), whole[1]!);
    return value.replace(PLACEHOLDER, (_match, text: string) => {
      const found = read(refOf(text), text);
      return found === undefined || found === null ? "" : typeof found === "string" ? found : JSON.stringify(found);
    });
  }
  // A placeholder in a list that names nothing (a node that did not run) leaves no hole behind.
  if (Array.isArray(value)) return value.map((item) => renderValue(item, read, mode)).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("by_mode" in record && Object.keys(record).length === 1) {
      const table = record.by_mode as Record<string, unknown>;
      if (mode === null) throw new MissingValueError("mode_missing", "by_mode needs a quality mode");
      return renderValue(mode in table ? table[mode] : table.default, read, mode);
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, renderValue(item, read, mode)]));
  }
  return value;
}
