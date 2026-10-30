import { t, type I18nKey } from "@lane-pilot/i18n";

const BRANDS = new Set([
  "jev", "codex", "claude", "claude-code", "grok", "qwen", "kimi", "agy", "cursor", "opencode",
]);

const BY_KEY: Record<string, Record<string, I18nKey>> = {
  "adoc.040": { in_place: "enumWorkspaceInPlace", worktree: "enumWorkspaceWorktree", auto: "enumWorkspaceAuto" },
  "adoc.008": { in_place: "enumWorkspaceInPlace", worktree: "enumWorkspaceWorktree", auto: "enumWorkspaceAuto" },
  "ui.language": { en: "english", ru: "russian" },
  "plan_critique.mode": { advisory: "enumCritiqueAdvisory", gate: "enumCritiqueGate" },
  "code_critique.mode": { advisory: "enumCritiqueAdvisory", gate: "enumCritiqueGate" },
  "quality_mode": { quick: "enumQualityQuick", standard: "enumQualityStandard", full: "enumQualityFull" },
  "writer.best_of": { off: "enumBestOfOff", "3": "enumBestOf3" },
  "specialist.when": { high_risk: "enumSpecialistHighRisk", always: "enumSpecialistAlways" },
  "onboarding.depth": { fast: "enumOnboardFast", deep: "enumOnboardDeep" },
  "memory.audience": { owner: "enumMemoryOwner", subagent: "enumMemorySubagent", export: "enumMemoryExport" },
  "memory.search_engine": { auto: "enumSearchAuto", fts5: "enumSearchFts5", bm25: "enumSearchBm25" },
  "docs.since": { yesterday: "enumDocsYesterday", "24 hours ago": "enumDocs24h", "7 days ago": "enumDocs7d" },
  "docs.enabled": { auto: "docsModeAuto", true: "docsModeOn", false: "docsModeOff" },
  "run.gate": { none: "enumGateNone", "pre-merge": "enumGatePreMerge" },
  "integration.gate_when": { queue_drained: "enumIntegrationGateDrained", every_n: "enumIntegrationGateEveryN" },
  "workspace.provider": { auto: "enumWorkspaceProviderAuto", off: "enumWorkspaceProviderOff" },
  "writer.skill_pick": { on: "enumSkillPickOn", off: "enumSkillPickOff" },
  "critic.code.default_for_risk": { off: "enumCriticCodeOff", medium: "enumCriticCodeMedium", high: "enumCriticCodeHigh" },
  "plan_fact.mode": { record: "enumPlanFactRecord", gate: "enumPlanFactGate" },
  "baseline.already_built": { notify: "enumBaselineNotify", stop: "enumBaselineStop" },
  "harness.adopt_by": { bench: "enumAdoptBench", live: "enumAdoptLive" },
  "wall.hunter_reasoning_effort": {
    low: "enumEffortLow", medium: "enumEffortMedium", high: "enumEffortHigh", xhigh: "enumEffortXhigh", max: "enumEffortMax",
  },
  "checks.require_red_on_base": { off: "enumRequireRedOff", medium: "enumRequireRedMedium", high: "enumRequireRedHigh" },
  "writer.fallback_on_provider_failure": { immediate: "enumFallbackImmediate", after_retry: "enumFallbackAfterRetry" },
  "bench.model_rebench": { on: "enumModelRebenchOn", off: "enumModelRebenchOff" },
  "failure.interventions": { on: "enumInterventionsOn", off: "enumInterventionsOff" },
  "writer.pair_pin": { on: "enumPairPinOn", off: "enumPairPinOff" },
  "writer.auto_return": { on: "enumAutoReturnOn", off: "enumAutoReturnOff" },
  "writer.route_record": { on: "enumRouteRecordOn", off: "enumRouteRecordOff" },
  "writer.capacity_wait": { on: "enumCapacityWaitOn", off: "enumCapacityWaitOff" },
  "checks.fail_fast": { on: "enumFailFastOn", off: "enumFailFastOff" },
  "writer.retry_safety": { on: "enumRetrySafetyOn", off: "enumRetrySafetyOff" },
  "writer.pick_refusal_penalty": { on: "enumRefusalPenaltyOn", off: "enumRefusalPenaltyOff" },
  "writer.owns_barrier": { on: "enumOwnsBarrierOn", off: "enumOwnsBarrierOff" },
  "memory.maintain_mode": { wave: "enumMaintainModeWave", task: "enumMaintainModeTask" },
  "memory.pack_mode": { off: "enumPackModeOff", shadow: "enumPackModeShadow", adapter: "enumPackModeAdapter", canary: "enumPackModeCanary" },
  "memory.query_floor": { on: "enumQueryFloorOn", off: "enumQueryFloorOff" },
  "bench.weekly": { on: "enumBenchWeeklyOn", off: "enumBenchWeeklyOff" },
  "bench.nightly": { on: "enumBenchNightlyOn", off: "enumBenchNightlyOff" },
  "memory.project_kind": { auto: "enumProjectKindAuto", standalone: "enumProjectKindStandalone", umbrella: "enumProjectKindUmbrella" },
  "jev.provider": { openlux: "enumJevProviderOpenlux", typesafe: "enumJevProviderTypesafe" },
  "sandbox.backend": {
    auto: "enumSandboxAuto",
    "macos-seatbelt": "enumSandboxSeatbelt",
    "linux-bubblewrap": "enumSandboxBubblewrap",
  },
  "helper.context_mode": {
    roles: "helperContextRoles",
    inherit: "helperContextInherit",
    selected: "helperContextSelected",
    none: "helperContextNone",
  },
  "browser_qa.backend": {
    "bb-browser": "enumQaBackendBbBrowser",
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
