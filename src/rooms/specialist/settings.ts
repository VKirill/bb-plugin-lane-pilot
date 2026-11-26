import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const specialistSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"specialist.agent","room":"specialist","default":"specialist-reviewer","bounds":{"kind":"string"},"ui":{"id":"s096","status":"editable","control":"input","section":"specialist","scope":"project","invType":"str"}}),
  defineSetting({"key":"specialist.enabled","room":"specialist","default":false,"bounds":{"kind":"boolean","options":["true","false"]},"ui":{"id":"s091","status":"editable","control":"select","section":"other","scope":"project","options":["true","false"],"invType":"bool"}}),
  defineSetting({"key":"specialist.model","room":"specialist","default":"","bounds":{"kind":"string"},"ui":{"id":"s094","status":"editable","control":"input","section":"other","scope":"project","invType":"str"}}),
  defineSetting({"key":"specialist.provider","room":"specialist","default":"codex","bounds":{"kind":"enum","options":[],"strictOptions":false},"ui":{"id":"s093","status":"editable","control":"select","section":"other","scope":"project","invType":"enum"}}),
  defineSetting({"key":"specialist.reasoning_effort","room":"specialist","default":"high","bounds":{"kind":"string"},"ui":{"id":"s095","status":"editable","control":"input","section":"other","scope":"project","invType":"str"}}),
  defineSetting({"key":"specialist.when","room":"specialist","default":"high_risk","bounds":{"kind":"enum","options":["high_risk","always"],"strictOptions":true},"ui":{"id":"s092","status":"editable","control":"select","section":"other","scope":"project","options":["high_risk","always"],"invType":"enum"}}),
  defineSetting({"key":"specialist.service_tier","room":"specialist","default":"","defaultValue":"","bounds":{"kind":"enum","options":["standard","fast"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Specialist service tier selection"}}),
];
