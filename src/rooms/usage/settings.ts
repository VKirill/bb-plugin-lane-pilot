import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const USAGE_SKIP_KEY = "usage.skip_percent";
export const DEFAULT_USAGE_SKIP_PERCENT = 90;

export const usageSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"usage.skip_percent","room":"usage","default":90,"bounds":{"kind":"int","min":0,"max":100},"ui":{"id":"s420","status":"editable","control":"number","section":"writer","scope":"project","min":0,"max":100,"invType":"int"}}),
];
