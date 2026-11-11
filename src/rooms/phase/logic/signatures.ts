import { sha256Hex } from "@lane-pilot/kit";
import type { ContextDoc, PlanItem } from "./record";

/** Stable JSON (sorted keys) so the same plan always has the same hash. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** The signature of the discussion: the documents' paths and hashes, in path order. */
export const contextSignature = (docs: readonly ContextDoc[]) => sha256Hex(canonical([...docs].sort((a, b) => a.path.localeCompare(b.path)).map((doc) => [doc.path, doc.sha256])));
export const planSignature = (items: readonly PlanItem[], contextSha: string) => sha256Hex(canonical({ contextSha, items }));
