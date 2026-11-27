export const TRAJECTORY_INTERVENTION_KINDS = [
  "skill_request",
  "rule_added",
  "step_inserted",
  "reference_branch",
  "variant_selected",
  "over_constraint",
] as const;

export type TrajectoryInterventionKind = (typeof TRAJECTORY_INTERVENTION_KINDS)[number];
