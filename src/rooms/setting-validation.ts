// The settings-validation contract storage depends on. The composition root (server.ts) and the test/script
// entry (src/rooms/plugin-db.ts) pass the settings room's implementation to openDatabase — storage imports no room.
export type SettingValidationError = {
  code: "invalid_choice" | "incompatible_setting";
  key: string;
  params: string[];
};

export interface SettingsValidator {
  validateSettingValue(key: string, value: unknown): SettingValidationError | null;
  validateSettingsObject(settings: Record<string, unknown>): SettingValidationError[];
}
