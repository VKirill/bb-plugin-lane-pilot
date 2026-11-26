import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

/** The project setting that narrows the Env Catalog names a check may be given (J4). Unset or empty: every name the task contract declares. */
export const SECRETS_ALLOW_KEY = "secrets.allow";

export const secretsSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"secrets.allow","room":"secrets","default":"","bounds":{"kind":"string"},"ui":{"id":"s422","status":"editable","control":"input","section":"stages","scope":"project","invType":"csv"}}),
];
