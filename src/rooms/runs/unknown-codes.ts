/**
 * The unknown code register (SMA: Unknown code register): failure reasons no class or rule names yet. Each is a gap in the failure
 * dictionary; the night loop and the PM read the register, and a reason that keeps coming gets its own pattern.
 */
const KNOWN = [
  /^verification failed/, /^owns_paths rejected/, /plan_fact_unproven/, /^contract lint/, /^verdict_block/, /^validation/, /^drawing_changed/,
  /^run_budget_exceeded/, /provider|limit|quota|rate/i, /^merge_|conflict/, /^needs_human|NEEDS_HUMAN/, /^turn limit/, /^writer_silent|no answer|returned no/,
  /^spawn_/, /^reconcile_/, /timeout/i, /^canceled|cancel/, /^wall_stop|repeated_failure/, /environment|sandbox|exit 127/, /^dirty base|dirty_base/,
  /^task_in_progress/, /^spend_reserve/, /^check_not_runnable/, /^clarify_open/,
];
export const isKnownReason = (reason: string) => KNOWN.some((pattern) => pattern.test(reason));

/** Distinct unknown reasons with their counts and the latest time, most frequent first. */
export function unknownReasons(rows: ReadonlyArray<{ reason: string | null; at: number }>): Array<{ reason: string; count: number; lastAt: number }> {
  const by = new Map<string, { reason: string; count: number; lastAt: number }>();
  for (const row of rows) {
    const reason = (row.reason ?? "").trim();
    if (!reason || isKnownReason(reason)) continue;
    const key = reason.replace(/\d+/g, "#").slice(0, 160);
    const entry = by.get(key) ?? { reason: reason.slice(0, 300), count: 0, lastAt: 0 };
    entry.count += 1; entry.lastAt = Math.max(entry.lastAt, row.at);
    by.set(key, entry);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}
