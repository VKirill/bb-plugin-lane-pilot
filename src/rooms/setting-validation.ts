// Composition root re-export: storage's casUpsertSetting(s) validates through the settings room's rules without importing the room.
export { allowedSettingChoices, invalidChoiceReason, normalizeWriterEffort, validateSettingValue, validateSettingsObject, validationErrorText } from "./settings/setting-validation";
export type { SettingValidationError } from "./settings/setting-validation";
