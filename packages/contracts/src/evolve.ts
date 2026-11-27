export const CASE_SPLITS = ["working", "held_out"] as const;
export type CaseSplit = (typeof CASE_SPLITS)[number];

export const ARM_KINDS = ["model", "form", "check"] as const;
export type ArmKind = (typeof ARM_KINDS)[number];

export const HYPOTHESIS_SOURCES = ["census", "fallback", "catalog_change", "lead_road", "owner"] as const;
export type HypothesisSource = (typeof HYPOTHESIS_SOURCES)[number];

export const HYPOTHESIS_STATES = [
  "queued",
  "replaying",
  "report_only",
  "canary",
  "promoted",
  "retired",
  "rejected",
] as const;
export type HypothesisState = (typeof HYPOTHESIS_STATES)[number];

export const ACTIVE_HYPOTHESIS_STATES = [
  "queued",
  "replaying",
  "report_only",
  "canary",
] as const satisfies readonly HypothesisState[];

export const EVOLVE_TRIAL_STATES = [
  "open",
  "promoted",
  "retired",
  "rolled_back",
] as const;
export type EvolveTrialState = (typeof EVOLVE_TRIAL_STATES)[number];

export const EVOLVE_VARIANT_KEYS = [
  "provider",
  "model",
  "reasoning",
  "service_tier",
  "form",
  "fallback",
  "plan",
  "script",
  "verify",
  "gates",
] as const;

export const EVOLVE_THRESHOLDS = {
  heldOutMin: 20,
  workingMin: 10,
  heldOutShare: 0.3,
  nonInferiority: -0.10,
  repeats: 3,
  fallbackDemote: 0.2,
  checkerCatch: 0.9,
  judgeAgreementLow: 0.7,
  activeCap: 3,
  canaryShare: 0.2,
} as const;
