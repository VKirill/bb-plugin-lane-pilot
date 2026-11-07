import { VISIBLE_CATALOG, type CatalogRow } from "@lane-pilot/settings-catalog";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { COUNCIL_SEATS } from "@lane-pilot/models";
import type { StageReceipt } from "@lane-pilot/contracts";
import { settingUnitKey } from "./setting-copy";

export { COUNCIL_SEATS };

/** History comes this many runs at a time. */

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
  mainAgents?: Array<{ id: string; description: string; kind?: string }>;
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
    "critic-tiebreak":"stageCriticTiebreak",
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

export function runTone(state: string): "default" | "secondary" | "destructive" | "outline" | "success" {
  if (state === "accepted" || state === "passed") return "success";
  if (state === "failed" || state === "blocked" || state === "provider_error" || state === "validation_failed") return "destructive";
  if (state === "running" || state === "pending") return "secondary";
  return "outline";
}

export const HELP_BY_KEY: Record<string, I18nKey> = {
  "pm_read.enabled": "largeFileReadHelp",
  "pm_read.min_lines": "largeFileThresholdHelp",
  "docs.maintain": "docsMaintainHelp",
  "docs.page_cap": "docsPageCap",
  "docs.since": "docsSince",
  "docs.hour": "docsHour",
  "adoc.040": "workspaceModeHelp",
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

export function compatibilityAliasRows(): CatalogRow[] {
  return uniqueByStorage(VISIBLE_CATALOG.filter((row) => isCompatibilityAlias(row)));
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

/** The page surface a catalog field reads and writes; the page hook (`LpPage`) satisfies it. */
export type CatalogFieldPage = {
  catalogRow(key: string): CatalogRow | undefined;
  displayedValue(key: string): unknown;
  applySetting(row: CatalogRow, value: unknown): Promise<boolean>;
  writeDraft(key: string, value: unknown): void;
};

/** The page surface the model-overrides panel reads and writes. */
export type ModelOverridesPage = {
  rpc: { call(method: string, input: unknown): Promise<unknown> };
  projectCache: { current: Map<string, unknown> };
};
