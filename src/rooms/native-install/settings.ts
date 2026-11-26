import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const nativeInstallSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"install.CLAUDE_CONFIG_DIR","room":"native-install","default":"","bounds":{"kind":"path"},"ui":{"id":"s248","status":"editable","control":"input","section":"setup","scope":"global","options":["path"],"invType":"env","channel":"INSTALL-ENV","legacyName":"CLAUDE_CONFIG_DIR"}}),
  defineSetting({"key":"install.CODEX_HOME","room":"native-install","default":"~/.codex","bounds":{"kind":"path"},"ui":{"id":"s249","status":"editable","control":"input","section":"setup","scope":"global","options":["path"],"invType":"env","channel":"INSTALL-ENV","legacyName":"CODEX_HOME"}}),
  defineSetting({"key":"install.LANE_INSTALL_CLAUDE_PLUGIN","room":"native-install","default":"1","bounds":{"kind":"string"},"ui":{"id":"s247","status":"editable","control":"input","section":"setup","scope":"global (install-time)","options":["0","other"],"invType":"env","channel":"INSTALL-ENV","legacyName":"LANE_INSTALL_CLAUDE_PLUGIN"}}),
  defineSetting({"key":"install.LANE_INSTALL_LOCAL_MARKETPLACE","room":"native-install","default":"0","bounds":{"kind":"string"},"ui":{"id":"s246","status":"editable","control":"input","section":"setup","scope":"global (install-time)","options":["0","truthy"],"invType":"env","channel":"INSTALL-ENV","legacyName":"LANE_INSTALL_LOCAL_MARKETPLACE"}}),
];
