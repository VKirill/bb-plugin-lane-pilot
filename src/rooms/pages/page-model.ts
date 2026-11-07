import { VISIBLE_CATALOG, type CatalogRow } from "@lane-pilot/settings-catalog";
import type { I18nKey } from "@lane-pilot/i18n";
import { HUB_KEYS, PROJECT_DEFAULT_KEYS } from "@lane-pilot/settings-catalog";
import { COUNCIL_KEYS, PAIR_ROLE_SPECS, roleSpecKey } from "@lane-pilot/models";
import { JEV_KEYS, isCompatibilityAlias, uniqueByStorage } from "../ui-shell/ui";

const key = (id: string, suffix: "provider" | "model" | "reasoning_effort" | "service_tier") => roleSpecKey(id, suffix);

export const WRITER_PROVIDER = key("writer", "provider");

export const WRITER_MODEL = key("writer", "model");

export const WRITER_EFFORT = key("writer", "reasoning_effort");

export const WRITER_SERVICE_TIER = key("writer", "service_tier");

export const MEMORY_PROVIDER = key("memory", "provider");

export const MEMORY_MODEL = key("memory", "model");

export const MEMORY_EFFORT = key("memory", "reasoning_effort");

export const MEMORY_SERVICE_TIER = key("memory", "service_tier");

export const NIGHT_PROVIDER = key("night_review", "provider");

export const NIGHT_MODEL = key("night_review", "model");

export const NIGHT_EFFORT = key("night_review", "reasoning_effort");

export const NIGHT_SERVICE_TIER = key("night_review", "service_tier");

export const DOCS_PROVIDER = key("docs", "provider");

export const DOCS_MODEL = key("docs", "model");

export const DOCS_EFFORT = key("docs", "reasoning_effort");

export const DOCS_SERVICE_TIER = key("docs", "service_tier");

export const PROJECT_LIFE_PROVIDER = key("project_life", "provider");

export const PROJECT_LIFE_MODEL = key("project_life", "model");

export const PROJECT_LIFE_EFFORT = key("project_life", "reasoning_effort");

export const PROJECT_LIFE_SERVICE_TIER = key("project_life", "service_tier");

export const ONBOARDING_PROVIDER = key("onboarding", "provider");

export const ONBOARDING_MODEL = key("onboarding", "model");

export const ONBOARDING_EFFORT = key("onboarding", "reasoning_effort");

export const ONBOARDING_SERVICE_TIER = key("onboarding", "service_tier");

export const PM_READ_PROVIDER = key("pm_read", "provider");

export const PM_READ_MODEL = key("pm_read", "model");

export const PM_READ_EFFORT = key("pm_read", "reasoning_effort");

export const PM_READ_SERVICE_TIER = key("pm_read", "service_tier");

export const PLAN_CRITIQUE_PROVIDER = key("plan_critique", "provider");

export const PLAN_CRITIQUE_MODEL = key("plan_critique", "model");

export const PLAN_CRITIQUE_EFFORT = key("plan_critique", "reasoning_effort");

export const PLAN_CRITIQUE_SERVICE_TIER = key("plan_critique", "service_tier");

export const CODE_CRITIQUE_PROVIDER = key("code_critique", "provider");

export const CODE_CRITIQUE_MODEL = key("code_critique", "model");

export const CODE_CRITIQUE_EFFORT = key("code_critique", "reasoning_effort");

export const CODE_CRITIQUE_SERVICE_TIER = key("code_critique", "service_tier");

export const SPECIALIST_PROVIDER = key("specialist", "provider");

export const SPECIALIST_MODEL = key("specialist", "model");

export const SPECIALIST_EFFORT = key("specialist", "reasoning_effort");

export const SPECIALIST_SERVICE_TIER = key("specialist", "service_tier");

export function fieldKey(id: string): I18nKey {
  return `field_${id}` as I18nKey;
}

export const PICKER_KEYS = new Set([...PAIR_ROLE_SPECS.flatMap((spec) => [...spec.keys]), ...COUNCIL_KEYS]);

export const DEDICATED_KEYS = new Set([
  "night_review.enabled", "night_review.auto_merge", "night_review.max_fix_tasks",
  "pm_read.enabled", "pm_read.min_lines",
  "docs.enabled", "docs.maintain", "docs.page_cap", "docs.since", "docs.hour",
  "project_life.enabled",
  "helper.placement", "helper.context_mode", "helper.skills", "helper.mcp_servers", "helper.bb_plugins", "helper.native_plugins",
  "plan_critique.enabled", "plan_critique.mode",
  "plan_critique.min_score", "plan_critique.min_write_tasks", "plan_critique.on_high_risk",
  "code_critique.enabled", "code_critique.mode",
  "code_critique.auto_fix", "code_critique.max_rounds",
  "specialist.enabled", "specialist.when",
]);

