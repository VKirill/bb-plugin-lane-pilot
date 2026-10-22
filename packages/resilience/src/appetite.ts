/**
 * The task's appetite (SMA «Appetite before solution»): the most a task may spend, written in its contract before the work starts
 * (`appetite: {tokens?, minutes?}`). A writer past it is stopped like a run over its budget, with the same reason prefix, so the failure
 * class (`run_budget_exceeded:`) and the restart rules treat both alike; the reason names the appetite and the numbers.
 */
export type Appetite = { tokens?: number | undefined; minutes?: number | undefined };

/** The stop reason when the writer has spent more than the appetite, else null. `tokens` null: the provider reported no usage yet. */
export function appetiteStop(appetite: Appetite | undefined, used: { tokens: number | null; elapsedMs: number }): string | null {
  if (!appetite) return null;
  if (appetite.tokens !== undefined && used.tokens !== null && used.tokens > appetite.tokens) return `run_budget_exceeded:appetite tokens ${used.tokens} > ${appetite.tokens}`;
  const minutes = Math.floor(used.elapsedMs / 60_000);
  if (appetite.minutes !== undefined && used.elapsedMs > appetite.minutes * 60_000) return `run_budget_exceeded:appetite minutes ${minutes} > ${appetite.minutes}`;
  return null;
}
