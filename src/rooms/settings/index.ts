// Public API of settings: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { argvValidationMap, coupledSettingKeys, validateSettingChanges, validateSettingValue, validateSettingsObject, validationErrorText } from "./setting-validation";
export type { SettingValidationError } from "./setting-validation";
export { UNLISTED_SWITCHES, switchValue } from "./switches";
export type { SwitchScope } from "./switches";
