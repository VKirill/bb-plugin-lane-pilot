import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const runsSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"ops.pool_size","room":"runs","default":5,"bounds":{"kind":"int","min":1,"max":10},"ui":{"id":"s318","status":"editable","control":"input","section":"ops","scope":"lane/run","options":["1-10"],"min":1,"max":10,"invType":"bounded int","legacyName":"--pool-size"}}),
  defineSetting({"key":"ops.verify_pool_size","room":"runs","default":2,"bounds":{"kind":"int","min":1,"max":10},"ui":{"id":"s323","status":"editable","control":"input","section":"ops","scope":"lane/run","options":["1-10"],"min":1,"max":10,"invType":"bounded int","legacyName":"--verify-pool-size / --pool-size"}}),
  defineSetting({"key":"run.gate","room":"runs","default":"none","bounds":{"kind":"enum","options":["none","pre-merge"],"strictOptions":true},"ui":{"id":"s333","status":"editable","control":"select","section":"ops","scope":"run","options":["none","pre-merge"],"invType":"enum","legacyName":"gate"}}),
  defineSetting({"key":"run.max_attempts","room":"runs","default":null,"bounds":{"kind":"int","min":1},"ui":{"id":"s386","status":"editable","control":"number","section":"limits","scope":"project","min":1,"invType":"int"}}),
  defineSetting({"key":"run.max_children","room":"runs","default":null,"bounds":{"kind":"int","min":1},"ui":{"id":"s389","status":"editable","control":"number","section":"limits","scope":"project","min":1,"invType":"int"}}),
  defineSetting({"key":"run.max_tokens","room":"runs","default":null,"bounds":{"kind":"int","min":1},"ui":{"id":"s388","status":"editable","control":"number","section":"limits","scope":"project","min":1,"invType":"int"}}),
  defineSetting({"key":"run.max_wall_minutes","room":"runs","default":null,"bounds":{"kind":"int","min":1},"ui":{"id":"s387","status":"editable","control":"number","section":"limits","scope":"project","min":1,"invType":"int"}}),
  defineSetting({"key":"task.outcome_file","room":"runs","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"a finished task leaves OUTCOME.md beside its PLAN.md where the task folder still exists"}}),
];
