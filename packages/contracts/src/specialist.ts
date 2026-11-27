export const OUTCOME_VERDICTS = ["pending", "within", "above", "below", "inconclusive"] as const;
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number];

export function isOutcomeVerdict(value: unknown): value is OutcomeVerdict {
  return typeof value === "string" && (OUTCOME_VERDICTS as readonly string[]).includes(value);
}

export const CONCLUSIVE_OUTCOME_VERDICTS = ["within", "above", "below"] as const satisfies readonly OutcomeVerdict[];
export type ConclusiveOutcomeVerdict = (typeof CONCLUSIVE_OUTCOME_VERDICTS)[number];

export function isConclusiveOutcomeVerdict(value: unknown): value is ConclusiveOutcomeVerdict {
  return typeof value === "string" && (CONCLUSIVE_OUTCOME_VERDICTS as readonly string[]).includes(value);
}

export const HYPOTHESIS_STATES_SP = ["open", "testing", "worked", "refuted", "dropped"] as const;
export type HypothesisStateSp = (typeof HYPOTHESIS_STATES_SP)[number];

export function isHypothesisStateSp(value: unknown): value is HypothesisStateSp {
  return typeof value === "string" && (HYPOTHESIS_STATES_SP as readonly string[]).includes(value);
}

export const AUTONOMY_CLASSES = ["observe", "propose", "bounded_auto"] as const;
export type AutonomyClass = (typeof AUTONOMY_CLASSES)[number];

export function isAutonomyClass(value: unknown): value is AutonomyClass {
  return typeof value === "string" && (AUTONOMY_CLASSES as readonly string[]).includes(value);
}

export const RULE_SCOPES = ["local", "shared"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export function isRuleScope(value: unknown): value is RuleScope {
  return typeof value === "string" && (RULE_SCOPES as readonly string[]).includes(value);
}

export const RULE_STATES = ["proposed", "active", "retired"] as const;
export type RuleState = (typeof RULE_STATES)[number];

export function isRuleState(value: unknown): value is RuleState {
  return typeof value === "string" && (RULE_STATES as readonly string[]).includes(value);
}
