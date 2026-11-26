import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const BASELINE_ALREADY_BUILT_KEY = "baseline.already_built";
export const BASELINE_TIME_CAP_SEC_KEY = "baseline.time_cap_sec";
export const CHECKS_REQUIRE_RED_ON_BASE_KEY = "checks.require_red_on_base";

export const baselineSettings: readonly SettingDefinition[] = [
  defineSetting({"key":BASELINE_ALREADY_BUILT_KEY,"room":"baseline","default":"notify","bounds":{"kind":"hub","options":["notify","stop"]},"ui":{"id":"s498","status":"editable","control":"select","section":"improvement","scope":"project","options":["notify","stop"],"invType":"enum"}}),
  defineSetting({"key":BASELINE_TIME_CAP_SEC_KEY,"room":"baseline","default":300,"bounds":{"kind":"hub","min":0,"max":3600,"zeroOff":true},"ui":{"id":"s499","status":"editable","control":"number","section":"improvement","scope":"project","min":0,"max":3600,"invType":"int"}}),
  defineSetting({"key":CHECKS_REQUIRE_RED_ON_BASE_KEY,"room":"baseline","default":"medium","bounds":{"kind":"hub","options":["off","medium","high"]},"ui":{"id":"s506","status":"editable","control":"select","section":"improvement","scope":"project","options":["off","medium","high"],"invType":"enum"}}),
];
