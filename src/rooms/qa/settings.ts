import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const QA_APPROVE_KEY = "browser_qa.approve";
export const QA_BACKEND_KEY = "browser_qa.backend";
export const QA_ENABLED_KEY = "browser_qa.enabled";
export const QA_MODEL_KEY = "browser_qa.model";
export const QA_PROVIDER_KEY = "browser_qa.provider";
export const QA_REASONING_EFFORT_KEY = "browser_qa.reasoning_effort";
export const QA_TIMEOUT_SEC_KEY = "browser_qa.timeout_sec";

export const qaSettings: readonly SettingDefinition[] = [
  defineSetting({"key":QA_APPROVE_KEY,"room":"qa","default":"auto","bounds":{"kind":"enum","options":["auto","never"],"strictOptions":true},"ui":{"id":"s128","status":"editable","control":"select","section":"browser-qa","scope":"project","options":["auto","never"],"invType":"enum"}}),
  defineSetting({"key":QA_BACKEND_KEY,"room":"qa","default":"bb-browser","bounds":{"kind":"enum","options":["bb-browser","chrome-qa","headless","live-chrome"],"strictOptions":true},"ui":{"id":"s019","status":"editable","control":"select","section":"browser-qa","scope":"project","options":["bb-browser","chrome-qa","headless","live-chrome"],"invType":"enum","legacyName":"--browser-qa-backend"}}),
  defineSetting({"key":QA_ENABLED_KEY,"room":"qa","default":false,"bounds":{"kind":"boolean","options":["true","false"]},"ui":{"id":"s015","status":"editable","control":"switch","section":"browser-qa","scope":"project","options":["true","false"],"invType":"enum","legacyName":"--browser-qa"}}),
  defineSetting({"key":QA_MODEL_KEY,"room":"qa","default":"","bounds":{"kind":"string"},"ui":{"id":"s017","status":"editable","control":"input","section":"browser-qa","scope":"project","invType":"str","legacyName":"--browser-qa-model"}}),
  defineSetting({"key":QA_PROVIDER_KEY,"room":"qa","default":"codex","bounds":{"kind":"enum","options":["codex"],"strictOptions":true},"ui":{"id":"s016","status":"editable","control":"select","section":"browser-qa","scope":"project","options":["codex"],"invType":"enum","legacyName":"--browser-qa-provider"}}),
  defineSetting({"key":QA_REASONING_EFFORT_KEY,"room":"qa","default":"medium","bounds":{"kind":"string"},"ui":{"id":"s125","status":"editable","control":"input","section":"browser-qa","scope":"project","invType":"str"}}),
  defineSetting({"key":"browser_qa.host_id","room":"qa","default":"","defaultValue":"","bounds":{"kind":"string"},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"Pinned browser QA host id"}}),
  defineSetting({"key":"browser_qa.workspace","room":"qa","default":"","defaultValue":"","bounds":{"kind":"string"},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Pinned browser QA workspace"}}),
  defineSetting({"key":QA_TIMEOUT_SEC_KEY,"room":"qa","default":300,"defaultValue":"300","bounds":{"kind":"int","min":1},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Browser QA timeout in seconds"}}),
];
