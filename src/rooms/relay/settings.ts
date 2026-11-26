import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const relaySettings: readonly SettingDefinition[] = [
  defineSetting({"key":"ui.language","room":"relay","default":"en","bounds":{"kind":"enum","options":["en","ru"],"strictOptions":true},"ui":{"id":"s183","status":"editable","control":"select","section":"language","scope":"project AND global (dual)","options":["en","ru"],"invType":"enum","legacyName":"language"}}),
  defineSetting({"key":"events.webhook_url","room":"relay","default":"","defaultValue":"","bounds":{"kind":"string"},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Outbound event webhook URL"}}),
];
