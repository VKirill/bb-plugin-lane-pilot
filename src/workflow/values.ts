import type { Condition, Field } from "./schema";

/** A condition or a mapping met a value that is not there. The step fails closed instead of taking a default branch. */
export class MissingValueError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || current === undefined) return undefined;
    if (part === "length" && (Array.isArray(current) || typeof current === "string")) { current = current.length; continue; }
    if (typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const same = (a: unknown, b: unknown): boolean => a === b || (a !== null && b !== null && typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

/**
 * Evaluates a condition on a node's output. A required declared field that is absent is an error (the output was checked
 * when the step ended, so this means a bug); an absent optional field or a deeper path makes every comparison false and
 * `exists` false. Maestro compared a missing value as 0, so `x < 60` held for nothing at all.
 */
export function evalCondition(condition: Condition, output: Record<string, unknown>, fields: readonly Field[], where = "condition"): boolean {
  if ("all" in condition) return condition.all.every((item) => evalCondition(item, output, fields, where));
  if ("any" in condition) return condition.any.some((item) => evalCondition(item, output, fields, where));
  if ("not" in condition) return !evalCondition(condition.not, output, fields, where);
  const path = condition.field.split(".");
  const root = fields.find((field) => field.name === path[0]);
  const value = valueAtPath(output, path);
  if (condition.op === "exists") {
    const present = value !== undefined && value !== null;
    return condition.value === false ? !present : present;
  }
  if (value === undefined || value === null) {
    if (root?.required && path.length === 1 && root.type !== "json") {
      throw new MissingValueError("condition_field_missing", `${where}: required field "${condition.field}" has no value`);
    }
    return false;
  }
  switch (condition.op) {
    case "eq": return same(value, condition.value);
    case "ne": return !same(value, condition.value);
    case "in": return Array.isArray(condition.value) && condition.value.some((item) => same(item, value));
    case "notIn": return Array.isArray(condition.value) && !condition.value.some((item) => same(item, value));
    default: {
      if (typeof value !== "number" || typeof condition.value !== "number") return false;
      return condition.op === "gt" ? value > condition.value : condition.op === "gte" ? value >= condition.value
        : condition.op === "lt" ? value < condition.value : value <= condition.value;
    }
  }
}

const typeOk = (field: Field, value: unknown): boolean => {
  switch (field.type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "enum": return typeof value === "string" && field.values!.includes(value);
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    default: return value !== undefined;
  }
};

/** The output of a step against its declared fields: the declared ones, typed, and nothing else. Throws with the first problem. */
export function checkOutput(fields: readonly Field[], output: unknown): Record<string, unknown> {
  if (typeof output !== "object" || output === null || Array.isArray(output)) throw new MissingValueError("output_invalid", "output is not an object");
  const source = output as Record<string, unknown>, kept: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field.name];
    if (value === undefined || value === null) {
      if (field.required) throw new MissingValueError(field.name === "handoff" ? "handoff_missing" : "output_invalid", `output field "${field.name}" is missing`);
      continue;
    }
    if (!typeOk(field, value)) throw new MissingValueError("output_invalid", `output field "${field.name}" is not a valid ${field.type}${field.type === "enum" ? ` (${field.values!.join("|")})` : ""}`);
    if (field.name === "handoff" && typeof value === "string" && !value.trim()) throw new MissingValueError("handoff_missing", "the handoff is empty");
    kept[field.name] = value;
  }
  return kept;
}

export function renderTemplate(template: string, lookup: (ref: string) => unknown): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, ref: string) => {
    const value = lookup(ref);
    return value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  });
}
