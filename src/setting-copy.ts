import { t, type I18nKey } from "../i18n";
import type { CatalogRow } from "./ui-catalog";

export type SettingMeta = {
  label: I18nKey;
  help: I18nKey;
  unit?: I18nKey;
};

export const SETTING_META: Record<string, SettingMeta> = {
  "memory.enabled": { label: "settingMemoryEnabled", help: "settingMemoryEnabledHelp" },
  "memory.maintain": { label: "settingMemoryMaintain", help: "settingMemoryMaintainHelp" },
  "memory.inject": { label: "settingMemoryInject", help: "settingMemoryInjectHelp" },
  "memory.audience": { label: "settingMemoryAudience", help: "settingMemoryAudienceHelp" },
  "memory.search_engine": { label: "settingMemorySearch", help: "settingMemorySearchHelp" },
  "memory.personal_bot": { label: "settingMemoryBot", help: "settingMemoryBotHelp" },
  "memory.core_budget": { label: "settingMemoryCoreBudget", help: "settingMemoryCoreBudgetHelp", unit: "fieldUnitTokens" },
  "memory.note_budget": { label: "settingMemoryNoteBudget", help: "settingMemoryNoteBudgetHelp", unit: "fieldUnitTokens" },
  "memory.index_budget": { label: "settingMemoryIndexBudget", help: "settingMemoryIndexBudgetHelp", unit: "fieldUnitTokens" },
  "memory.context_budget": { label: "settingMemoryContextBudget", help: "settingMemoryContextBudgetHelp", unit: "fieldUnitTokens" },
  "docs.enabled": { label: "groupDocs", help: "docsPickerHelp" },
  "docs.maintain": { label: "docsMaintain", help: "docsMaintainHelp" },
  "docs.page_cap": { label: "docsPageCap", help: "settingDocsPageCapHelp", unit: "fieldUnitPages" },
  "docs.since": { label: "docsSince", help: "settingDocsSinceHelp" },
  "docs.hour": { label: "docsHour", help: "settingDocsHourHelp", unit: "fieldUnitHours" },
  "pm_read.enabled": { label: "largeFileRead", help: "largeFileReadHelp" },
  "pm_read.min_lines": { label: "largeFileThreshold", help: "largeFileThresholdHelp", unit: "fieldUnitLines" },
  "helper.placement": { label: "helperPlacement", help: "helperPlacementHelp" },
  "helper.context_mode": { label: "helperContextMode", help: "helperContextHelp" },
  "helper.skills": { label: "helperSkills", help: "emptyAllowlist" },
  "helper.mcp_servers": { label: "helperMcp", help: "emptyAllowlist" },
  "helper.bb_plugins": { label: "helperPlugins", help: "emptyAllowlist" },
  "helper.native_plugins": { label: "helperNative", help: "emptyAllowlist" },
  "plan_critique.enabled": { label: "stagePlanCritique", help: "planCritiqueHelp" },
  "plan_critique.mode": { label: "settingPlanMode", help: "planCritiqueHelp" },
  "plan_critique.min_score": { label: "settingPlanMinScore", help: "settingPlanMinScoreHelp", unit: "fieldUnitScore" },
  "plan_critique.min_write_tasks": { label: "settingPlanMinWrites", help: "settingPlanMinWritesHelp", unit: "fieldUnitTasks" },
  "plan_critique.on_high_risk": { label: "settingPlanHighRisk", help: "settingPlanHighRiskHelp" },
  "code_critique.enabled": { label: "stageCodeCritique", help: "codeCritiqueHelp" },
  "code_critique.mode": { label: "settingCodeMode", help: "codeCritiqueHelp" },
  "code_critique.auto_fix": { label: "settingCodeAutoFix", help: "codeCritiqueHelp" },
  "code_critique.max_rounds": { label: "settingCodeMaxRounds", help: "settingCodeMaxRoundsHelp", unit: "fieldUnitRounds" },
  "night_review.enabled": { label: "nightReviewEnabled", help: "nightReviewEnabled" },
  "night_review.auto_merge": { label: "nightReviewAutoMerge", help: "nightReviewAutoMergeHelp" },
  "night_review.max_fix_tasks": { label: "settingNightMaxFixes", help: "settingNightMaxFixesHelp", unit: "fieldUnitTasks" },
  "writer.agent": { label: "settingWriterAgent", help: "writerAgentHelp" },
  "ops.max_tasks": { label: "settingOpsMaxTasks", help: "settingOpsMaxTasksHelp", unit: "fieldUnitTasks" },
  "adoc.040": { label: "workspaceMode", help: "workspaceModeHelp" },
  "adoc.041": { label: "settingWorktreeScore", help: "settingWorktreeScoreHelp", unit: "fieldUnitScore" },
  "adoc.042": { label: "settingWorktreeMulti", help: "settingWorktreeMultiHelp" },
  "onboarding.depth": { label: "settingOnboardDepth", help: "onboardingPickerHelp" },
  "sandbox.backend": { label: "settingSandboxBackend", help: "settingSandboxBackendHelp" },
  "specialist.enabled": { label: "settingSpecialistEnabled", help: "settingSpecialistEnabledHelp" },
  "specialist.when": { label: "settingSpecialistWhen", help: "settingSpecialistWhenHelp" },
  "specialist.provider": { label: "settingSpecialistProvider", help: "settingSpecialistProviderHelp" },
  "specialist.model": { label: "settingSpecialistModel", help: "settingSpecialistProviderHelp" },
  "specialist.reasoning_effort": { label: "settingSpecialistEffort", help: "settingSpecialistProviderHelp" },
  "browser_qa.enabled": { label: "stageBrowserQa", help: "browserQaApproveHelp" },
  "browser_qa.provider": { label: "settingQaProvider", help: "browserQaProviderLimit" },
  "browser_qa.model": { label: "settingQaModel", help: "browserQaProviderLimit" },
  "browser_qa.backend": { label: "settingQaBackend", help: "browserQaProviderLimit" },
  "browser_qa.reasoning_effort": { label: "settingQaEffort", help: "browserQaProviderLimit" },
  "browser_qa.approve": { label: "browserQaApprove", help: "browserQaApproveHelp" },
  "ui.language": { label: "settingUiLanguage", help: "settingUiLanguageHelp" },
  "install.LANE_INSTALL_LOCAL_MARKETPLACE": { label: "settingInstallLocalMarket", help: "settingInstallHelp" },
  "install.LANE_INSTALL_CLAUDE_PLUGIN": { label: "settingInstallClaudePlugin", help: "settingInstallHelp" },
  "install.CLAUDE_CONFIG_DIR": { label: "settingInstallClaudeDir", help: "settingInstallHelp" },
  "install.CODEX_HOME": { label: "settingInstallCodexHome", help: "settingInstallHelp" },
  "ops.run_dir": { label: "settingOpsRunDir", help: "settingOpsCliHelp" },
  "ops.project_cwd": { label: "settingOpsProjectCwd", help: "settingOpsCliHelp" },
  "ops.poll_interval": { label: "settingOpsPoll", help: "settingOpsCliHelp", unit: "fieldUnitSeconds" },
  "ops.heartbeat_interval": { label: "settingOpsHeartbeat", help: "settingOpsCliHelp", unit: "fieldUnitSeconds" },
  "ops.retry_backoff": { label: "settingOpsBackoff", help: "settingOpsCliHelp", unit: "fieldUnitSeconds" },
  "ops.watch_timeout": { label: "settingOpsWatchTimeout", help: "settingOpsCliHelp", unit: "fieldUnitSeconds" },
  "ops.task_id": { label: "settingOpsTaskId", help: "settingOpsCliHelp" },
  "ops.task_file": { label: "settingOpsTaskFile", help: "settingOpsCliHelp" },
  "ops.idle": { label: "settingOpsIdle", help: "settingOpsCliHelp", unit: "fieldUnitSeconds" },
  "ops.max_runtime": { label: "settingOpsMaxRuntime", help: "settingOpsCliHelp", unit: "fieldUnitSeconds" },
  "ops.pool_size": { label: "settingOpsPool", help: "settingOpsCliHelp", unit: "fieldUnitTasks" },
  "ops.tail_source": { label: "settingOpsTailSource", help: "settingOpsCliHelp" },
  "ops.tail_lines": { label: "settingOpsTailLines", help: "settingOpsCliHelp", unit: "fieldUnitLines" },
  "ops.events_limit": { label: "settingOpsEventsLimit", help: "settingOpsCliHelp", unit: "fieldUnitTasks" },
  "ops.verify_pool_size": { label: "settingOpsVerifyPool", help: "settingOpsCliHelp", unit: "fieldUnitTasks" },
  "ops.command_timeout": { label: "settingOpsCommandTimeout", help: "settingOpsCliHelp", unit: "fieldUnitSeconds" },
  "run.gate": { label: "settingRunGate", help: "settingRunGateHelp" },
};

export function settingMeta(storageKey: string): SettingMeta | undefined {
  return SETTING_META[storageKey];
}

export function settingLabel(row: CatalogRow): string {
  const mapped = SETTING_META[row.storageKey];
  if (mapped) return t(mapped.label);
  return t(`field_${row.id}` as I18nKey);
}

export function settingHelp(row: CatalogRow, fallback: string): string {
  const mapped = SETTING_META[row.storageKey];
  return mapped ? t(mapped.help) : fallback;
}

export function settingUnitKey(row: CatalogRow): I18nKey | null {
  const mapped = SETTING_META[row.storageKey]?.unit;
  if (mapped) return mapped;
  if (row.min !== null && row.max !== null) {
    return row.storageKey.includes("score") ? "fieldUnitScore" : "fieldUnitTasks";
  }
  return null;
}

export function settingUsesNumericControl(row: CatalogRow): boolean {
  if (row.control === "slider" || row.control === "number") return true;
  return settingUnitKey(row) != null && row.control === "input";
}

export function settingLabelIsRaw(row: CatalogRow, localeText: string): boolean {
  const raw = [row.storageKey, row.setting, row.id, `field_${row.id}`];
  return raw.some((item) => item === localeText);
}
