import { t, type I18nKey } from "../i18n";

const BRANDS = new Set([
  "jev", "codex", "claude", "claude-code", "grok", "qwen", "kimi", "agy", "cursor", "opencode",
]);

const BY_KEY: Record<string, Record<string, I18nKey>> = {
  "adoc.040": { in_place: "enumWorkspaceInPlace", worktree: "enumWorkspaceWorktree", auto: "enumWorkspaceAuto" },
  "adoc.008": { in_place: "enumWorkspaceInPlace", worktree: "enumWorkspaceWorktree", auto: "enumWorkspaceAuto" },
  "ui.language": { en: "english", ru: "russian" },
  "plan_critique.mode": { advisory: "enumCritiqueAdvisory", gate: "enumCritiqueGate" },
  "code_critique.mode": { advisory: "enumCritiqueAdvisory", gate: "enumCritiqueGate" },
  "specialist.when": { high_risk: "enumSpecialistHighRisk", always: "enumSpecialistAlways" },
  "onboarding.depth": { fast: "enumOnboardFast", deep: "enumOnboardDeep" },
  "memory.audience": { owner: "enumMemoryOwner", subagent: "enumMemorySubagent", export: "enumMemoryExport" },
  "memory.search_engine": { auto: "enumSearchAuto", fts5: "enumSearchFts5", bm25: "enumSearchBm25" },
  "docs.since": { yesterday: "enumDocsYesterday", "24 hours ago": "enumDocs24h", "7 days ago": "enumDocs7d" },
  "run.gate": { none: "enumGateNone", "pre-merge": "enumGatePreMerge" },
  "sandbox.backend": {
    auto: "enumSandboxAuto",
    "macos-seatbelt": "enumSandboxSeatbelt",
    "linux-bubblewrap": "enumSandboxBubblewrap",
  },
  "helper.context_mode": {
    inherit: "helperContextInherit",
    selected: "helperContextSelected",
    none: "helperContextNone",
  },
  "browser_qa.backend": {
    "chrome-qa": "enumQaBackendChromeQa",
    headless: "enumQaBackendHeadless",
    "live-chrome": "enumQaBackendLiveChrome",
  },
  "browser_qa.approve": { auto: "enumQaApproveAuto", never: "enumQaApproveNever" },
  "writer.service_tier": { standard: "enumTierStandard", fast: "enumTierFast" },
  "plan_critique.service_tier": { standard: "enumTierStandard", fast: "enumTierFast" },
  "code_critique.service_tier": { standard: "enumTierStandard", fast: "enumTierFast" },
  "writer.reasoning_effort": {
    low: "enumEffortLow", medium: "enumEffortMedium", high: "enumEffortHigh", xhigh: "enumEffortXhigh", max: "enumEffortMax",
  },
  "browser_qa.reasoning_effort": {
    low: "enumEffortLow", medium: "enumEffortMedium", high: "enumEffortHigh", xhigh: "enumEffortXhigh", max: "enumEffortMax",
  },
  "memory.personal_bot": { "": "enumMemoryBotShared" },
  "helper.placement": {
    plugin: "enumHelperPlacementPlugin",
    project_tree: "enumHelperPlacementTree",
  },
  "ops.tail_source": {
    supervisor: "enumTailSupervisor",
    executor: "enumTailExecutor",
    provider: "enumTailProvider",
    report: "enumTailReport",
    verification: "enumTailVerification",
  },
};

const BOOL: Record<string, I18nKey> = { true: "enumBoolOn", false: "enumBoolOff" };

export function isBrandEnumValue(value: string): boolean {
  return BRANDS.has(value);
}

export function enumLabelKey(storageKey: string, value: string): I18nKey | "brand" | null {
  const scoped = BY_KEY[storageKey]?.[value];
  if (scoped) return scoped;
  if (BOOL[value]) return BOOL[value];
  if (isBrandEnumValue(value)) return "brand";
  return null;
}

export function presentEnumLabel(storageKey: string, value: string): string {
  const key = enumLabelKey(storageKey, value);
  if (key === "brand") return value;
  if (key) return t(key);
  return t("enumUnsupported");
}

export function enumLabelKnown(storageKey: string, value: string): boolean {
  return enumLabelKey(storageKey, value) !== null;
}
