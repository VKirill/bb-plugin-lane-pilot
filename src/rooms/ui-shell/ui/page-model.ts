import { VISIBLE_CATALOG, type CatalogRow } from "@lane-pilot/settings-catalog";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { settingUnitKey } from "../../settings/setting-copy";
import { Tabs } from "@lane-pilot/ui-kit";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../../runs/state-machine";
import type { StageReceipt } from "../../tasks";

/** History comes this many runs at a time. */
export const RUNS_PAGE = 20;

export const CARD_HEAD = "space-y-1 px-3 pb-2 pt-3";

export const CARD_BODY = "px-3 pb-3 pt-0";

/** A stage row as the list shows it: its result body loads when the owner opens it. */
export type StageSummary = Omit<StageReceipt, "result"> & { hasResult?: boolean };

export type ScreenPayload = {
  projectId: string;
  sectionId?: string | null;
  hostId: string | null;
  workspacePath: string | null;
  legacyStack?: boolean;
  values: Record<string, unknown>;
  versions: Record<string, number>;
  explicitKeys: string[];
  importSource: { completed: boolean; at: number | null; routingPath: string | null; nightPath: string | null };
  /** All runs of the project; `runs` holds the newest few and every open one. */
  runsTotal?: number;
  runsLimit?: number;
  runs: Array<{
    id: string;
    state: string;
    kind: string;
    created_at: number;
    updated_at: number;
    cliReceiptJson: string | null;
    pmThread?: { id: string; title: string | null; status: string | null } | null;
    /** How many stage rows the run has; the rows themselves load when the owner opens the list. */
    stageCount?: number;
    attempts: Array<{
      id: string;
      state: string;
      attempt_no: number;
      thread_id: string | null;
      reason: string | null;
      task_id: string;
      cliReceiptJson: string | null;
    }>;
  }>;
  unapplied: Array<{ key: string; reason: string }>;
  cliPreview: { argv:string[]; env:Record<string, string>; applied:string[]; unapplied:Array<{ key:string; reason:string }> };
  lastSnapshotPath: string | null;
  lastReceiptJson: string | null;
  writerResultJson: string | null;
  writerResultPatch: string | null;
  cliReceiptJson: string | null;
  inheritedKeys?: string[];
  writerBinding?: {
    status: "resolved" | "ambiguous" | "setup_required" | "offline" | "catalog_unavailable";
    hostId: string | null;
    path: string | null;
    source: "session" | "unique_source" | "explicit_override" | null;
    bindings: Array<{ id?: string; hostId: string; path: string; isDefault?: boolean }>;
  };
  qaHosts?: Array<{ id: string; name: string; status: string; connected: boolean }>;
  compiledMainAgent?: "supported" | "none";
  mainAgents?: Array<{ id: string; description: string }>;
  lastWriterTrace?: {
    providerId: string;
    model: string;
    requestedReasoningLevel: string;
    effectiveReasoningLevel: string;
    serviceTier: "default" | "fast" | null;
    fallbackReason: string | null;
    jevStatus: "ok" | "disabled" | "timeout" | "error";
    effortMode?: "automatic" | "manual";
    selectionSource?: {
      providerId: string;
      model: string;
      reasoningLevel: string;
      serviceTier: "default" | "fast" | null;
      reasoningLevelSource: "explicit" | "client-preference";
    };
  } | null;
};

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

export const JEV_KEYS = new Set(["jev.LANE_JEV_EFFORT", "jev.LANE_OPENCODE_JEV"]);

export const COEXISTENCE_MANAGER_KEYS: Record<string, I18nKey> = {
  "agents-marker":"coexAgentsMarker", "managed-checkout":"coexManagedCheckout", "claude-cache":"coexClaudeCache",
  "claude-settings":"coexClaudeSettings", "opencode-config":"coexOpenCodeConfig", "opencode-plugin":"coexOpenCodePlugin",
};

