import {
  DEFAULT_NODE_BUDGET_TOKENS,
  DEFAULT_NODE_BUDGET_USD,
  DEFAULT_NODE_BUDGET_WALL_SECONDS,
  DEFAULT_RUN_BUDGET_TOKENS,
  DEFAULT_RUN_BUDGET_USD,
  DEFAULT_RUN_BUDGET_WALL_SECONDS,
  DEFAULT_STUCK_REPEAT_LIMIT,
  SETTING_WORKFLOW_DISABLED,
  WORKFLOW_NODE_BUDGET_TOKENS_KEY,
  WORKFLOW_NODE_BUDGET_USD_KEY,
  WORKFLOW_NODE_BUDGET_WALL_SECONDS_KEY,
  WORKFLOW_RUN_BUDGET_TOKENS_KEY,
  WORKFLOW_RUN_BUDGET_USD_KEY,
  WORKFLOW_RUN_BUDGET_WALL_SECONDS_KEY,
  WORKFLOW_STUCK_REPEAT_LIMIT_KEY,
  defineSetting,
  type SettingDefinition,
  type SettingKeyFamily,
} from "@lane-pilot/settings-catalog";

export const PHASE_RAILS_KEY = "phase.rails";
export const PHASE_TRAIN_KEY = "phase.train";
export const MILESTONE_ARCHIVE_KEY = "milestone.archive";
export const MILESTONE_SUMMARY_KEY = "milestone.summary";
export const PROJECT_PLANNING_HOME_KEY = "project.planning_home";
export const PROJECT_START_RESEARCH_KEY = "project.start_research";
export const RETRO_LIVING_KEY = "retro.living";
export const WORKFLOW_DISABLED_KEY = SETTING_WORKFLOW_DISABLED;

/** Parses `workflow.disabled` (string array or JSON string array) into a set of disabled workflow ids. */
export function parseWorkflowDisabled(raw: unknown): Set<string> {
  let list: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return new Set();
    if (trimmed.startsWith("[")) {
      try { list = JSON.parse(trimmed); } catch { return new Set(); }
    } else {
      return new Set(trimmed.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean));
    }
  }
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean));
}

/** Validates `workflow.disabled` setting values (array of workflow id strings or JSON string array). */
export function workflowDisabledProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let list: unknown = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { return "JSON array of workflow id strings"; }
  }
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item.trim().length > 0)) {
    return "array of non-empty workflow id strings";
  }
  return null;
}

