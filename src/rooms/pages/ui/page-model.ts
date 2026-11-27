import { type CatalogRow } from "@lane-pilot/settings-catalog";
import { SETTINGS_REGISTRY } from "../../settings-registry";
import { HUB_KEYS, PROJECT_DEFAULT_KEYS } from "@lane-pilot/settings-catalog";
import { PAIR_ROLE_SPECS, roleSpecKey } from "@lane-pilot/models";
import { isCompatibilityAlias, uniqueByStorage } from "../../ui-shell/ui";

const key = (id: string, suffix: "provider" | "model" | "reasoning_effort" | "service_tier") => roleSpecKey(id, suffix);

export const WRITER_PROVIDER = key("writer", "provider");

export const WRITER_MODEL = key("writer", "model");

export const WRITER_EFFORT = key("writer", "reasoning_effort");

export const WRITER_SERVICE_TIER = key("writer", "service_tier");

export const PICKER_KEYS = new Set(PAIR_ROLE_SPECS.flatMap((spec) => [...spec.keys]));

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
  "memory.personal_bot", "memory.maintain_every", "memory.maintain_mode", "memory.salience_min", "memory.pack_mode", "memory.query_floor", "memory.project_kind", "memory.core_budget", "memory.note_budget", "memory.index_budget", "memory.context_budget", "memory.scope", "memory.single_claim", "memory.tag_notes", "memory.judge.enabled", "memory.judge.model", "memory.judge.fallback_model", "memory.judge.timeout_ms", "memory.judge.candidates",
  "specialist.enabled", "specialist.when",
  "onboarding.depth", "adoc.040", "workspace.provider", "sandbox.backend", "verification.sandbox_unsafe", "secrets.allow", "quality_mode", "critic.code.default_for_risk", "plan_fact.mode",
  "browser_qa.enabled", "browser_qa.provider", "browser_qa.model", "browser_qa.backend",
  "browser_qa.approve", "browser_qa.reasoning_effort",
  // The project-level checks also sit in «Work».
  ...HUB_KEYS, ...PROJECT_DEFAULT_KEYS,
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

export function isDiagnosticOnlySetting(row: CatalogRow): boolean {
  return row.storageKey.startsWith("install.")
    || row.storageKey === "ui.language"
    || row.storageKey.startsWith("ops.")
    || row.storageKey === "run.gate";
}

export function extraSettingRows(): CatalogRow[] {
  return uniqueByStorage(SETTINGS_REGISTRY.visible.filter((row) => (
    row.uiStatus === "editable"
    && !PICKER_KEYS.has(row.storageKey)
    && !DEDICATED_KEYS.has(row.storageKey)
    && !row.storageKey.endsWith(".agent")
    && !SECTIONED_SETTING_KEYS.has(row.storageKey)
    && !isDiagnosticOnlySetting(row)
  )));
}

export function diagnosticRows(): CatalogRow[] {
  const settingsKeys = new Set(extraSettingRows().map((row) => row.storageKey));
  return uniqueByStorage(SETTINGS_REGISTRY.visible.filter((row) => {
    if (row.storageKey === "writer.agent") return false;
    if (row.storageKey.endsWith(".agent")) return true;
    if (PICKER_KEYS.has(row.storageKey) && row.storageKey !== "writer.fast_mode") return false;
    if (DEDICATED_KEYS.has(row.storageKey)) return false;
    if (SECTIONED_SETTING_KEYS.has(row.storageKey)) return false;
    if (settingsKeys.has(row.storageKey)) return false;
    if (isCompatibilityAlias(row)) return false;
    return true;
  }));
}
