import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const errandsSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"episodes.collect","room":"errands","default":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"id":"s611","status":"editable","control":"select","section":"improvement","scope":"global","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":"episodes.process_key","room":"errands","default":"shadow","bounds":{"kind":"enum","options":["shadow","active"],"strictOptions":true},"ui":{"id":"s612","status":"editable","control":"select","section":"improvement","scope":"global","options":["shadow","active"],"invType":"enum"}}),
];
