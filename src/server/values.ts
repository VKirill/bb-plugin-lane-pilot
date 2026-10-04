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

/** Set right before a worktree holder thread is spawned for an attempt: the one case a holder can be lost. */
export const holderSpawnKey = (attemptId:string) => `holder-spawn:${attemptId}`;
