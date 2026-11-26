import { GLOBAL_SETTINGS_PROJECT_ID, type SettingSource } from "@lane-pilot/settings-catalog";
import { SETTINGS_REGISTRY } from "../../../settings-registry";
import { listSettingRows, loadProjectSettings, type LanePilotDatabase } from "../../../storage";

/**
 * Typed read against SQLite (`lane_pilot_project_settings`): resolves `project` -> `global` (`*`) -> registered `default`,
 * and logs `DEBUG settings.read key=<k> source=project|global|default` once per key per run.
 */
export function readProjectSetting<T = unknown>(
  db: LanePilotDatabase,
  projectId: string,
  key: string,
  opts?: { scopes?: readonly string[]; runId?: string; debug?: (message: string) => void },
): { value: T; source: SettingSource } {
  const globalValues = loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID);
  const projectOnly: Record<string, unknown> = {};
  if (projectId !== GLOBAL_SETTINGS_PROJECT_ID) {
    const layers = ["", ...(opts?.scopes ?? [])];
    for (const bindingId of layers) {
      for (const row of listSettingRows(db, projectId, bindingId)) {
        projectOnly[row.key] = row.value;
      }
    }
  }
  return SETTINGS_REGISTRY.read<T>(key, {
    project: projectId === GLOBAL_SETTINGS_PROJECT_ID ? undefined : projectOnly,
    global: globalValues,
    runId: opts?.runId,
    debug: opts?.debug,
  });
}
