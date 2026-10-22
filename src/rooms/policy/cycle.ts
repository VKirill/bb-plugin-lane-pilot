/**
 * Stop rule of the night loop (RHI, arXiv 2607.15524, applied in sma-gap-analysis.md section 4.1 item 3): the loop ends when the bench shows
 * no improvement two cycles in a row. A cycle improves when its bench score beats the best score before it by more than `epsilon`.
 * `history` is the bench score after each cycle, oldest first, the first entry being the starting point (the incumbent before any cycle);
 * a number is a score, higher is better (share of bench tasks passed, win rate against the predecessor).
 */
export type CycleScore = number | { score: number };

export type StopOptions = { epsilon?: number; patience?: number };

const scoreOf = (entry: CycleScore): number => (typeof entry === "number" ? entry : entry.score);

export function shouldStopCycle(history: readonly CycleScore[], options: StopOptions = {}): boolean {
  const patience = options.patience ?? 2;
  const epsilon = options.epsilon ?? 0;
  const scores = history.map(scoreOf);
  if (scores.some((score) => !Number.isFinite(score))) throw new Error("a cycle score must be a finite number");
  // The starting point plus `patience` cycles: fewer entries cannot show `patience` cycles without improvement.
  if (scores.length <= patience) return false;
  let best = scores[0]!;
  let stale = 0;
  for (const score of scores.slice(1)) {
    if (score > best + epsilon) { best = score; stale = 0; } else stale++;
  }
  return stale >= patience;
}
