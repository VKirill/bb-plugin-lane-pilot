import packageJson from "../../../../package.json";
import { scheduleIsolated, type ServerCore } from "../../core/server";
import { loadProjectSettings } from "../../storage";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { BenchApi } from "../service";
import { renderBaseline } from "../baseline";
import { nightArm } from "../runner";

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
    // The baseline metric bench needs no model and no set: its three numbers are measured every week (SMA k_lib_bench).
    const base = await bench().baseline({ days: 7 }).catch((cause: unknown) => { ctx.log(`bench-weekly: baseline failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
    if (base) ctx.log(`bench-weekly: ${renderBaseline(base).replace(/\n/g, "; ")}`);
    const sets = bench().status();
    const newest = sets.sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!newest) return;
    const now = Date.now();
    const arm = weekArm(now), previous = weekArm(now - 7 * 86_400_000);
    // noise: the same set again when bench config noise_repeats is 2 or more. 0 keeps one run.
    await bench().run({ version: newest.version, arm, wait: true, noise: true });
    if (newest.runs.some((row) => row.arm === previous)) {
      try {
        const result = bench().compare({ version: newest.version, armA: previous, armB: arm });
        const ci = result.text.split("\n").find((line) => line.startsWith("Pass rate")) ?? "";
        ctx.log(`bench-weekly: ${newest.version} ${previous} → ${arm}: ${result.comparison.verdict}; ${result.text.split("\n")[0]}${ci ? `; ${ci}` : ""}`);
      } catch (cause) {
        ctx.log(`bench-weekly: compare skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }, { timeoutMs: 6 * 3_600_000 });
}

/** The OVH machine. A night run always lands here, even when the set's own paths point at the Mac. */
export const OVH_BENCH_HOST = "host_rwrxyi39aw";

/** The full set, on OVH, with the configured noise repeats. No task limit. */
export function nightlyRun(version: string, pluginVersion: string) {
  return { version, arm: nightArm(pluginVersion), wait: true as const, hostId: OVH_BENCH_HOST, noise: true as const };
}

/** Every day at 01:30 UTC the newest set runs as the night arm of this plugin version. setting bench.nightly = off stops it.
 * Sunday also has the weekly compare at 02:00; the two arms are different and this one does not wait for that one. */
export function mountBenchNightly(ctx: ServerCore, bench: () => BenchApi): void {
  scheduleIsolated(ctx.bb, "bench-nightly", "30 1 * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    if (String(loadProjectSettings(ctx.db, GLOBAL_SETTINGS_PROJECT_ID)["bench.nightly"] ?? "on") === "off") return;
    const newest = bench().status().sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!newest) return;
    const input = nightlyRun(newest.version, packageJson.version);
    ctx.log(`bench-nightly: ${input.version} ${input.arm} on ${input.hostId}`);
    await bench().run(input);
  }, { timeoutMs: 8 * 3_600_000 });
}

/** Closes a series left `running` past its hour cap. Once at startup, then twice an hour. */
export function mountBenchSweep(ctx: ServerCore, bench: () => BenchApi): void {
  const sweep = async () => {
    if (ctx.isDisposed()) return;
    const closed = bench().sweep();
    for (const row of closed) ctx.log(`bench-sweep: ${row.id} ${row.arm} ${row.stopReason}`);
  };
  void sweep();
  scheduleIsolated(ctx.bb, "bench-sweep", "17,47 * * * *", sweep, { timeoutMs: 60_000 });
}
