export const RUN_VERDICTS = ["accept", "reject"] as const;
export type RunVerdict = (typeof RUN_VERDICTS)[number];

export const RUN_VERDICT_SOURCES = ["owner", "human_node"] as const;
export type RunVerdictSource = (typeof RUN_VERDICT_SOURCES)[number];

export const OWNER_REFUSAL_REASONS = ["wrong_result", "too_costly", "off_brand", "bad_timing", "unsafe", "other"] as const;
export type OwnerRefusalReason = (typeof OWNER_REFUSAL_REASONS)[number];

export function isRunVerdict(value: unknown): value is RunVerdict {
  return typeof value === "string" && (RUN_VERDICTS as readonly string[]).includes(value);
}

export function isOwnerRefusalReason(value: unknown): value is OwnerRefusalReason {
  return typeof value === "string" && (OWNER_REFUSAL_REASONS as readonly string[]).includes(value);
}
