import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const platformSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"provider.folder_block_ttl_ms","room":"platform","default":null,"defaultValue":"","bounds":{"kind":"int","min":0},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"Provider folder hold duration"}}),
];
