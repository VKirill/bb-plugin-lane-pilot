import { randomUUID } from "node:crypto";

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function valueAt(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

export function stringAt(value: unknown, key: string): string | null {
  const found = valueAt(value, key);
  return typeof found === "string" && found.length > 0 ? found : null;
}

export function outputText(value: unknown): string {
  for (const key of ["text", "output", "lastAssistantText", "content"]) {
    const found = valueAt(value, key);
    if (typeof found === "string") return found;
  }
  return JSON.stringify(value);
}
