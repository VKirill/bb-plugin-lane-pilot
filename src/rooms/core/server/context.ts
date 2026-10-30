import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LanePilotDatabase } from "../../storage";
import { VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";
import type { Realtime } from "./realtime";

/** What every server module gets instead of reaching into the closure of `plugin()`. */
export type ServerContext = {
  bb: BbPluginApi;
  db: LanePilotDatabase;
  log: (message: string) => void;
  isDisposed: () => boolean;
  /** Tells open screens to re-read; absent in a bare context built by a test. */
  realtime?: Realtime;
};

/** A setting by its catalog name, whether stored under that name or under its storage key. */
export function configuredSetting(settings: Record<string, unknown>, setting: string): unknown {
  if (Object.hasOwn(settings, setting)) return settings[setting];
  const row = VISIBLE_CATALOG.find((item) => item.setting === setting);
  return row ? settings[row.storageKey] : undefined;
}

/**
 * The calling thread's plugin metadata: `context.experimental_vkPluginMetadata` carries the same row on VK cores
 * (core fba7d8b0a), saving the loopback call; the SDK read stays the fallback on stock BB.
 */
export async function callerPluginMetadata(
  bb: BbPluginApi,
  context: { threadId: string | null; experimental_vkPluginMetadata?: unknown },
): Promise<Record<string, unknown> | null> {
  if (context.experimental_vkPluginMetadata !== undefined) return context.experimental_vkPluginMetadata as Record<string, unknown> | null;
  if (!context.threadId) return null;
  return (await bb.sdk.threads.getPluginMetadata({ threadId: context.threadId })) as Record<string, unknown> | null;
}

/** The PM thread of an open run of this project; anything else is refused before any work starts. */
export function requirePmRun(db: LanePilotDatabase, input: { runId: string; threadId: string; projectId: string }): { id: string; project_id: string } {
  const run = db.prepare("SELECT id, project_id, pm_thread_id, closed_at FROM lane_pilot_run WHERE id=?").get(input.runId) as
    { id: string; project_id: string; pm_thread_id: string | null; closed_at: number | null } | undefined;
  if (!run || run.project_id !== input.projectId || run.pm_thread_id !== input.threadId || run.closed_at) {
    throw new Error("runId does not belong to this active Lane Pilot PM thread and project");
  }
  return run;
}
