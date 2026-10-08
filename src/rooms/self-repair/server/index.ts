// Public API of self-repair/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { adoptRuleProposal, adoptWaitingRules, memorySettingsFor, mountInsights } from "./insights";
export { insightsRpc } from "./rpc/insights";
export { createRuleScan } from "./rule-scan";
export type { RuleScanApi } from "./rule-scan";
export { CONFIG_KEY, SELF_REPAIR_DEFAULTS, mountSelfRepair, selfRepairRpc } from "./self-repair";
