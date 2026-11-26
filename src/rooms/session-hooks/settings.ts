import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const sessionHooksSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"hook.prompt_recall","room":"session-hooks","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"a session's prompt of 3 words or more is answered with pointers to the project's confirmed notes that match its words (word index only, no model call; ON when unset: off silences it)"}}),
  defineSetting({"key":"hook.subagent_pack","room":"session-hooks","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"a Task call's subagent is born with the project's accepted rules and confirmed memory lessons in its context pack (unset: the pack holds the repo and the window's claimed files only)"}}),
  defineSetting({"key":"rules.gates","room":"session-hooks","default":[],"defaultValue":"[]","bounds":{"kind":"json"},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Project convention gates"}}),
];
