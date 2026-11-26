import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const MONEY_CAP_UNSET_ZERO_KEY = "money.cap_unset_zero";
export const MONEY_SILENT_ESTIMATE_TOKENS_KEY = "money.silent_estimate_tokens";
export const MONEY_TASK_CEILING_KEY = "money.task_ceiling";
export const MONEY_MONTHLY_CAP_USD_KEY = "money.monthly_cap_usd";

export const moneySettings: readonly SettingDefinition[] = [
  defineSetting({"key":"money.cap_unset_zero","room":"money","default":"on","defaultValue":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"an unset money cap reads as zero for paid lanes: a lane paid by the token stays closed until the monthly cap is set, subscription lanes never wait for money (unset: on; off: an unset cap means no limit)"}}),
  defineSetting({"key":"money.silent_estimate_tokens","room":"money","default":null,"defaultValue":"","bounds":{"kind":"number","min":0},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"an attempt whose paid provider reported no usage is priced at this many tokens"}}),
  defineSetting({"key":"money.strict","room":"money","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"a free subscription member of the writer chain is taken before a free paid one that stands earlier"}}),
  defineSetting({"key":"money.task_ceiling","room":"money","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"with a money cap set, a task whose estimate would pass the cap waits for next month"}}),
  defineSetting({"key":"money.monthly_cap_usd","room":"money","default":null,"defaultValue":"","bounds":{"kind":"string"},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"Monthly paid-lane cap USD or 'unlimited'"}}),
];
