import { defineSetting, UNAPPLIED_REASON, type SettingDefinition, type SettingKeyFamily } from "@lane-pilot/settings-catalog";

export const WRITER_PROVIDER_KEY = "writer.provider";
export const WRITER_MODEL_KEY = "writer.model";
export const WRITER_MAX_CONCURRENT_KEY = "writer.max_concurrent";
export const WRITER_SILENCE_NUDGE_MIN_KEY = "writer.silence_nudge_min";
export const WRITER_QUESTION_WAIT_MIN_KEY = "writer.question_wait_min";
export const WRITER_AUTO_RETURN_KEY = "writer.auto_return";
export const WRITER_MAX_TURNS_KEY = "writer.max_turns";
export const WRITER_REASONING_EFFORT_KEY = "writer.reasoning_effort";
export const WRITER_FALLBACK_ON_PROVIDER_FAILURE_KEY = "writer.fallback_on_provider_failure";
export const WRITER_AGENT_KEY = "writer.agent";
export const WRITER_CAPACITY_WAIT_KEY = "writer.capacity_wait";
export const WRITER_ENFORCE_APPETITE_MINUTES_KEY = "writer.enforce_appetite_minutes";
export const WRITER_FAST_MODE_KEY = "writer.fast_mode";
export const WRITER_LAUNCH_PARITY_KEY = "writer.launch_parity";
export const WRITER_OWNS_BARRIER_KEY = "writer.owns_barrier";
export const WRITER_PAIR_PIN_KEY = "writer.pair_pin";
export const WRITER_QA_STOP_AFTER_KEY = "writer.qa_stop_after";
export const WRITER_RETRY_ESCALATE_KEY = "writer.retry_escalate";
export const WRITER_RETRY_SAFETY_KEY = "writer.retry_safety";
export const WRITER_SERVICE_TIER_KEY = "writer.service_tier";
export const WRITER_SESSION_MAX_TURNS_KEY = "writer.session_max_turns";
export const FAILURE_INTERVENTIONS_KEY = "failure.interventions";
export const QUEUE_LANE_CAPS_KEY = "queue.lane_caps";
export const DEFAULT_WRITER_MAX_CONCURRENT = 3;

