// Public API of settings: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { readImportConfig } from "./import-config";
export { validateSettingValue, validateSettingsObject, validationErrorText } from "./setting-validation";
export type { SettingValidationError } from "./setting-validation";

/**
 * Restart-only settings (SMA: Restart-only settings): read once when the plugin starts, so a change applies after the next reload
 * (bb plugin reload lane-pilot, or a deploy). The settings screen marks them; save_setting stores them like any other.
 */
export const RESTART_ONLY_SETTINGS: readonly string[] = ["jev.provider", "workspace.provider", "sandbox.backend"];
