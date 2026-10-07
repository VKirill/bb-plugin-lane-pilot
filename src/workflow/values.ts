import { MissingValueError } from "./expr";
import type { Field } from "./schema";

export { MissingValueError };

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
