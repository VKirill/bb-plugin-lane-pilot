// The settings-validation contract storage depends on. The settings room registers its implementation
// (src/rooms/settings/setting-validation.ts calls registerSettingValidator at load) so storage imports no room.
export type SettingValidationError = {
  code: "invalid_choice" | "incompatible_setting";
  key: string;
  params: string[];
};

export interface SettingsValidator {
  validateSettingValue(key: string, value: unknown): SettingValidationError | null;
  validateSettingsObject(settings: Record<string, unknown>): SettingValidationError[];
}

let validator: SettingsValidator | undefined;

/** Called by the settings room when its validation module loads; test setup imports that module for the same effect. */
export function registerSettingValidator(next: SettingsValidator): void {
  validator = next;
}

export function settingValidator(): SettingsValidator {
  if (!validator) throw new Error("setting validation is not registered — import the settings room's setting-validation module");
  return validator;
}
