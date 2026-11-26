import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const OWNER_WORDS_KEY = "owner.words";

export const tasksSettings: readonly SettingDefinition[] = [
  defineSetting({"key":OWNER_WORDS_KEY,"room":"tasks","default":"sensitive","bounds":{"kind":"enum","options":["on","risky","sensitive","off"],"strictOptions":true},"ui":{"id":"s609","status":"editable","control":"select","section":"improvement","scope":"project","options":["on","risky","sensitive","off"],"invType":"enum"}}),
  defineSetting({"key":"profile.deploy","room":"tasks","default":"","defaultValue":"","bounds":{"kind":"string","maxLength":1000},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"infra profile: how it deploys"}}),
  defineSetting({"key":"profile.hosts","room":"tasks","default":"","defaultValue":"","bounds":{"kind":"string","maxLength":1000},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"infra profile: the machines the project lives on"}}),
  defineSetting({"key":"profile.logs","room":"tasks","default":"","defaultValue":"","bounds":{"kind":"string","maxLength":1000},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"infra profile: where the logs are"}}),
  defineSetting({"key":"profile.release","room":"tasks","default":"","defaultValue":"","bounds":{"kind":"string","maxLength":1000},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"infra profile: how a release ships"}}),
  defineSetting({"key":"profile.stack","room":"tasks","default":"","defaultValue":"","bounds":{"kind":"string","maxLength":1000},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"infra profile: languages and frameworks"}}),
  defineSetting({"key":"profile.start","room":"tasks","default":"","defaultValue":"","bounds":{"kind":"string","maxLength":1000},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"infra profile: how the project starts locally"}}),
  defineSetting({"key":"profile.style","room":"tasks","default":"","defaultValue":"","bounds":{"kind":"string","maxLength":1000},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"infra profile: the owner's working style"}}),
  defineSetting({"key":"profile.test_command","room":"tasks","default":"","defaultValue":"","bounds":{"kind":"string","maxLength":1000},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"infra profile: how the project's checks run"}}),
];