export const COEXISTENCE_VALUE_KEYS: Record<string, I18nKey> = {
  "lane-pilot":"coexOwnerLanePilot", user:"coexOwnerUser", upstream:"coexOwnerUpstream", unknown:"coexOwnerUnknown",
  reuse:"coexDecisionReuse", install:"coexDecisionInstall", upgrade:"coexDecisionUpgrade", conflict:"coexDecisionConflict",
  skip:"coexDecisionSkip", "disconnect-owned":"coexDecisionDisconnectOwned",
};

export const WRITER_PROVIDER = "writer.provider";

export const WRITER_MODEL = "writer.model";

export const WRITER_EFFORT = "writer.reasoning_effort";

export const WRITER_SERVICE_TIER = "writer.service_tier";

export const MEMORY_PROVIDER = "memory.provider";

export const MEMORY_MODEL = "memory.model";

export const MEMORY_EFFORT = "memory.reasoning_effort";

export const MEMORY_SERVICE_TIER = "memory.service_tier";

export const NIGHT_PROVIDER = "night_review.provider";

export const NIGHT_MODEL = "night_review.model";

export const NIGHT_EFFORT = "night_review.reasoning_effort";

export const NIGHT_SERVICE_TIER = "night_review.service_tier";

export const DOCS_PROVIDER = "docs.provider";

export const DOCS_MODEL = "docs.model";

export const DOCS_EFFORT = "docs.reasoning_effort";

export const DOCS_SERVICE_TIER = "docs.service_tier";

export const PROJECT_LIFE_PROVIDER = "project_life.provider";

export const PROJECT_LIFE_MODEL = "project_life.model";

export const PROJECT_LIFE_EFFORT = "project_life.reasoning_effort";

export const PROJECT_LIFE_SERVICE_TIER = "project_life.service_tier";

export const ONBOARDING_PROVIDER = "onboarding.provider";

export const ONBOARDING_MODEL = "onboarding.model";

export const ONBOARDING_EFFORT = "onboarding.reasoning_effort";

export const ONBOARDING_SERVICE_TIER = "onboarding.service_tier";

export const PM_READ_PROVIDER = "pm_read.provider";

export const PM_READ_MODEL = "pm_read.model";

export const PM_READ_EFFORT = "pm_read.reasoning_effort";

export const PM_READ_SERVICE_TIER = "pm_read.service_tier";

export const PLAN_CRITIQUE_PROVIDER = "plan_critique.provider";

export const PLAN_CRITIQUE_MODEL = "plan_critique.model";

export const PLAN_CRITIQUE_EFFORT = "plan_critique.reasoning_effort";

export const PLAN_CRITIQUE_SERVICE_TIER = "plan_critique.service_tier";

export const CODE_CRITIQUE_PROVIDER = "code_critique.provider";

export const CODE_CRITIQUE_MODEL = "code_critique.model";

export const CODE_CRITIQUE_EFFORT = "code_critique.reasoning_effort";

export const CODE_CRITIQUE_SERVICE_TIER = "code_critique.service_tier";

export const COUNCIL_SEATS = ["product", "demand", "audience", "skeptic", "growth", "ux", "chair"] as const;

export const SPECIALIST_PROVIDER = "specialist.provider";

export const SPECIALIST_MODEL = "specialist.model";

export const SPECIALIST_EFFORT = "specialist.reasoning_effort";

export const SPECIALIST_SERVICE_TIER = "specialist.service_tier";

export function fieldKey(id: string): I18nKey {
  return `field_${id}` as I18nKey;
}

export function reasonKey(id: string): I18nKey {
  return `reason_${id}` as I18nKey;
}

export function sectionKey(section: string): I18nKey {
  return `section_${section}` as I18nKey;
}

export function stageTitle(stageId: string): string {
  const labels: Record<string, I18nKey> = {
    "plan-critique":"stagePlanCritique",
    "code-critique":"stageCodeCritique",
    "writer-agent":"stageWriterAgent",
    verification:"stageVerification",
    "acceptance-receipt":"stageAcceptanceReceipt",
    "browser-qa":"stageBrowserQa",
    "night-review":"stageNightReview",
    "workspace-status":"stageWorkspaceStatus",
    "opencode-telemetry":"stageOpenCodeTelemetry",
    "pm-read":"stagePmRead",
    "integration-gate":"stageVerification",
  };
  const key = labels[stageId];
  return key ? t(key) : stageId;
}

