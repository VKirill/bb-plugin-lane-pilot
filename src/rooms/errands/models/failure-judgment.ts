/**
 * The errands' own closed set of failure classes of an episode, wider than `failure.class`'s six: it names what an
 * errand can lack (a skill, access, a clear brief) and how the run itself misbehaved (looped, stopped early, never
 * verified, timed out, a tool error).
 */
export const ERRAND_FAILURE_CLASSES = [
  "no_skill", "skill_not_used", "no_access", "site_changed", "unclear_brief", "ignored_constraint",
  "looped", "stopped_early", "unverified", "timeout", "tool_error", "other",
] as const;
export type ErrandFailureClass = (typeof ERRAND_FAILURE_CLASSES)[number];
