/** A spawn receipt's «the spawn was attempted» mark, written by the claimer and read back on recovery (qa, critique). */
export function spawnClaimed(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { spawnAttempted?: unknown }).spawnAttempted === true);
}
