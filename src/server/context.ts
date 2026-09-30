import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LanePilotDatabase } from "../database";
import { VISIBLE_CATALOG } from "../ui-catalog";

/** What every server module gets instead of reaching into the closure of `plugin()`. */
export type ServerContext = {
  bb: BbPluginApi;
  db: LanePilotDatabase;
  log: (message: string) => void;
  isDisposed: () => boolean;
};

/** A setting by its catalog name, whether stored under that name or under its storage key. */
export function configuredSetting(settings: Record<string, unknown>, setting: string): unknown {
  if (Object.hasOwn(settings, setting)) return settings[setting];
  const row = VISIBLE_CATALOG.find((item) => item.setting === setting);
  return row ? settings[row.storageKey] : undefined;
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
