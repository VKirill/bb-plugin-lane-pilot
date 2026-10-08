const LEVELS = ["low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];

export type RetryEffortDecision = {
  enabled: boolean;
  retryIndex: number;
  before: string;
  after: string;
  changed: boolean;
};

/** Raise reasoning on retries, while honoring the model's live supported-level list and a high ceiling. */
export function resolveRetryEffort(input: {
  current: string;
  supportedLevels: ReadonlySet<string>;
  retryIndex: number;
  enabled: boolean;
}): RetryEffortDecision {
  const current = input.current;
  const retryIndex = Number.isInteger(input.retryIndex) && input.retryIndex > 0 ? input.retryIndex : 0;
  if (!input.enabled || retryIndex === 0) {
    return { enabled:input.enabled, retryIndex, before:current, after:current, changed:false };
  }
  const currentIndex = LEVELS.indexOf(current as Level);
  if (currentIndex < 0) return { enabled:true, retryIndex, before:current, after:current, changed:false };

  // `high` is the upstream retry ceiling even when the first attempt requested xhigh.
  const ceiling = LEVELS.indexOf("high");
  const targetIndex = Math.min(ceiling, currentIndex + retryIndex);
  const candidates = LEVELS.slice(0, targetIndex + 1).filter((level) => input.supportedLevels.has(level));
  const after = candidates[candidates.length - 1] ?? current;
  return { enabled:true, retryIndex, before:current, after, changed:after !== current };
}
