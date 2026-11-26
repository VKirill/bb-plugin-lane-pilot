import type { MemorySettings } from "@lane-pilot/memory-core";

export function childResultObject(result: unknown): Record<string, unknown> {
  return result && typeof result === "object" ? { ...(result as Record<string, unknown>) } : {};
}

/** BB refused the spawn request (e.g. «HTTP 409: Environment unavailable»), so no child thread exists. */
export function spawnRefused(reason: string): boolean {
  return /^HTTP 4\d\d\b/.test(reason);
}

export type MemoryChildSnapshot = {
  acceptanceSha256: string;
  settings: MemorySettings;
  agent: string;
  dispatchInput?: unknown;
  /** J-002 wave batch: the pending accepted-fact rows this run summarizes and the task ids to stamp on success. */
  facts?: Array<{ taskId: string; title: string; acceptedResult: unknown }>;
  factTaskIds?: string[];
};

export function memoryChildSnapshot(result: unknown): MemoryChildSnapshot | null {
  const snapshot = childResultObject(result).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const row = snapshot as Record<string, unknown>;
  if (typeof row.acceptanceSha256 !== "string" || typeof row.agent !== "string" || !row.settings || typeof row.settings !== "object") return null;
  const settings = row.settings as MemorySettings;
  if (typeof settings.enabled !== "boolean" || typeof settings.coreBudget !== "number") return null;
  return {
    acceptanceSha256: row.acceptanceSha256,
    settings,
    agent: row.agent,
    ...(row.dispatchInput !== undefined ? { dispatchInput: row.dispatchInput } : {}),
    ...(Array.isArray(row.facts) ? { facts: row.facts as MemoryChildSnapshot["facts"] } : {}),
    ...(Array.isArray(row.factTaskIds) ? { factTaskIds: row.factTaskIds as string[] } : {}),
  };
}
