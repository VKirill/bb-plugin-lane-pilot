// Public API of self-repair/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { adoptRuleProposal, adoptWaitingRules, deleteMemoryRecord, memorySettingsFor, mountInsights, retireAdoptedRule } from "./insights";
export { insightsRpc } from "./rpc/insights";
export { createRuleScan } from "./rule-scan";
export type { RuleScanApi, RuleScanServices } from "./rule-scan";
export { selfRepairDeps } from "./deps";
export type { InsightsDeps, RepairDeps, RuleScanDeps, SelfRepairDeps } from "./deps";
export { CONFIG_KEY, SELF_REPAIR_DEFAULTS, VERSION, lanePilotProjectOrNotice, logIncidents, mountSelfRepair, readRepairRecord, readTail, resolveLanePilotProject, selfRepairRpc } from "./self-repair";
export type { Incident, RepairWorktree, SelfRepairConfig, Verdict } from "./self-repair";
export { getRepairHooks, setRepairHooks } from "./hooks";
export type { MergeDecision, NightAssignment, RepairHooks } from "./hooks";
export type { AnalyzerSelection, JobResult, ScanJob } from "./rule-scan";
