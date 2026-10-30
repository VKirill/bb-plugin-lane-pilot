import packageJson from "../../../../package.json";
import { scheduleIsolated, SCHEDULE_TIMEOUT_CAP_MS, type ServerCore } from "../../core/server";
import { loadProjectSettings } from "../../storage";
import { isSealedVersion } from "../store";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { BenchApi } from "../service";
import { renderBaseline } from "../baseline";
import { nightArm } from "../runner";
import { MEMORY_INJECTION_ARMS, acceptancePerInjectedToken, injectedTokensOf } from "../memory-injection";
import { listResults, listRuns } from "../store";

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
    const newest = sets.filter((set) => !(set as { sealed?: boolean }).sealed).sort((a, b) => b.createdAt - a.createdAt)[0];
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
    await sealedWeek(ctx, bench(), newest.version, arm).catch((cause: unknown) => ctx.log(`bench-weekly sealed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: SCHEDULE_TIMEOUT_CAP_MS });
}

export const SEALED_GAP_SETTING = "bench.sealed_gap_pp";
export const SEALED_GAP_DEFAULT_PP = 15;
const SEALED_GAP_KEY = "bench:sealed_gap";

/**
 * The weekly holdout probe (direction S6): a sealed set is built from the candidates the open strata skipped and run with the
 * week's own arm on the same runner. Its pass share is set against the open set's; a gap wider than `bench.sealed_gap_pp`
 * (default 15 pp) flags a possible fit of the night fixes to the open tasks, and the acceptance gate holds new fixes while it lasts.
 */
async function sealedWeek(ctx: ServerCore, bench: BenchApi, openVersion: string, arm: string): Promise<void> {
  const version = `sealed-${arm}`;
  const existing = bench.status().find((set) => set.version === version);
  if (!existing) {
    const report = await bench.build({ version, only: ["sealed"], wait: true });
    if (report && typeof report === "object" && !Array.isArray(report) && "set" in report && !report.set) { ctx.log(`bench-weekly sealed: nothing qualified for the sealed pool this week`); return; }
  }
  await bench.run({ version, arm, wait: true, hostId: OVH_BENCH_HOST });
  const passOf = (v: string): { ran: number; accepted: number } => {
    const runs = bench.status().find((set) => set.version === v)?.runs.filter((row) => row.arm === arm && row.state === "done") ?? [];
    const ran = runs.reduce((sum, row) => sum + row.tasks - row.skipped, 0);
    const accepted = runs.reduce((sum, row) => sum + row.accepted, 0);
    return { ran, accepted };
  };
  const open = passOf(openVersion), sealed = passOf(version);
  if (!open.ran || !sealed.ran) { ctx.log(`bench-weekly sealed: not enough runs to compare (open ${open.ran}, sealed ${sealed.ran})`); return; }
  const openRate = open.accepted / open.ran, sealedRate = sealed.accepted / sealed.ran;
  const gapPp = Math.round((openRate - sealedRate) * 100);
  const threshold = Number(loadProjectSettings(ctx.db, GLOBAL_SETTINGS_PROJECT_ID)[SEALED_GAP_SETTING] ?? SEALED_GAP_DEFAULT_PP) || SEALED_GAP_DEFAULT_PP;
  const flagged = gapPp > threshold;
  await (ctx.bb.storage.kv as { set?: (key: string, value: unknown) => Promise<void> }).set?.(SEALED_GAP_KEY, { gapPp, thresholdPp: threshold, openRate, sealedRate, openVersion, sealedVersion: version, arm, at: Date.now() }).catch(() => undefined);
  ctx.log(`bench-weekly sealed: ${version} pass ${(sealedRate * 100).toFixed(0)}% vs ${openVersion} ${(openRate * 100).toFixed(0)}% — gap ${gapPp} pp${flagged ? ` > ${threshold}: possible overfit to the open set, new fixes held` : ""}`);
}

/** The OVH machine. A night run always lands here, even when the set's own paths point at the Mac. */
export const OVH_BENCH_HOST = "host_rwrxyi39aw";

/** The full set, on OVH. No task limit. Repeats are chosen by `nightlyRepeats`, not by this object. */
export function nightlyRun(version: string, pluginVersion: string) {
  return { version, arm: nightArm(pluginVersion), wait: true as const, hostId: OVH_BENCH_HOST, noise: true as const };
}

/** Night default is three runs (the arm and two repeats) so the interval has a real spread.
 * A stored `noise_repeats` of 2 or more is that many runs. Weekly does not use this: 0 there stays one run. */
export function nightlyRepeats(noiseRepeats: number): number {
  return noiseRepeats >= 2 ? noiseRepeats : 3;
}

/**
 * Which sets the night runs: every set the status lists (the frozen baseline and every newer one), or the versions
 * `bench.nightly_sets` names as a comma list ("all" and empty mean every set). A version it names that does not
 * exist is logged and skipped.
 */
export function nightlySets(status: ReadonlyArray<{ version: string }>, setting: unknown): string[] {
  // The sealed pool has its own weekly schedule; the night arm never runs it, so the optimizer cannot read its results.
  const all = status.map((set) => set.version).filter((version) => !isSealedVersion(version));
  const raw = String(setting ?? "all").trim();
  if (!raw || raw === "all") return all;
  const wanted = new Set(raw.split(",").map((word) => word.trim()).filter(Boolean));
  return all.filter((version) => wanted.has(version));
}

/** Every day at 01:30 UTC every active set runs as the night arm of this plugin version; the night's token budget is
 * shared evenly between the sets, and a set the budget never reaches is marked `skipped:` so the gate can tell.
 * Per set the strata metrics go to the log and the morning list, one line per stratum.
 * setting bench.nightly = off stops it; bench.nightly_sets = v3,v5 names the sets. Sunday also has the weekly compare. */
export function mountBenchNightly(ctx: ServerCore, bench: () => BenchApi): void {
  scheduleIsolated(ctx.bb, "bench-nightly", "30 1 * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const globalSettings = loadProjectSettings(ctx.db, GLOBAL_SETTINGS_PROJECT_ID);
    if (String(globalSettings["bench.nightly"] ?? "on") === "off") return;
    const sets = nightlySets(bench().status().sort((a, b) => b.createdAt - a.createdAt), globalSettings["bench.nightly_sets"]);
    if (!sets.length) return;
    const repeat = nightlyRepeats((await bench().placement()).noiseRepeats);
    const caps = await bench().settings();
    const share = Math.floor(caps.budgetTokens / sets.length);
    const arm = nightArm(packageJson.version);
    ctx.log(`bench-nightly: ${arm} on ${OVH_BENCH_HOST}, ${sets.length} set(s) ${sets.join(", ")}, ${repeat} runs each, ${share} tokens a set`);
    let budgetSpent = false;
    for (const version of sets) {
      const input = nightlyRun(version, packageJson.version);
      if (budgetSpent) {
        bench().markSkipped(version, arm, `skipped: the night's shared token budget ended on an earlier set`);
        continue;
      }
      const reports = await bench().run({ ...input, repeat, budgetTokens: share });
      const rows = Array.isArray(reports) ? reports : [reports];
      for (const line of await bench().armStrata(version, arm)) ctx.log(`bench-nightly ${version}: ${line}`);
      // arXiv #18: one memory-on repeat of the same set (a bounded probe at a quarter of the set's budget), the acceptance
      // delta priced per 1k injected tokens in the night's summary lines — the data that decides whether injection earns.
      const memArm = `${arm}-mem`;
      const ran = await bench().run({ ...input, arm: memArm, settings: { ...MEMORY_INJECTION_ARMS.on }, repeat: 1, budgetTokens: Math.max(1, Math.floor(share / 4)) }).catch((cause: unknown) => { ctx.log(`bench-nightly ${version}: memory arm failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (ran) {
        const off = listRuns(ctx.db, version).filter((row) => row.arm === arm).flatMap((row) => listResults(ctx.db, row.id));
        const on = listRuns(ctx.db, version).filter((row) => row.arm === memArm).flatMap((row) => listResults(ctx.db, row.id));
        const tokens = on.reduce((sum, row) => sum + (row.lpRunId ? injectedTokensOf(ctx.db, row.lpRunId) : 0), 0);
        const ab = acceptancePerInjectedToken(on, off, tokens);
        ctx.log(`bench-nightly ${version} memory A/B: ${on.length} on / ${off.length} off, accepted-delta ${ab.delta.toFixed(2)}, ${ab.perKiloToken === null ? "no injected tokens priced" : `${ab.perKiloToken.toFixed(3)} per 1k injected`}`);
      }
      if (rows.some((row) => row && typeof row === "object" && "state" in row && (row.state === "stopped_budget" || row.state === "failed"))) budgetSpent = true;
    }
  }, { timeoutMs: SCHEDULE_TIMEOUT_CAP_MS });
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
