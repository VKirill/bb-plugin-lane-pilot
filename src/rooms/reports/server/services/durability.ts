import { GRAPHS_LAST_EXPORT_AT_KEY } from "@lane-pilot/workflow-engine";
import { readOwnerConfigKey } from "../../../owner-waiting/server";
import type { LanePilotDatabase } from "../../../storage";
import { listWorkflowGitDrift } from "../../../workflow/server";
import {
  buildDurabilityDeskItems,
  formatDurabilitySection,
  type DurabilityDeskItem,
  type DurabilitySummary,
} from "../../models/durability";

export type { DurabilityDeskItem, DurabilitySummary };
export { GRAPHS_LAST_EXPORT_AT_KEY };

function parseStoredTimestamp(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  return null;
}

/** Reads `graphs.last_export_at` from plugin KV when supplied, falling back to `lane_pilot_owner_config`. */
export async function readLastGraphExportAt(
  db: LanePilotDatabase,
  kv?: { get(key: string): Promise<unknown> },
): Promise<number | null> {
  const fromKv = kv ? parseStoredTimestamp(await kv.get(GRAPHS_LAST_EXPORT_AT_KEY)) : null;
  if (fromKv !== null) return fromKv;
  return parseStoredTimestamp(readOwnerConfigKey(db, GRAPHS_LAST_EXPORT_AT_KEY));
}

/** Collects hub-to-git graph drift and the last export timestamp synchronously for the weekly review desk. */
export function collectGraphDurability(
  db: LanePilotDatabase,
  options: { workflowsDir?: string; lastExportAt?: number | null } = {},
): DurabilitySummary {
  const drifted = listWorkflowGitDrift(db, { workflowsDir: options.workflowsDir });
  const lastExportAt = options.lastExportAt !== undefined
    ? options.lastExportAt
    : parseStoredTimestamp(readOwnerConfigKey(db, GRAPHS_LAST_EXPORT_AT_KEY));
  const lastExportDate = lastExportAt !== null ? new Date(lastExportAt).toISOString().slice(0, 10) : null;
  return { drifted, lastExportAt, lastExportDate };
}

/** Async wrapper that resolves `graphs.last_export_at` from plugin KV before building the durability summary. */
export async function loadGraphDurability(
  db: LanePilotDatabase,
  options: { workflowsDir?: string; kv?: { get(key: string): Promise<unknown> } } = {},
): Promise<DurabilitySummary> {
  const lastExportAt = await readLastGraphExportAt(db, options.kv);
  return collectGraphDurability(db, { workflowsDir: options.workflowsDir, lastExportAt });
}

/** Composes the §7 durability section (text + desk items) for the weekly review desk. */
export function composeDurabilityDeskSection(
  db: LanePilotDatabase,
  options: { workflowsDir?: string; lastExportAt?: number | null } = {},
): { summary: DurabilitySummary; text: string; items: DurabilityDeskItem[] } {
  const summary = collectGraphDurability(db, options);
  return {
    summary,
    text: formatDurabilitySection(summary),
    items: buildDurabilityDeskItems(summary),
  };
}
