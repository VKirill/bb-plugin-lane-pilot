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
  /** The keys whose validity is judged together with `key` (the writer provider/effort pair); absent: the key stands alone. */
  coupledSettingKeys?(key: string): readonly string[];
  /** The first validation error a save of `changedKeys` would break, or null; `skipKeys` are keys the caller already validated. Absent: every stored value is judged. */
  validateSettingChanges?(changedKeys: readonly string[], settings: Record<string, unknown>, skipKeys?: readonly string[]): SettingValidationError | null;
}