export const PICKER_KEYS = new Set([
  WRITER_PROVIDER, WRITER_MODEL, WRITER_EFFORT, WRITER_SERVICE_TIER,
  MEMORY_PROVIDER, MEMORY_MODEL, MEMORY_EFFORT, MEMORY_SERVICE_TIER,
  NIGHT_PROVIDER, NIGHT_MODEL, NIGHT_EFFORT, NIGHT_SERVICE_TIER,
  DOCS_PROVIDER, DOCS_MODEL, DOCS_EFFORT, DOCS_SERVICE_TIER,
  PROJECT_LIFE_PROVIDER, PROJECT_LIFE_MODEL, PROJECT_LIFE_EFFORT, PROJECT_LIFE_SERVICE_TIER,
  ONBOARDING_PROVIDER, ONBOARDING_MODEL, ONBOARDING_EFFORT, ONBOARDING_SERVICE_TIER,
  PM_READ_PROVIDER, PM_READ_MODEL, PM_READ_EFFORT, PM_READ_SERVICE_TIER,
  PLAN_CRITIQUE_PROVIDER, PLAN_CRITIQUE_MODEL, PLAN_CRITIQUE_EFFORT, PLAN_CRITIQUE_SERVICE_TIER,
  CODE_CRITIQUE_PROVIDER, CODE_CRITIQUE_MODEL, CODE_CRITIQUE_EFFORT, CODE_CRITIQUE_SERVICE_TIER,
  SPECIALIST_PROVIDER, SPECIALIST_MODEL, SPECIALIST_EFFORT, SPECIALIST_SERVICE_TIER,
  ...COUNCIL_SEATS.flatMap((seat) => [`council.${seat}.provider`, `council.${seat}.model`, `council.${seat}.reasoning_effort`]),
]);

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
  "memory.personal_bot", "memory.core_budget", "memory.note_budget", "memory.index_budget", "memory.context_budget",
  "specialist.enabled", "specialist.when",
  "onboarding.depth", "ops.max_tasks", "adoc.040", "adoc.041", "adoc.042", "workspace.provider", "sandbox.backend", "verification.sandbox_unsafe", "secrets.allow", "quality_mode",
  "browser_qa.enabled", "browser_qa.provider", "browser_qa.model", "browser_qa.backend",
  "browser_qa.approve", "browser_qa.reasoning_effort",
]);

export const BASIC_SETTING_KEYS = new Set([
  "browser_qa.provider", "browser_qa.model", "browser_qa.backend",
  "browser_qa.approve", "browser_qa.reasoning_effort",
]);

export const HELP_BY_KEY: Record<string, I18nKey> = {
  "pm_read.enabled": "largeFileReadHelp",
  "pm_read.min_lines": "largeFileThresholdHelp",
  "docs.maintain": "docsMaintainHelp",
  "docs.page_cap": "docsPageCap",
  "docs.since": "docsSince",
  "docs.hour": "docsHour",
  "adoc.040": "workspaceModeHelp",
  "adoc.041": "workspaceModeHelp",
  "adoc.042": "workspaceModeHelp",
  "browser_qa.enabled": "browserQaApproveHelp",
  "browser_qa.approve": "browserQaApproveHelp",
  "browser_qa.provider": "browserQaProviderLimit",
  "browser_qa.model": "browserQaProviderLimit",
  "browser_qa.backend": "browserQaProviderLimit",
  "browser_qa.reasoning_effort": "browserQaProviderLimit",
  "writer.agent": "writerAgentHelp",
  "helper.placement": "helperPlacementHelp",
  "plan_critique.enabled": "planCritiqueHelp",
  "plan_critique.mode": "planCritiqueHelp",
  "code_critique.enabled": "codeCritiqueHelp",
  "code_critique.mode": "codeCritiqueHelp",
  "code_critique.auto_fix": "codeCritiqueHelp",
  "code_critique.max_rounds": "codeCritiqueHelp",
  "helper.context_mode": "helperContextHelp",
  "helper.skills": "emptyAllowlist",
  "helper.mcp_servers": "emptyAllowlist",
  "helper.bb_plugins": "emptyAllowlist",
  "helper.native_plugins": "emptyAllowlist",
};

