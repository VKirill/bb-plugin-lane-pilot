import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LP_DEFAULTS_KEY, parseLanePilotDefaults } from "@lane-pilot/settings-catalog";
import { getRunSettingsScopes, loadProjectSettings } from "../../storage";
import type { LanePilotDatabase } from "../../storage";

/**
 * The settings a stage helper reads when it spawns: the run's scopes over the project and global rows, with the «Общие
 * настройки» writer choice under them. The writer's own spawn reads these same layers (effectiveProjectSettings). A helper
 * that read only the rows kept the run's frozen writer whenever the choice was saved as a global default.
 * Only the writer keys the user saved are added: the codex fallback of inheritProjectValues stays out, so a helper with no
 * setting at all still falls back to the run's config.
 */
export async function stageHelperSettings(bb: BbPluginApi, db: LanePilotDatabase, projectId: string, runId: string): Promise<Record<string, unknown>> {
  const rows = loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId));
  const defaults = parseLanePilotDefaults(await bb.storage.kv.get(LP_DEFAULTS_KEY));
  const globals: Record<string, unknown> = {};
  const inherit = (key: string, value: string | undefined) => {
    if (value && !Object.hasOwn(rows, key)) globals[key] = value;
  };
  inherit("writer.provider", defaults.writerProviderId);
  inherit("writer.model", defaults.writerModel);
  inherit("writer.reasoning_effort", defaults.writerReasoningEffort);
  return { ...globals, ...rows };
}
