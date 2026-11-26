import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const CLEANUP_WORKTREE_GRACE_HOURS_KEY = "cleanup.worktree_grace_hours";
export const CLEANUP_WORKTREE_MAX_AGE_DAYS_KEY = "cleanup.worktree_max_age_days";
export const CLEANUP_WORKTREES_KEY = "cleanup.worktrees";
export const PM_TURN_LIMIT_MIN_KEY = "pm.turn_limit_min";
export const PM_MAX_TURNS_KEY = "pm.max_turns";

export const stabilitySettings: readonly SettingDefinition[] = [
  defineSetting({"key":CLEANUP_WORKTREE_GRACE_HOURS_KEY,"room":"stability","default":2,"bounds":{"kind":"int","min":0,"max":168},"ui":{"id":"s601","status":"editable","control":"number","section":"improvement","scope":"global","min":0,"max":168,"invType":"int"}}),
  defineSetting({"key":CLEANUP_WORKTREE_MAX_AGE_DAYS_KEY,"room":"stability","default":7,"bounds":{"kind":"int","min":1,"max":365},"ui":{"id":"s624","status":"editable","control":"number","section":"improvement","scope":"global","min":1,"max":365,"invType":"int"}}),
  defineSetting({"key":CLEANUP_WORKTREES_KEY,"room":"stability","default":"on","bounds":{"kind":"enum","options":["on","off"],"strictOptions":true},"ui":{"id":"s600","status":"editable","control":"select","section":"improvement","scope":"global","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":PM_TURN_LIMIT_MIN_KEY,"room":"stability","default":null,"defaultValue":"","bounds":{"kind":"int","min":1},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"PM turn limit warning window in minutes"}}),
  defineSetting({"key":PM_MAX_TURNS_KEY,"room":"stability","default":null,"defaultValue":"","bounds":{"kind":"int","min":1},"ui":{"status":"hidden","control":"input","section":"other","scope":"project","reason":"PM turn ceiling"}}),
];
