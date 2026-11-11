/** One status-line segment (SMA k_lib_statusline): a pure function over cached usage windows — never the whole
 * line, never a file or the clock. `windows` is the cache as readUsageWindows/boardWindows return it, `at` its
 * timestamp, `now` injected so the staleness mark is testable; a cache without a time is not marked. Empty when there is nothing to show. */
export function usageSegment(
  windows: Record<string, { utilization: number; resetsAt: string | null }> | null | undefined,
  at: string | null,
  now: number,
): string {
  if (!windows) return "";
  const pct = (key: string): string | null => {
    const row = windows[key];
    return row && typeof row.utilization === "number" ? `${Math.round(row.utilization)}%` : null;
  };
  const parts = [
    ["5h", pct("five_hour") ?? pct("5h")],
    ["7d", pct("seven_day") ?? pct("7d")],
    ["opus", pct("seven_day_opus") ?? pct("opus")],
    ["1d", pct("one_day")],
  ].flatMap(([label, value]) => (value ? [`${label} ${value}`] : []));
  // Windows under names nobody mapped still count: a cache with data is never silent.
  if (!parts.length) {
    const other = Object.entries(windows).flatMap(([key, row]) => (typeof row?.utilization === "number" ? [`${key} ${Math.round(row.utilization)}%`] : []));
    parts.push(...other);
  }
  if (!parts.length) return "";
  // The mark comes from the reading's own time; a reading with no time gets no mark rather than a wrong one.
  const stale = Boolean(at) && Number.isFinite(Date.parse(at!)) && now - Date.parse(at!) > 2 * 3_600_000;
  return `${stale ? "⚠ " : ""}${parts.join(" - ")}`;
}
