import { defineSetting, type SettingDefinition, type SettingKeyFamily } from "@lane-pilot/settings-catalog";

export const nativeAgentSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"adoc.040","room":"native-agent","default":"auto","bounds":{"kind":"enum","options":["worktree","auto"],"strictOptions":true},"ui":{"id":"s040","status":"editable","control":"select","section":"workspace","scope":"project","options":["worktree","auto"],"invType":"str","legacyName":"workspace.mode"}}),
  defineSetting({"key":"codex.lean_roles","room":"native-agent","default":"default","bounds":{"kind":"string"},"ui":{"id":"s623","status":"editable","control":"input","section":"stages","scope":"global","invType":"str"}}),
  defineSetting({"key":"helper.bb_plugins","room":"native-agent","default":"","bounds":{"kind":"string"},"ui":{"id":"s369","status":"editable","control":"input","section":"stages","scope":"project","invType":"csv"}}),
  defineSetting({"key":"helper.context_mode","room":"native-agent","default":"roles","bounds":{"kind":"enum","options":["roles","inherit","selected","none"],"strictOptions":true},"ui":{"id":"s366","status":"editable","control":"select","section":"stages","scope":"project","options":["roles","inherit","selected","none"],"invType":"enum"}}),
  defineSetting({"key":"helper.mcp_servers","room":"native-agent","default":"","bounds":{"kind":"string"},"ui":{"id":"s368","status":"editable","control":"input","section":"stages","scope":"project","invType":"csv"}}),
  defineSetting({"key":"helper.native_plugins","room":"native-agent","default":"","bounds":{"kind":"string"},"ui":{"id":"s370","status":"editable","control":"input","section":"stages","scope":"project","invType":"csv"}}),
  defineSetting({"key":"helper.placement","room":"native-agent","default":"plugin","bounds":{"kind":"enum","options":["plugin","project_tree"],"strictOptions":true},"ui":{"id":"s371","status":"editable","control":"select","section":"stages","scope":"project","options":["plugin","project_tree"],"invType":"enum"}}),
  defineSetting({"key":"helper.skills","room":"native-agent","default":"","bounds":{"kind":"string"},"ui":{"id":"s367","status":"editable","control":"input","section":"stages","scope":"project","invType":"csv"}}),
  defineSetting({"key":"onboarding.agent","room":"native-agent","default":"project-onboarder","bounds":{"kind":"string"},"ui":{"id":"s363","status":"editable","control":"input","section":"onboard","scope":"project","invType":"str"}}),
  defineSetting({"key":"onboarding.depth","room":"native-agent","default":"fast","bounds":{"kind":"enum","options":["fast","deep"],"strictOptions":true},"ui":{"id":"s364","status":"editable","control":"select","section":"onboard","scope":"project","options":["fast","deep"],"invType":"enum"}}),
  defineSetting({"key":"onboarding.model","room":"native-agent","default":"","bounds":{"kind":"string"},"ui":{"id":"s360","status":"editable","control":"input","section":"onboard","scope":"project","invType":"native BB provider selection"}}),
  defineSetting({"key":"onboarding.provider","room":"native-agent","default":"","bounds":{"kind":"string"},"ui":{"id":"s359","status":"editable","control":"input","section":"onboard","scope":"project","invType":"native BB provider selection"}}),
  defineSetting({"key":"onboarding.reasoning_effort","room":"native-agent","default":"","bounds":{"kind":"string"},"ui":{"id":"s361","status":"editable","control":"input","section":"onboard","scope":"project","invType":"native BB provider selection"}}),
  defineSetting({"key":"onboarding.service_tier","room":"native-agent","default":"","bounds":{"kind":"string"},"ui":{"id":"s362","status":"editable","control":"input","section":"onboard","scope":"project","invType":"native BB provider selection"}}),
  defineSetting({"key":"workspace.provider","room":"native-agent","default":"auto","bounds":{"kind":"enum","options":["auto","off"],"strictOptions":true},"ui":{"id":"s419","status":"editable","control":"select","section":"workspace","scope":"project","options":["auto","off"],"invType":"enum"}}),
  defineSetting({"key":"main.agent","room":"native-agent","default":"","defaultValue":"","bounds":{"kind":"string"},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Project PM chat agent profile"}}),
];

export const nativeAgentKeyFamilies: readonly SettingKeyFamily[] = [
  { room: "native-agent", prefix: "helper.access.", pattern: /^helper\.access\.[\w-]+$/, what: "Per-role helper resource access allow/deny policy" },
];