export const SECTIONED_SETTING_KEYS = new Set([
  "memory.enabled", "memory.maintain", "memory.inject", "memory.audience", "memory.search_engine",
  "memory.personal_bot", "memory.maintain_every", "memory.maintain_mode", "memory.salience_min", "memory.pack_mode", "memory.query_floor", "memory.project_kind", "memory.core_budget", "memory.note_budget", "memory.index_budget", "memory.context_budget",
  "specialist.enabled", "specialist.when",
  "onboarding.depth", "adoc.040", "workspace.provider", "sandbox.backend", "verification.sandbox_unsafe", "secrets.allow", "quality_mode", "critic.code.default_for_risk", "plan_fact.mode",
  "checkers.diff_hidden_limit",
  "bench.model_rebench",
  "browser_qa.enabled", "browser_qa.provider", "browser_qa.model", "browser_qa.backend",
  "browser_qa.approve", "browser_qa.reasoning_effort",
  // The self-improvement controls have their own page (src/rooms/improvement/ui); the project-level checks also sit in «Work».
  ...HUB_KEYS, ...PROJECT_DEFAULT_KEYS,
]);

export const BASIC_SETTING_KEYS = new Set([
  "browser_qa.provider", "browser_qa.model", "browser_qa.backend",
  "browser_qa.approve", "browser_qa.reasoning_effort",
]);

export type RoutingStats = { current: { providerId: string; model: string } | null; stats: Array<{ providerId: string; model: string; risk: string; tasks: number; acceptedFirstTry: number }> };

export type StackDetectResult = {
  hostId: string;
  laneStack: { present:boolean; version:string|null; sourceSha:string|null };
  openCode: { present:boolean; version:string|null };
  workspace: { path:string; present:boolean };
  targetSha: string;
  matchesTarget: boolean;
  scenario: "S1"|"S2"|"S3";
  coexistence?: {
    managers: Array<{
      manager: string; path: string; installed: boolean; configured: boolean; loaded: boolean | null;
      compatible: boolean | null; modified: boolean | null; version: string | null; sourceSha: string | null;
      sha256: string | null; owner: string; decision: string; missingCapabilities: string[];
      evidence: Array<{ kind: string; path: string | null; sha256: string | null; detail: string }>;
    }>;
  };
};

export type CouncilRow = { id: string; runId: string; question: string; state: string; round: number; maxRounds: number; decisionPath: string | null; updatedAt: number };

export type CouncilDetail = { id: string; question: string; state: string; round: number; maxRounds: number; agenda: string[]; criteria: string[]; decisionPath: string | null; reason: string | null; recommendation: string | null; seats: Array<{ id: string; title: string; providerId: string | null; model: string | null }>; messages: Array<{ seq: number; seatId: string; round: number; kind: string; text: string; at: number }> };

export function isDiagnosticOnlySetting(row: CatalogRow): boolean {
  return row.storageKey.startsWith("install.")
    || row.storageKey === "ui.language"
    || row.storageKey.startsWith("ops.")
    || row.storageKey === "run.gate";
}

export function extraSettingRows(): CatalogRow[] {
  return uniqueByStorage(VISIBLE_CATALOG.filter((row) => (
    row.uiStatus === "editable"
    && !JEV_KEYS.has(row.storageKey)
    && !PICKER_KEYS.has(row.storageKey)
    && !DEDICATED_KEYS.has(row.storageKey)
    && !row.storageKey.endsWith(".agent")
    && !SECTIONED_SETTING_KEYS.has(row.storageKey)
    && !isDiagnosticOnlySetting(row)
  )));
}

export function diagnosticRows(): CatalogRow[] {
  const settingsKeys = new Set(extraSettingRows().map((row) => row.storageKey));
  return uniqueByStorage(VISIBLE_CATALOG.filter((row) => {
    if (row.storageKey === "writer.agent") return false;
    if (row.storageKey.endsWith(".agent")) return true;
    if (row.section === "jev" || JEV_KEYS.has(row.storageKey)) return false;
    if (PICKER_KEYS.has(row.storageKey) && row.storageKey !== "writer.fast_mode") return false;
    if (DEDICATED_KEYS.has(row.storageKey)) return false;
    if (SECTIONED_SETTING_KEYS.has(row.storageKey)) return false;
    if (settingsKeys.has(row.storageKey)) return false;
    if (isCompatibilityAlias(row)) return false;
    return true;
  }));
}
