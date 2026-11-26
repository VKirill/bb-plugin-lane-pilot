export const PM_TURN_LIMIT_MIN_DEFAULT = 0;
export const PM_MAX_TURNS_DEFAULT = 0;
export const PM_TURN_OUTCOME_PREFIX = "pm-turn:outcome:";

export type PmTurnEndedEvent = {
  threadId: string;
  reason: "completed" | "failed" | "timeout" | "max_turns";
  outcome: string | null;
  providerError?: string | null;
  startedAt: number;
  endedAt: number;
};
