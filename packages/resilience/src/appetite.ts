/**
 * The task's appetite (SMA «Appetite before solution»): the most a task may spend, written in its contract before the work starts
 * (`appetite: {tokens?, minutes?}`). A writer past it is stopped like a run over its budget, with the same reason prefix, so the failure
 * class (`run_budget_exceeded:`) and the restart rules treat both alike; the reason names the appetite and the numbers.
 */
export type Appetite = { tokens?: number | undefined; minutes?: number | undefined };

/**
 * The stop reason when the writer has run longer than the appetite's minutes, else null. The appetite's tokens are a forecast, never a stop
 * (owner, 2026-10-28): writers were stopped mid-work four times in two weeks, once on a 6,000-token appetite the PM had written.
 */
export function appetiteStop(appetite: Appetite | undefined, used: { tokens: number | null; elapsedMs: number }): string | null {
  if (!appetite) return null;
  const minutes = Math.floor(used.elapsedMs / 60_000);
  if (appetite.minutes !== undefined && used.elapsedMs > appetite.minutes * 60_000) return `run_budget_exceeded:appetite minutes ${minutes} > ${appetite.minutes}`;
  return null;
}
