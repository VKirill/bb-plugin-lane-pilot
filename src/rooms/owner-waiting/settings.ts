import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const ownerWaitingSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"owner_push.enabled","room":"owner-waiting","default":true,"bounds":{"kind":"hub","options":["true","false"]},"ui":{"id":"s495","status":"editable","control":"switch","section":"improvement","scope":"global","options":["true","false"],"invType":"bool"}}),
  defineSetting({"key":"owner_push.quiet","room":"owner-waiting","default":"23:00-08:00","bounds":{"kind":"time_range"},"ui":{"id":"s496","status":"editable","control":"input","section":"improvement","scope":"global","options":["23:00-08:00"],"invType":"string"}}),
  defineSetting({"key":"owner_push.timezone","room":"owner-waiting","default":"Europe/Madrid","bounds":{"kind":"time_zone"},"ui":{"id":"s497","status":"editable","control":"input","section":"improvement","scope":"global","options":["Europe/Madrid"],"invType":"string"}}),
  defineSetting({"key":"protection.rearm","room":"owner-waiting","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"off: a protection whose disarm term ended stays off (unset: the daily pass switches it back on, to the level it had before, and tells the owner)"}}),
];