export function uniqueByStorage(rows: CatalogRow[]): CatalogRow[] {
  const rank: Record<CatalogRow["uiStatus"], number> = { editable: 3, readonly: 2, gap: 1, excluded: 0 };
  const byKey = new Map<string, CatalogRow>();
  for (const row of rows) {
    const current = byKey.get(row.storageKey);
    if (!current || rank[row.uiStatus] > rank[current.uiStatus]) byKey.set(row.storageKey, row);
  }
  return [...byKey.values()];
}

export function isCompatibilityAlias(row: CatalogRow): boolean {
  return row.storageKey.startsWith("adoc.") && row.channel === "NONE";
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

export function compatibilityAliasRows(): CatalogRow[] {
  return uniqueByStorage(VISIBLE_CATALOG.filter((row) => isCompatibilityAlias(row)));
}

export function isDiagnosticOnlySetting(row: CatalogRow): boolean {
  return row.storageKey.startsWith("install.")
    || row.storageKey === "ui.language"
    || (row.storageKey.startsWith("ops.") && row.storageKey !== "ops.max_tasks")
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

export function numericUnit(row: CatalogRow): I18nKey {
  return settingUnitKey(row) ?? (row.storageKey.includes("score") ? "fieldUnitScore" : "fieldUnitTasks");
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "on" || value === "true") return true;
  if (value === "0" || value === "off" || value === "false" || value === "no") return false;
  return fallback;
}

export const TAB_LABELS: Record<string, I18nKey> = {
  overview: "tabOverview", settings: "tabSettings", checks: "tabChecks", council: "tabCouncil",
  memory: "tabMemory", access: "tabAccess", anamnesis: "tabAnamnesis", rules: "tabRules", workflows: "tabWorkflows", schedule: "tabSchedule", monitor: "tabMonitor", service: "tabService",
};

/** Tabs the Basic/Advanced switch applies to. */
export const SETTINGS_TABS = new Set(["settings", "checks", "council", "memory"]);

export const OPEN_ATTEMPT_STATES = ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"];

export type RoutingStats = { current: { providerId: string; model: string } | null; stats: Array<{ providerId: string; model: string; risk: string; tasks: number; acceptedFirstTry: number }> };

export function runTone(state: string): "default" | "secondary" | "destructive" | "outline" | "success" {
  if (state === "accepted" || state === "passed") return "success";
  if (state === "failed" || state === "blocked" || state === "provider_error" || state === "validation_failed") return "destructive";
  if (state === "running" || state === "pending") return "secondary";
  return "outline";
}

export type MonitorRun = ScreenPayload["runs"][number];

export type MonitorAttempt = MonitorRun["attempts"][number];

export function canCancelAttempt(run: MonitorRun, attempt: MonitorAttempt): boolean {
  return (run.state === "pending" || run.state === "running")
    && ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(attempt.state)
    && (attempt.state === "queued" || Boolean(attempt.thread_id));
}

export function canRetryAttempt(run: MonitorRun, attempt: MonitorAttempt): boolean {
  return (run.state === "pending" || run.state === "running")
    && RETRY_ELIGIBLE.some((state) => state === attempt.state)
    && run.attempts.filter((item) => item.task_id === attempt.task_id).length < MAIN_ATTEMPT_LIMIT;
}

export type CouncilRow = { id: string; runId: string; question: string; state: string; round: number; maxRounds: number; decisionPath: string | null; updatedAt: number };

export type CouncilDetail = { id: string; question: string; state: string; round: number; maxRounds: number; agenda: string[]; criteria: string[]; decisionPath: string | null; reason: string | null; recommendation: string | null; seats: Array<{ id: string; title: string; providerId: string | null; model: string | null }>; messages: Array<{ seq: number; seatId: string; round: number; kind: string; text: string; at: number }> };
