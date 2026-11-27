import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const DOCS_ENABLED_KEY = "docs.enabled";

export const docsSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"docs.enabled","room":"docs","default":"false","bounds":{"kind":"enum","options":["auto","true","false"],"strictOptions":true},"ui":{"id":"s115","status":"editable","control":"select","section":"docs","scope":"project","options":["auto","true","false"],"invType":"bool"}}),
];
