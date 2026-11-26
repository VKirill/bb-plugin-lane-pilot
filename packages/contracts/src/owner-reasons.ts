/** The four reasons an owner inbox item may be posted: a decision only they make, work that cannot go on, something red, or a term that ends. */
export const OWNER_REASONS = ["decision", "blocked", "red", "term"] as const;
export type OwnerReason = (typeof OWNER_REASONS)[number];

export function isOwnerReason(value: unknown): value is OwnerReason {
  return typeof value === "string" && (OWNER_REASONS as readonly string[]).includes(value);
}