export const writerSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"failure.interventions","room":"writer","default":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"id":"s513","status":"editable","control":"select","section":"writer","scope":"project","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":"ops.provider_pool","room":"writer","default":"","bounds":{"kind":"provider_pool"},"ui":{"id":"s430","status":"editable","control":"input","section":"ops","scope":"project","invType":"string"}}),
  defineSetting({"key":"writer.agent","room":"writer","default":"lane-writer","bounds":{"kind":"string"},"ui":{"id":"s021","status":"editable","control":"input","section":"writer","scope":"project","invType":"str","legacyName":"--writer-agent"}}),
  defineSetting({"key":"writer.auto_return","room":"writer","default":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"id":"s585","status":"editable","control":"select","section":"writer","scope":"project","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":WRITER_MAX_CONCURRENT_KEY,"room":"writer","default":DEFAULT_WRITER_MAX_CONCURRENT,"bounds":{"kind":"int","min":1,"max":20},"ui":{"status":"hidden","control":"number","section":"writer","scope":"project","min":1,"max":20,"reason":"Maximum concurrent writers admitted at once"}}),
  defineSetting({"key":"writer.capacity_wait","room":"writer","default":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"id":"s533","status":"editable","control":"select","section":"stages","scope":"project","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":"writer.capacity_wait_max_min","room":"writer","default":360,"bounds":{"kind":"int","min":1},"ui":{"id":"s539","status":"editable","control":"number","section":"stages","scope":"project","min":1,"invType":"int"}}),
  defineSetting({"key":"writer.class_cooldowns","room":"writer","default":"{\"merge\":30,\"infra\":60,\"dirty_base\":60}","bounds":{"kind":"json"},"ui":{"id":"s534","status":"editable","control":"input","section":"stages","scope":"project","invType":"text"}}),
  defineSetting({"key":"writer.cooldown_max_ms","room":"writer","default":0,"bounds":{"kind":"int","min":0},"ui":{"id":"s535","status":"editable","control":"number","section":"stages","scope":"project","min":0,"invType":"int"}}),
  defineSetting({"key":WRITER_FALLBACK_ON_PROVIDER_FAILURE_KEY,"room":"writer","default":"immediate","bounds":{"kind":"enum","options":["immediate","after_retry"],"strictOptions":true},"ui":{"id":"s511","status":"editable","control":"select","section":"stages","scope":"project","options":["immediate","after_retry"],"invType":"enum"}}),
  defineSetting({"key":"writer.fast_mode","room":"writer","default":false,"bounds":{"kind":"boolean","options":["true","false"]},"ui":{"id":"s024","status":"readonly","control":"switch","section":"writer","scope":"project","options":["true","false"],"invType":"bool","channel":"NONE","legacyName":"--fast-mode/--no-fast-mode","reason":UNAPPLIED_REASON.legacyFastModeMigrated}}),
  defineSetting({"key":"writer.model","room":"writer","default":"gpt-6-luna","bounds":{"kind":"string"},"ui":{"id":"s020","status":"editable","control":"input","section":"writer","scope":"project","options":["any model id"],"invType":"str","legacyName":"--writer-model"}}),
  defineSetting({"key":"writer.owns_barrier","room":"writer","default":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"id":"s540","status":"editable","control":"select","section":"writer","scope":"project","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":"writer.pair_pin","room":"writer","default":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"id":"s531","status":"editable","control":"select","section":"stages","scope":"project","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":"writer.provider","room":"writer","default":"codex","bounds":{"kind":"enum","options":["agy","grok","qwen","kimi","codex","cursor","opencode"],"strictOptions":true},"ui":{"id":"s004","status":"editable","control":"select","section":"writer","scope":"project","options":["agy","grok","qwen","kimi","codex","cursor","opencode"],"invType":"enum","legacyName":"--writer-provider"}}),
  defineSetting({"key":"writer.question_wait_min","room":"writer","default":120,"bounds":{"kind":"int","min":1},"ui":{"id":"s586","status":"editable","control":"number","section":"writer","scope":"project","min":1,"invType":"int"}}),
  defineSetting({"key":WRITER_REASONING_EFFORT_KEY,"room":"writer","default":"high","bounds":{"kind":"enum","options":["low","medium","high","xhigh","max"],"strictOptions":true},"ui":{"id":"s022","status":"editable","control":"select","section":"writer","scope":"project","options":["low","medium","high","xhigh","max"],"invType":"str","legacyName":"--writer-effort / --reasoning-effort"}}),
  defineSetting({"key":"writer.retry_escalate","room":"writer","default":false,"bounds":{"kind":"boolean","options":["true","false"]},"ui":{"id":"s514","status":"editable","control":"switch","section":"writer","scope":"project","options":["true","false"],"invType":"bool"}}),
  defineSetting({"key":"writer.retry_safety","room":"writer","default":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"id":"s538","status":"editable","control":"select","section":"writer","scope":"project","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":"writer.service_tier","room":"writer","default":"fast","bounds":{"kind":"enum","options":["standard","fast"],"strictOptions":true},"ui":{"id":"s023","status":"editable","control":"select","section":"writer","scope":"project","options":["standard","fast"],"invType":"enum","legacyName":"--service-tier"}}),
  defineSetting({"key":"writer.session_max_turns","room":"writer","default":5,"bounds":{"kind":"int","min":1,"max":10},"ui":{"id":"s616","status":"editable","control":"number","section":"writer","scope":"project","min":1,"max":10,"invType":"int"}}),
  defineSetting({"key":"writer.silence_nudge_min","room":"writer","default":20,"bounds":{"kind":"int","min":1},"ui":{"id":"s413","status":"editable","control":"number","section":"writer","scope":"project","min":1,"invType":"int"}}),
  defineSetting({"key":"writer.task_wall_clock_min","room":"writer","default":720,"bounds":{"kind":"int","min":30,"max":10080},"ui":{"id":"s536","status":"editable","control":"number","section":"writer","scope":"project","min":30,"max":10080,"invType":"int"}}),
  defineSetting({"key":"writer.verify_max_passes","room":"writer","default":10,"bounds":{"kind":"int","min":1,"max":60},"ui":{"id":"s537","status":"editable","control":"number","section":"writer","scope":"project","min":1,"max":60,"invType":"int"}}),
  defineSetting({"key":"writer.enforce_appetite_minutes","room":"writer","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"off: contract appetite.minutes is advisory forecast only (unset or on: ask at 80% and stop at 100%)"}}),
  defineSetting({"key":"writer.launch_parity","room":"writer","default":"refuse","defaultValue":"refuse","bounds":{"kind":"enum","options":["refuse","warn"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"refuse: a writer that started on another provider than asked is stopped and the pair held for 30 minutes (unset: refuse; warn: log only)"}}),
  defineSetting({"key":"writer.lesson_from_accepted","room":"writer","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"LESSON: lines of an accepted attempt are filed as lesson proposals"}}),
  defineSetting({"key":"writer.max_turns","room":"writer","default":0,"defaultValue":"0","bounds":{"kind":"number","min":0},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"a writer attempt is stopped at this many tool calls, its worktree kept (unset or 0: no ceiling; 1-10000: explicit cap)"}}),
  defineSetting({"key":"writer.models_off","room":"writer","default":[],"defaultValue":"[]","bounds":{"kind":"json"},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"a list of writer profile keys, provider/model ids or bare model ids no writer is given (the pick and the fallback chain skip them; all off: the task waits, the owner is told)"}}),
  defineSetting({"key":"writer.qa_stop_after","room":"writer","default":2,"defaultValue":"2","bounds":{"kind":"number","min":0},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"after this many failed QA receipts of a task family the advice is to stop, not to follow up (unset: 2; 0 or off: always a follow-up, as before)"}}),
  defineSetting({"key":"writer.respect_owner_presence","room":"writer","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"on: hold writer spawns for 10 min on a subscription provider while the owner sends chat turns on it (unset or off: writers run concurrently in isolated worktrees)"}}),
  defineSetting({"key":"queue.lane_caps","room":"writer","default":null,"defaultValue":"","bounds":{"kind":"json"},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Queue per-lane concurrency caps"}}),
  defineSetting({"key":"route.max_risk","room":"writer","default":"","defaultValue":"","bounds":{"kind":"enum","options":["low","medium","high","critical"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Max task risk for auto routing"}}),
  defineSetting({"key":"writer.brief_mode","room":"writer","default":"","defaultValue":"","bounds":{"kind":"string"},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Writer brief rendering mode"}}),
  defineSetting({"key":"writer.rotation_share","room":"writer","default":null,"defaultValue":"","bounds":{"kind":"number","min":0,"max":1},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Writer exploration rotation share"}}),
  defineSetting({"key":"zcode.window","room":"writer","default":"promo","defaultValue":"promo","bounds":{"kind":"zcode_window","options":["promo","always"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"When ZCode free model may run (promo 15:00-01:00 UTC or always)"}}),
  defineSetting({"key":"zcode.background","room":"writer","default":false,"defaultValue":"false","bounds":{"kind":"boolean"},"ui":{"status":"hidden","control":"input","section":"other","scope":"global","reason":"Try ZCode first for background roles during promo hours"}}),
];

export const writerKeyFamilies: readonly SettingKeyFamily[] = [
  { room: "writer", prefix: "writer.fallback", pattern: /^writer\.fallback[123]\.(?:provider|model|reasoning_effort)$/, what: "Writer fallback chain slots 1-3" },
];
