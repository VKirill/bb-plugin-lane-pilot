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
};

export const LEAD_DEFAULTS: LeadSettings = { enabled: false, project: "", projects: [], priority: [], budgetDailyUsd: 15, tickCron: "30 6,10,14,18 * * *", maxProposals: 5 };

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
    default: return null;
  }
}
