import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const backlogSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"backlog.scan_minutes","room":"backlog","default":60,"bounds":{"kind":"int","min":5},"ui":{"id":"s613","status":"editable","control":"number","section":"improvement","scope":"project","min":5,"invType":"int"}}),
  defineSetting({"key":"backlog.auto_issue","room":"backlog","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Auto-issue ready backlog items into PM chat"}}),
];
