import {
  DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
  DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
  DEFAULT_PATHS_DEDUPE_THRESHOLD,
  PATHS_BRANCH_DRAFT_REPEATS_KEY,
  PATHS_BRANCH_WINDOW_DAYS_KEY,
  PATHS_DEDUPE_THRESHOLD_KEY,
  defineSetting,
  type SettingDefinition,
} from "@lane-pilot/settings-catalog";

export {
  DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
  DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
  DEFAULT_PATHS_DEDUPE_THRESHOLD,
  PATHS_BRANCH_DRAFT_REPEATS_KEY,
  PATHS_BRANCH_WINDOW_DAYS_KEY,
  PATHS_DEDUPE_THRESHOLD_KEY,
};

const PATHS_DEDUPE_THRESHOLD_MIN = 0.5;
const PATHS_DEDUPE_THRESHOLD_MAX = 1.0;

const PATHS_BRANCH_DRAFT_REPEATS_MIN = 1;
const PATHS_BRANCH_DRAFT_REPEATS_MAX = 20;

const PATHS_BRANCH_WINDOW_DAYS_MIN = 7;
const PATHS_BRANCH_WINDOW_DAYS_MAX = 180;

/**
 * The lead's settings (roadmap §3.3): rows of the global level (project `*`), edited on the Self-improvement screen or with `bb lane-pilot settings`.
 * `enabled` is off until the owner's word; the rest have defaults the owner can live with.
 */
export const LEAD_SETTING_KEYS = ["lead.enabled", "lead.project", "lead.projects", "lead.priority", "lead.budget_daily_usd", "lead.tick_cron", "lead.max_proposals"] as const;
export type LeadSettingKey = (typeof LEAD_SETTING_KEYS)[number];

export type LeadSettings = {
  enabled: boolean;
  /** The project the lead's chat and tick threads live in; empty = the Lane Pilot project of the hub. */
  project: string;
  /** The projects in the lead's zone; empty = every project of the hub. */
  projects: string[];
  /** The owner's order of projects (ids, first = most important); the brief carries each project's rank and unlisted projects follow. The map itself is the hub's data, never prose. */
  priority: string[];
  budgetDailyUsd: number;
  tickCron: string;
  maxProposals: number;
  dedupeThreshold: number;
  branchDraftRepeats: number;
  branchWindowDays: number;
};

export const LEAD_DEFAULTS: LeadSettings = {
  enabled: false,
  project: "",
  projects: [],
  priority: [],
  budgetDailyUsd: 15,
  tickCron: "30 6,10,14,18 * * *",
  maxProposals: 5,
  dedupeThreshold: DEFAULT_PATHS_DEDUPE_THRESHOLD,
  branchDraftRepeats: DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
  branchWindowDays: DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
};

const onOff = (value: unknown, fallback: boolean): boolean => (value === true || value === "on" || value === "true" ? true : value === false || value === "off" || value === "false" ? false : fallback);
const number = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

export function parseLeadSettings(raw: Record<string, unknown>): LeadSettings {
  const ids = (value: unknown): string[] => typeof value === "string" ? value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean) : Array.isArray(value) ? value.map(String) : [];
  return {
    enabled: onOff(raw["lead.enabled"], LEAD_DEFAULTS.enabled),
    project: typeof raw["lead.project"] === "string" ? raw["lead.project"].trim() : "",
    projects: ids(raw["lead.projects"]),
    priority: ids(raw["lead.priority"]),
    budgetDailyUsd: number(raw["lead.budget_daily_usd"], LEAD_DEFAULTS.budgetDailyUsd, 0, 10_000),
    tickCron: typeof raw["lead.tick_cron"] === "string" && raw["lead.tick_cron"].trim() ? raw["lead.tick_cron"].trim() : LEAD_DEFAULTS.tickCron,
    maxProposals: Math.round(number(raw["lead.max_proposals"], LEAD_DEFAULTS.maxProposals, 1, 20)),
    dedupeThreshold: number(raw[PATHS_DEDUPE_THRESHOLD_KEY], LEAD_DEFAULTS.dedupeThreshold, PATHS_DEDUPE_THRESHOLD_MIN, PATHS_DEDUPE_THRESHOLD_MAX),
    branchDraftRepeats: Math.round(number(raw[PATHS_BRANCH_DRAFT_REPEATS_KEY], LEAD_DEFAULTS.branchDraftRepeats, PATHS_BRANCH_DRAFT_REPEATS_MIN, PATHS_BRANCH_DRAFT_REPEATS_MAX)),
    branchWindowDays: Math.round(number(raw[PATHS_BRANCH_WINDOW_DAYS_KEY], LEAD_DEFAULTS.branchWindowDays, PATHS_BRANCH_WINDOW_DAYS_MIN, PATHS_BRANCH_WINDOW_DAYS_MAX)),
  };
}

