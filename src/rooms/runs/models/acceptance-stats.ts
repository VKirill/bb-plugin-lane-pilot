export type AcceptanceWeek = {
  /** ISO week, keyed by the task's first attempt. */
  week: string;
  /** Tasks with at least one attempt in the week. */
  dispatched: number;
  /** Of them, accepted on their first attempt. */
  firstTryAccepted: number;
  /** Of them, accepted by any attempt. */
  eventuallyAccepted: number;
  /** All attempts of the week's tasks. */
  attempts: number;
  /** Attempts per accepted task (all attempts of accepted tasks). */
  attemptsPerAccepted: number | null;
  /** Tasks sent again: id is `<stem>.N`. */
  redispatched: number;
  /** Distinct stems behind the redispatched tasks. */
  families: number;
  /** Failed attempts by coarse cause. */
  causes: Record<string, number>;
  /** Attempts parked `waiting_writer:` (H2) / all closed attempts; null when there are none. */
  heldShare: number | null;
};

export type AcceptanceTotals = Omit<AcceptanceWeek, "week">;
export type AcceptanceProject = { projectId: string; totals: AcceptanceTotals; weeks: AcceptanceWeek[] };
export type AcceptanceStats = { days: number; totals: AcceptanceTotals; projects: AcceptanceProject[] };
