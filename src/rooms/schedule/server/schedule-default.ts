import { getSettingVersions, loadProjectSettings, type LanePilotDatabase } from "../../storage/database";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { SCHEDULE_ERRAND_DEFAULT_KEY, parseErrandDefault, resolveErrandModel, type ErrandModelTask } from "../errand-model";
import type { ErrandDefaultView, ModelView } from "../views";
import type { ServerCore } from "../../core/server/core";
import { stringAt } from "../../core/server/values";

/**
 * The Automation default model (`schedule.errand_default`) as the board shows and edits it, and the errand model of a schedule as it
 * resolves now. Both read the same settings rows the executor reads (the project's own row over the global one), so the card and the run agree.
 */
const ownRow = (db: LanePilotDatabase, projectId: string): unknown => {
  const row = db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?").get(projectId, SCHEDULE_ERRAND_DEFAULT_KEY) as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
};

/** The default at the project level, at the global level and the one in force; `projectId` null reads the global level only. */
export function readErrandDefault(db: LanePilotDatabase, projectId: string | null): ErrandDefaultView {
  const global = parseErrandDefault(ownRow(db, GLOBAL_SETTINGS_PROJECT_ID));
  const project = projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? parseErrandDefault(ownRow(db, projectId)) : null;
  const version = (id: string) => getSettingVersions(db, id, [SCHEDULE_ERRAND_DEFAULT_KEY])[SCHEDULE_ERRAND_DEFAULT_KEY] ?? 0;
  return {
    effective: project ?? global, source: project ? "project" : global ? "global" : null, project, global,
    projectVersion: projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? version(projectId) : 0, globalVersion: version(GLOBAL_SETTINGS_PROJECT_ID),
  };
}

/**
 * The model an errand task resolves to for its project, as a view. Without the PM's model: that level is reached only when the role default
 * has no model, which the built-in default prevents (src/schedule/errand-model.ts), so the sync view and the executor never differ.
 */
export function errandModelView(db: LanePilotDatabase, projectId: string, task: ErrandModelTask): ModelView {
  const resolved = resolveErrandModel({ task, settings: loadProjectSettings(db, projectId), pm: null });
  return { providerId: resolved.providerId, model: resolved.model, reasoningEffort: resolved.reasoningEffort, serviceTier: resolved.serviceTier, source: resolved.source, sourceKey: resolved.sourceKey, issues: resolved.issues };
}

/** The model a run of the errand starts on: the sync resolution plus the model of the project's PM chat for the last-resort level. */
export async function errandModelForRun(ctx: ServerCore, projectId: string, pmThreadId: string, task: ErrandModelTask) {
  let pm: { providerId: string; model: string } | null = null;
  try {
    const options = await ctx.bb.sdk.threads.defaultExecutionOptions({ threadId: pmThreadId });
    const providerId = stringAt(options, "providerId"), model = stringAt(options, "model");
    pm = providerId && model ? { providerId, model } : null;
  } catch { pm = null; }
  return resolveErrandModel({ task, settings: loadProjectSettings(ctx.db, projectId), pm });
}