/** Why a value is refused (the settings page, the CLI); null when fine or empty. */
export function leadSettingProblem(key: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  switch (key) {
    case "lead.enabled": return typeof value === "boolean" || ["on", "off", "true", "false"].includes(String(value)) ? null : "on, off";
    case "lead.budget_daily_usd": { const n = typeof value === "string" ? Number(value) : value; return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 10_000 ? null : "0-10000"; }
    case "lead.max_proposals": { const n = typeof value === "string" ? Number(value) : value; return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 20 ? null : "integer 1-20"; }
    case "lead.tick_cron": return typeof value === "string" && value.trim().split(/\s+/).length === 5 ? null : "five cron fields (30 6,10,14,18 * * *)";
    case "lead.project": return typeof value === "string" && value.length <= 80 ? null : "a project id";
    case "lead.projects": return typeof value === "string" && value.length <= 2000 ? null : "project ids separated by commas";
    case "lead.priority": return typeof value === "string" && value.length <= 2000 ? null : "project ids in your order, separated by commas";
    case PATHS_DEDUPE_THRESHOLD_KEY: {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      return typeof n === "number" && Number.isFinite(n) && n >= PATHS_DEDUPE_THRESHOLD_MIN && n <= PATHS_DEDUPE_THRESHOLD_MAX ? null : "0.5-1";
    }
    case PATHS_BRANCH_DRAFT_REPEATS_KEY: {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      return typeof n === "number" && Number.isInteger(n) && n >= PATHS_BRANCH_DRAFT_REPEATS_MIN && n <= PATHS_BRANCH_DRAFT_REPEATS_MAX ? null : `${PATHS_BRANCH_DRAFT_REPEATS_MIN}-${PATHS_BRANCH_DRAFT_REPEATS_MAX}`;
    }
    case PATHS_BRANCH_WINDOW_DAYS_KEY: {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      return typeof n === "number" && Number.isInteger(n) && n >= PATHS_BRANCH_WINDOW_DAYS_MIN && n <= PATHS_BRANCH_WINDOW_DAYS_MAX ? null : `${PATHS_BRANCH_WINDOW_DAYS_MIN}-${PATHS_BRANCH_WINDOW_DAYS_MAX}`;
    }
    default: return null;
  }
}

export const leadSettings: readonly SettingDefinition[] = [
  defineSetting({"key":"lead.budget_daily_usd","room":"lead","default":15,"bounds":{"kind":"lead","min":0,"max":10000},"ui":{"id":"s605","status":"editable","control":"number","section":"improvement","scope":"global","min":0,"max":10000,"invType":"int"}}),
  defineSetting({"key":"lead.enabled","room":"lead","default":"off","bounds":{"kind":"lead"},"ui":{"id":"s602","status":"editable","control":"select","section":"improvement","scope":"global","options":["on","off"],"invType":"enum"}}),
  defineSetting({"key":"lead.max_proposals","room":"lead","default":5,"bounds":{"kind":"lead","min":1,"max":20},"ui":{"id":"s607","status":"editable","control":"number","section":"improvement","scope":"global","min":1,"max":20,"invType":"int"}}),
  defineSetting({"key":"lead.priority","room":"lead","default":"","bounds":{"kind":"lead"},"ui":{"id":"s608","status":"editable","control":"input","section":"improvement","scope":"global","invType":"text"}}),
  defineSetting({"key":"lead.project","room":"lead","default":"","bounds":{"kind":"lead"},"ui":{"id":"s603","status":"editable","control":"input","section":"improvement","scope":"global","invType":"text"}}),
  defineSetting({"key":"lead.projects","room":"lead","default":"","bounds":{"kind":"lead"},"ui":{"id":"s604","status":"editable","control":"input","section":"improvement","scope":"global","invType":"text"}}),
  defineSetting({"key":"lead.tick_cron","room":"lead","default":"30 6,10,14,18 * * *","bounds":{"kind":"cron"},"ui":{"id":"s606","status":"editable","control":"input","section":"improvement","scope":"global","invType":"text"}}),
  defineSetting({
    key: PATHS_DEDUPE_THRESHOLD_KEY,
    room: "lead",
    default: DEFAULT_PATHS_DEDUPE_THRESHOLD,
    bounds: { kind: "number", min: PATHS_DEDUPE_THRESHOLD_MIN, max: PATHS_DEDUPE_THRESHOLD_MAX },
    ui: {
      status: "hidden",
      control: "number",
      section: "improvement",
      scope: "global",
      min: PATHS_DEDUPE_THRESHOLD_MIN,
      max: PATHS_DEDUPE_THRESHOLD_MAX,
      invType: "float",
      reason: "Structural dedup similarity threshold (0.5-1.0) before creating a workflow draft",
    },
  }),
  defineSetting({
    key: PATHS_BRANCH_DRAFT_REPEATS_KEY,
    room: "lead",
    default: DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
    bounds: { kind: "int", min: PATHS_BRANCH_DRAFT_REPEATS_MIN, max: PATHS_BRANCH_DRAFT_REPEATS_MAX },
    ui: {
      status: "hidden",
      control: "number",
      section: "improvement",
      scope: "global",
      min: PATHS_BRANCH_DRAFT_REPEATS_MIN,
      max: PATHS_BRANCH_DRAFT_REPEATS_MAX,
      invType: "int",
      reason: "Minimum repeated trajectory deltas before proposing a branch draft (1-20)",
    },
  }),
  defineSetting({
    key: PATHS_BRANCH_WINDOW_DAYS_KEY,
    room: "lead",
    default: DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
    bounds: { kind: "int", min: PATHS_BRANCH_WINDOW_DAYS_MIN, max: PATHS_BRANCH_WINDOW_DAYS_MAX },
    ui: {
      status: "hidden",
      control: "number",
      section: "improvement",
      scope: "global",
      min: PATHS_BRANCH_WINDOW_DAYS_MIN,
      max: PATHS_BRANCH_WINDOW_DAYS_MAX,
      invType: "int",
      reason: "Rolling discovery window in days for free-work and branch candidates (7-180)",
    },
  }),
];
