import { scheduleIsolated, type ServerCore } from "../../core/server";
import { loadProjectSettings } from "../../storage";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { BenchApi } from "../service";

/**
 * The comparison arena on a clock (SMA map: Comparison arena, Baseline metric bench). Every Sunday at 02:00 UTC the newest bench set runs
 * once as this week's arm (within bench.budget_tokens / bench.budget_hours) and is compared with last week's arm; the comparison is kept
 * and the PM-free text goes to the log and the morning list. setting bench.weekly = off stops it.
 */
export const weekArm = (now: number) => {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((now - start) / 86_400_000 + new Date(start).getUTCDay() + 1) / 7);
  return `week-${date.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
};

export function mountBenchWeekly(ctx: ServerCore, bench: () => BenchApi): void {
  scheduleIsolated(ctx.bb, "bench-weekly", "0 2 * * 0", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    if (String(loadProjectSettings(ctx.db, GLOBAL_SETTINGS_PROJECT_ID)["bench.weekly"] ?? "on") === "off") return;
    const sets = bench().status();
    const newest = sets.sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!newest) return;
    const now = Date.now();
    const arm = weekArm(now), previous = weekArm(now - 7 * 86_400_000);
    await bench().run({ version: newest.version, arm, wait: true });
    if (newest.runs.some((row) => row.arm === previous)) {
      const result = bench().compare({ version: newest.version, armA: previous, armB: arm });
      ctx.log(`bench-weekly: ${newest.version} ${previous} → ${arm}: ${result.comparison.verdict}; ${result.text.split("\n")[0]}`);
    }
  }, { timeoutMs: 6 * 3_600_000 });
}