export const workflowSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"workflow.debugger.model","room":"workflow","default":"","bounds":{"kind":"string"},"ui":{"id":"s454","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.debugger.provider","room":"workflow","default":"","bounds":{"kind":"string"},"ui":{"id":"s453","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.debugger.reasoning_effort","room":"workflow","default":"","bounds":{"kind":"enum","options":["low","medium","high","xhigh","max"],"strictOptions":true},"ui":{"id":"s455","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.cheap-fast.model","room":"workflow","default":"claude-haiku-5-5","bounds":{"kind":"string"},"ui":{"id":"s457","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.cheap-fast.provider","room":"workflow","default":"claude-code","bounds":{"kind":"string"},"ui":{"id":"s456","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.cheap-fast.reasoning_effort","room":"workflow","default":"low","bounds":{"kind":"enum","options":["low","medium","high","xhigh","max"],"strictOptions":true},"ui":{"id":"s458","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-analysis.model","room":"workflow","default":"claude-opus-5","bounds":{"kind":"string"},"ui":{"id":"s463","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-analysis.provider","room":"workflow","default":"claude-code","bounds":{"kind":"string"},"ui":{"id":"s462","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-analysis.reasoning_effort","room":"workflow","default":"high","bounds":{"kind":"enum","options":["low","medium","high","xhigh","max"],"strictOptions":true},"ui":{"id":"s464","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-check.model","room":"workflow","default":"gpt-6.1-sol","bounds":{"kind":"string"},"ui":{"id":"s469","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-check.provider","room":"workflow","default":"codex","bounds":{"kind":"string"},"ui":{"id":"s468","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-check.reasoning_effort","room":"workflow","default":"medium","bounds":{"kind":"enum","options":["low","medium","high","xhigh","max"],"strictOptions":true},"ui":{"id":"s470","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-digest.model","room":"workflow","default":"claude-sonnet-5","bounds":{"kind":"string"},"ui":{"id":"s472","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-digest.provider","room":"workflow","default":"claude-code","bounds":{"kind":"string"},"ui":{"id":"s471","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-digest.reasoning_effort","room":"workflow","default":"medium","bounds":{"kind":"enum","options":["low","medium","high","xhigh","max"],"strictOptions":true},"ui":{"id":"s473","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-psychology.model","room":"workflow","default":"gpt-5.6-luna","bounds":{"kind":"string"},"ui":{"id":"s466","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-psychology.provider","room":"workflow","default":"codex","bounds":{"kind":"string"},"ui":{"id":"s465","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.ins-psychology.reasoning_effort","room":"workflow","default":"max","bounds":{"kind":"enum","options":["low","medium","high","xhigh","max"],"strictOptions":true},"ui":{"id":"s467","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.strong.model","room":"workflow","default":"claude-opus-5-5","bounds":{"kind":"string"},"ui":{"id":"s460","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.strong.provider","room":"workflow","default":"claude-code","bounds":{"kind":"string"},"ui":{"id":"s459","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({"key":"workflow.preset.strong.reasoning_effort","room":"workflow","default":"high","bounds":{"kind":"enum","options":["low","medium","high","xhigh","max"],"strictOptions":true},"ui":{"id":"s461","status":"editable","control":"input","section":"stages","scope":"project","invType":"string"}}),
  defineSetting({ key: WORKFLOW_NODE_BUDGET_TOKENS_KEY, room: "workflow", default: DEFAULT_NODE_BUDGET_TOKENS, bounds: { kind: "int", min: 1 }, ui: { status: "editable", control: "number", section: "limits", scope: "project", min: 1, invType: "int" } }),
  defineSetting({ key: WORKFLOW_NODE_BUDGET_USD_KEY, room: "workflow", default: DEFAULT_NODE_BUDGET_USD, bounds: { kind: "number", min: 0.01 }, ui: { status: "editable", control: "number", section: "limits", scope: "project", min: 0.01, invType: "float" } }),
  defineSetting({ key: WORKFLOW_NODE_BUDGET_WALL_SECONDS_KEY, room: "workflow", default: DEFAULT_NODE_BUDGET_WALL_SECONDS, bounds: { kind: "int", min: 1 }, ui: { status: "editable", control: "number", section: "limits", scope: "project", min: 1, invType: "int" } }),
  defineSetting({ key: WORKFLOW_RUN_BUDGET_TOKENS_KEY, room: "workflow", default: DEFAULT_RUN_BUDGET_TOKENS, bounds: { kind: "int", min: 1 }, ui: { status: "editable", control: "number", section: "limits", scope: "project", min: 1, invType: "int" } }),
  defineSetting({ key: WORKFLOW_RUN_BUDGET_USD_KEY, room: "workflow", default: DEFAULT_RUN_BUDGET_USD, bounds: { kind: "number", min: 0.01 }, ui: { status: "editable", control: "number", section: "limits", scope: "project", min: 0.01, invType: "float" } }),
  defineSetting({ key: WORKFLOW_RUN_BUDGET_WALL_SECONDS_KEY, room: "workflow", default: DEFAULT_RUN_BUDGET_WALL_SECONDS, bounds: { kind: "int", min: 1 }, ui: { status: "editable", control: "number", section: "limits", scope: "project", min: 1, invType: "int" } }),
  defineSetting({ key: WORKFLOW_STUCK_REPEAT_LIMIT_KEY, room: "workflow", default: DEFAULT_STUCK_REPEAT_LIMIT, bounds: { kind: "int", min: 2, max: 100 }, ui: { status: "editable", control: "number", section: "limits", scope: "project", min: 2, max: 100, invType: "int" } }),
  defineSetting({"key":PHASE_RAILS_KEY,"room":"workflow","default":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"id":"s610","status":"editable","control":"select","section":"improvement","scope":"project","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":PHASE_TRAIN_KEY,"room":"workflow","default":"on","defaultValue":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"Phase train auto-progression"}}),
  defineSetting({"key":MILESTONE_ARCHIVE_KEY,"room":"workflow","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"closing a milestone archives its phase folders"}}),
  defineSetting({"key":MILESTONE_SUMMARY_KEY,"room":"workflow","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"closing a milestone writes MILESTONE-SUMMARY.md (one model session)"}}),
  defineSetting({"key":PROJECT_PLANNING_HOME_KEY,"room":"workflow","default":"","defaultValue":"","bounds":{"kind":"planning_home","absolutePath":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"the planning home: .agents/phases, .agents/planning and .agents/todos are read and written under this folder on the project's host instead of the checkout's (unset: the checkout)"}}),
  defineSetting({"key":PROJECT_START_RESEARCH_KEY,"room":"workflow","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"project start asks about the project, researches the stack and writes requirements (a question to the owner, two model sessions)"}}),
  defineSetting({"key":RETRO_LIVING_KEY,"room":"workflow","default":"off","defaultValue":"off","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"a retro updates the living retrospective file"}}),
  defineSetting({
    key: WORKFLOW_DISABLED_KEY,
    room: "workflow",
    default: [],
    defaultValue: "[]",
    bounds: { kind: "json" },
    ui: { status: "hidden", control: "input", section: "other", scope: "project", reason: "Workflow ids disabled by the per-graph kill switch" },
  }),
];

export const workflowKeyFamilies: readonly SettingKeyFamily[] = [
  { room: "workflow", prefix: "role_model.", pattern: /^role_model\.[\w-]+$/, what: "Per-role model and pool selection" },
  { room: "workflow", prefix: "service_model.", pattern: /^service_model\.[\w-]+$/, what: "Service job model rollback pin" },
];
