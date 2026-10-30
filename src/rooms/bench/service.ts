import { hubFields, writeHubFields } from "../improvement";
import { baselineMetrics } from "./baseline";
import { buildSet, type BuildReport } from "./build";
import { compareArms, computeNoise, noiseOfRepeats, passReport, renderComparison, summarizeArm, type ArmSummary, type Comparison } from "./compare";
import { cohortCounts, cohortOf } from "./stratify";
import { renderStratumMetrics, stratumMetrics, type StratumRow } from "./stratum-metrics";
import { statsEpochMs, STATS_EPOCH_SETTING } from "../storage";
import type { HostPort, PipelinePort } from "./ports";
import { releaseGate, sweepStuckRuns } from "./reliability";
import { BENCH_REPOS_ROOT_ENV } from "./repos";
import { DEFAULT_BUDGET_HOURS, DEFAULT_BUDGET_TOKENS, defaultProjectName, runSeries, type BenchWriter, type SeriesInput, type SeriesReport } from "./runner";
import {
  getSet, latestNoise, listResults, listRuns, listSets, saveNoise, saveVerdict, type BenchDb, type BenchRun, type NoiseRecord,
} from "./store";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

export type BenchDeps = {
  db: BenchDb;
  kv: Kv;
  host: HostPort;
  pipeline: PipelinePort;
  /** Project id -> name, the sandbox test for the candidates. */
  projectNames: () => Promise<ReadonlyMap<string, string>>;
  isSandboxName: (name: string) => boolean;
  log: (line: string) => void;
  /** The jevals trace evals (audit top-10); absent, the runner skips them. */
  jevals?: import("./jevals").JevalsResult extends never ? never : (input: { task: import("./types").ManifestTask; outcome: import("./ports").TaskOutcome; attempts: readonly import("../usage/server").AttemptMetrics[]; reason: string | null }) => Promise<import("./jevals").JevalsResult | null>;
  /** The name of the bench project for a task (default «LP bench <project>»). */
  projectNameFor?: (task: import("./types").ManifestTask) => string;
};

export type BenchSettings = { budgetTokens: number; budgetHours: number };
/** Where a series runs, and the optional same-set repeats. Stored next to the old budget record; empty host means the project's own machine. `reposRoot` remaps stored checkout paths (see repos.ts). */
export type BenchPlacement = { hostId: string | null; noiseRepeats: number; reposRoot: string | null };
const CONFIG_KEY = "bench:config";

function writerOf(run: BenchRun): BenchWriter | null {
  const writer = run.config.writer;
  if (!writer || typeof writer !== "object") return null;
  const row = writer as { providerId?: unknown; model?: unknown };
  return typeof row.providerId === "string" && typeof row.model === "string" ? { providerId: row.providerId, model: row.model } : null;
}
const BUILD_KEY = (version: string) => `bench:build:${version}`;

/** One long job at a time per kind and set/arm: a second `bench run` of the same arm waits for the first to end (it would resume the same rows). */
export function createBench(deps: BenchDeps) {
  const jobs = new Map<string, Promise<unknown>>();

  /** `bench.budget_tokens` / `bench.budget_hours`: the cap of a series, in tokens and hours (owner decision 2026-10-22: a fixed cap, a cheap writer first). */
  async function settings(): Promise<BenchSettings> {
    const stored = await deps.kv.get(CONFIG_KEY).catch(() => null) as Partial<BenchSettings> | null;
    // A global row (`bench.*`, written by the screen and by `bench config`) wins over the old key-value record.
    const own = hubFields(deps.db, "bench") as Partial<BenchSettings>;
    return { budgetTokens: own.budgetTokens ?? stored?.budgetTokens ?? DEFAULT_BUDGET_TOKENS, budgetHours: own.budgetHours ?? stored?.budgetHours ?? DEFAULT_BUDGET_HOURS };
  }
  async function placement(): Promise<BenchPlacement> {
    const stored = await deps.kv.get(CONFIG_KEY).catch(() => null) as Partial<BenchPlacement> | null;
    const hostId = typeof stored?.hostId === "string" && stored.hostId.trim() ? stored.hostId.trim() : null;
    const noise = stored?.noiseRepeats;
    const noiseRepeats = Number.isInteger(noise) && (noise as number) >= 0 && (noise as number) <= 10 ? noise as number : 0;
    const fromEnv = process.env[BENCH_REPOS_ROOT_ENV]?.trim() || null;
    // A stored key wins over the env, so `bench config repos_root=` (empty) clears the root even on a deploy that exports one.
    const reposRoot = stored && "reposRoot" in stored ? (typeof stored.reposRoot === "string" && stored.reposRoot.trim() ? stored.reposRoot.trim() : null) : fromEnv;
    return { hostId, noiseRepeats, reposRoot };
  }
  async function writePlacement(patch: Partial<BenchPlacement>): Promise<void> {
    const prev = await deps.kv.get(CONFIG_KEY).catch(() => null) as Record<string, unknown> | null;
    await deps.kv.set(CONFIG_KEY, { ...(prev ?? {}), ...patch } as never);
  }
  async function configure(patch: Partial<BenchSettings> & Partial<BenchPlacement>): Promise<BenchSettings> {
    const budgets: Partial<BenchSettings> = {};
    if (patch.budgetTokens !== undefined) budgets.budgetTokens = patch.budgetTokens;
    if (patch.budgetHours !== undefined) budgets.budgetHours = patch.budgetHours;
    for (const [key, value] of Object.entries(budgets)) if (!(Number.isFinite(value) && (value as number) > 0)) throw new Error(`${key} must be a positive number`);
    if (Object.keys(budgets).length) {
      // Whole numbers are what the setting holds; the old record kept any positive number.
      writeHubFields(deps.db, "bench", Object.fromEntries(Object.entries(budgets).map(([key, value]) => [key, Math.max(1, Math.round(value as number))])));
    }
    const place: Partial<BenchPlacement> = {};
    if ("hostId" in patch) place.hostId = typeof patch.hostId === "string" && patch.hostId.trim() ? patch.hostId.trim() : null;
    if (patch.noiseRepeats !== undefined) {
      if (!Number.isInteger(patch.noiseRepeats) || patch.noiseRepeats < 0 || patch.noiseRepeats > 10) throw new Error("noiseRepeats must be an integer from 0 to 10");
      place.noiseRepeats = patch.noiseRepeats;
    }
    if ("reposRoot" in patch) place.reposRoot = typeof patch.reposRoot === "string" && patch.reposRoot.trim() ? patch.reposRoot.trim() : null;
    if (Object.keys(place).length) await writePlacement(place);
    return settings();
  }

  function job<T>(key: string, wait: boolean, work: () => Promise<T>): Promise<T | { started: true; job: string }> {
    if (jobs.has(key)) return Promise.reject(new Error(`${key} is already running`));
    const running = work().finally(() => jobs.delete(key));
    jobs.set(key, running);
    if (wait) return running;
    running.catch((cause: unknown) => deps.log(`bench ${key} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    return Promise.resolve({ started: true as const, job: key });
  }

  async function build(input: { version: string; seed?: string; only?: string[]; triesFactor?: number; dryRun?: boolean; planOnly?: boolean; wait?: boolean; minFreeGb?: number; checkTimeoutSec?: number }) {
    return await job(`build:${input.version}`, input.wait ?? false, async () => {
      const place = await placement();
      const epoch = statsEpochMs((deps.db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND key=?").get("*", STATS_EPOCH_SETTING) as { value:string } | undefined)?.value);
      const { report } = await buildSet({
        db: deps.db, host: deps.host, version: input.version, projectNames: await deps.projectNames(), isSandboxName: deps.isSandboxName, log: deps.log,
        ...(input.seed ? { seed: input.seed } : {}), ...(input.only ? { only: input.only } : {}), ...(input.triesFactor ? { triesFactor: input.triesFactor } : {}),
        ...(input.dryRun ? { dryRun: true } : {}), ...(input.planOnly ? { planOnly: true } : {}), ...(input.minFreeGb ? { minFreeGb: input.minFreeGb } : {}), ...(input.checkTimeoutSec ? { checkTimeoutSec: input.checkTimeoutSec } : {}),
        ...(place.reposRoot ? { reposRoot: place.reposRoot } : {}), ...(place.hostId ? { hostId: place.hostId } : {}), statsEpochMs: epoch,
      });
      await deps.kv.set(BUILD_KEY(input.version), report as never).catch(() => undefined);
      return report;
    });
  }

  async function lastBuild(version: string): Promise<BuildReport | null> {
    return await deps.kv.get(BUILD_KEY(version)).catch(() => null) as BuildReport | null;
  }

  function sweep() {
    return sweepStuckRuns(deps.db, Date.now(), { defaultHours: DEFAULT_BUDGET_HOURS });
  }

  async function run(input: Omit<SeriesInput, "budgetTokens" | "budgetHours"> & { repeat?: number; budgetTokens?: number; budgetHours?: number; wait?: boolean; noise?: boolean }) {
    const caps = await settings();
    const place = await placement();
    const repeats = Math.max(1, input.repeat ?? (input.noise && place.noiseRepeats >= 2 ? place.noiseRepeats : 1));
    const hostId = input.hostId ?? place.hostId ?? undefined;
    const reposRoot = input.reposRoot ?? place.reposRoot ?? undefined;
    return await job(`run:${input.version}:${input.arm}`, input.wait ?? false, async () => {
      const closed = sweepStuckRuns(deps.db, Date.now(), { defaultHours: caps.budgetHours, exceptArm: input.arm });
      for (const row of closed) deps.log(`bench-sweep: ${row.id} ${row.arm} ${row.stopReason}`);
      const reports: SeriesReport[] = [];
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const report = await runSeries({ db: deps.db, host: deps.host, pipeline: deps.pipeline, log: deps.log, ...(deps.jevals ? { jevals: deps.jevals } : {}), ...(deps.projectNameFor ? { projectNameFor: deps.projectNameFor } : {}) }, { ...input, repeat, ...(hostId ? { hostId } : {}), ...(reposRoot ? { reposRoot } : {}), budgetTokens: input.budgetTokens ?? caps.budgetTokens, budgetHours: input.budgetHours ?? caps.budgetHours });
        reports.push(report);
        if (report.state === "stopped_budget" || report.state === "failed" || report.state === "deferred" || report.state === "unavailable") break;
      }
      if (input.noise && reports.length >= 2 && reports.every((row) => row.state === "done")) {
        const set = getSet(deps.db, input.version);
        const rows = set ? listRuns(deps.db, set.id).filter((row) => row.arm === input.arm).sort((a, b) => a.repeat - b.repeat) : [];
        const byRepeat = rows.map((row) => listResults(deps.db, row.id));
        const pass = passReport(byRepeat);
        const noise = set ? noiseOfRepeats(input.arm, byRepeat) : null;
        if (set && noise) saveNoise(deps.db, { setId: set.id, armA: `${input.arm}#1`, armB: `${input.arm}#${rows.length}`, noise });
        deps.log(`bench noise ${input.arm}: pass@1 ${(pass.passAt1 * 100).toFixed(0)}% pass^${pass.repeats} ${(pass.passPow * 100).toFixed(0)}% over ${pass.tasks} tasks`);
        for (const report of reports) { report.passAt1 = pass.passAt1; report.passPow = pass.passPow; }
      }
      return reports;
    });
  }

  /** An arm from its stored series (repeats in order). */
  function armSummary(version: string, arm: string): ArmSummary {
    const set = getSet(deps.db, version);
    if (!set) throw new Error(`no bench set ${version}`);
    const runs = listRuns(deps.db, set.id).filter((row) => row.arm === arm).sort((a, b) => a.repeat - b.repeat);
    if (!runs.length) throw new Error(`no series for arm ${arm} on set ${version}; ran: ${[...new Set(listRuns(deps.db, set.id).map((row) => row.arm))].join(", ") || "none"}`);
    // A series that is still running or failed is not a finished measurement, whatever its rows say (a `done` state used to cover errored tasks).
    const unfinished = runs.filter((row) => row.state === "running" || row.state === "failed").map((row) => `repeat ${row.repeat} is ${row.state}${row.stopReason ? ` (${row.stopReason.slice(0, 160)})` : ""}`);
    const summary = summarizeArm(arm, runs.map((row) => listResults(deps.db, row.id)), unfinished);
    const writers = runs.map((row) => writerOf(row));
    const named = writers.filter((row): row is BenchWriter => row !== null);
    const first = named[0];
    const mixed = named.length > 0 && (writers.some((row) => row === null) || named.some((row) => row.providerId !== first!.providerId || row.model !== first!.model));
    if (mixed) summary.incomplete.push("repeats did not share one writer");
    summary.writer = mixed || !first ? null : first;
    return summary;
  }

  /** Two identical arms: the tasks that flipped between them and how far apart cost and time were. The threshold of `compare` is calibrated on the newest one. */
  function noise(input: { version: string; armA: string; armB: string }): NoiseRecord {
    const set = getSet(deps.db, input.version);
    if (!set) throw new Error(`no bench set ${input.version}`);
    const record = computeNoise(armSummary(input.version, input.armA), armSummary(input.version, input.armB));
    return saveNoise(deps.db, { setId: set.id, armA: input.armA, armB: input.armB, noise: record });
  }

  function compare(input: { version: string; armA: string; armB: string; noiseArms?: [string, string]; harnessId?: string }): { comparison: Comparison; text: string; verdictId: string | null } {
    const set = getSet(deps.db, input.version);
    if (!set) throw new Error(`no bench set ${input.version}`);
    const noiseRecord = latestNoise(deps.db, set.id, input.noiseArms);
    const comparison = compareArms(armSummary(input.version, input.armA), armSummary(input.version, input.armB), noiseRecord);
    // Naming a harness tree turns the comparison into the word `harness.adopt_by=bench` waits for.
    // An inconclusive comparison decides nothing: recorded as a pass or as a fail it would adopt or retire a harness tree on too little.
    const verdict = input.harnessId && comparison.verdict !== "inconclusive" ? saveVerdict(deps.db, { setId: set.id, armA: input.armA, armB: input.armB, harnessId: input.harnessId, passed: comparison.verdict === "pass", report: comparison }) : null;
    const rowsOf = (arm: string): StratumRow[] => {
      const runs = listRuns(deps.db, set.id).filter((row) => row.arm === arm);
      const byTask = new Map<string, StratumRow>();
      for (const run of runs) for (const result of listResults(deps.db, run.id)) {
        const task = set.tasks.find((item) => item.taskId === result.taskId);
        if (!task || result.state === "skipped_budget" || result.state === "error") continue;
        byTask.set(result.taskId, { taskId: result.taskId, stratum: task.stratum, accepted: result.accepted, seconds: result.seconds, tokens: result.tokens });
      }
      return [...byTask.values()];
    };
    const armB = listRuns(deps.db, set.id).filter((row) => row.arm === input.armB).at(-1);
    const settings = (armB?.config as { settings?: Record<string, unknown> } | undefined)?.settings;
    const strata = renderStratumMetrics(stratumMetrics(rowsOf(input.armB).length ? rowsOf(input.armB) : rowsOf(input.armA)), settings);
    const text = strata ? `${renderComparison(comparison)}\n${strata}` : renderComparison(comparison);
    return { comparison, text, verdictId: verdict?.id ?? null };
  }

  function status(version?: string) {
    const sets = listSets(deps.db).filter((row) => !version || row.version === version);
    return sets.map((set) => {
      const tasks = getSet(deps.db, set.version)?.tasks ?? [];
      return {
        version: set.version, manifestSha256: set.manifestSha256, tasks: set.taskCount, candidates: set.candidateCount, createdAt: set.createdAt,
        runs: listRuns(deps.db, set.id).map((row) => {
          const results = listResults(deps.db, row.id);
          return { arm: row.arm, repeat: row.repeat, state: row.state, stopReason: row.stopReason, spentTokens: row.spentTokens, tasks: results.length, accepted: results.filter((r) => r.accepted).length, skipped: results.filter((r) => r.state === "skipped_budget").length, cohorts: cohortCounts(tasks, results) };
        }),
      };
    });
  }

  function show(version: string) {
    const set = getSet(deps.db, version);
    if (!set) return null;
    return {
      version: set.version, manifestSha256: set.manifestSha256, candidates: set.candidateCount,
      cohorts: { fixed: set.tasks.filter((task) => cohortOf(task.stratum) === "fixed").length, fresh: set.tasks.filter((task) => cohortOf(task.stratum) === "fresh").length },
      tasks: set.tasks.map((task) => ({
        position: task.position, taskId: task.taskId, project: task.projectName, repo: task.repoPath, stratum: task.stratum, hard: task.hard, risk: task.risk, area: task.area,
        base: task.initialHeadSha.slice(0, 10), solution: task.solutionCommit.slice(0, 10), discriminating: task.warm.discriminating.length, ...(task.validator ? { validator: task.validator } : {}),
      })),
      rejected: set.rejected.length, build: null as BuildReport | null,
    };
  }

  /** The sandbox projects a set needs, with the command that creates each (the plugin cannot create a BB project itself). */
  function prepare(version: string) {
    const set = getSet(deps.db, version);
    if (!set) throw new Error(`no bench set ${version}`);
    const seen = new Map<string, { name: string; hostId: string; repo: string; tasks: number }>();
    for (const task of set.tasks) {
      const name = (deps.projectNameFor ?? defaultProjectName)(task), entry = seen.get(name) ?? { name, hostId: task.hostId, repo: task.repoPath, tasks: 0 };
      entry.tasks++;
      seen.set(name, entry);
    }
    return Promise.all([...seen.values()].map(async (entry) => ({ ...entry, exists: (await deps.pipeline.findProject(entry.name)) !== null, create: `bb project create --name '${entry.name}' --root <empty folder on ${entry.hostId}> --machine ${entry.hostId}` })));
  }

  /** The three model-free numbers of the baseline metric bench (SMA k_lib_bench), over the accepted attempts of the last `days`. */
  const baseline = (opts: { days?: number; projectId?: string } = {}) => baselineMetrics(deps.db, deps.host, opts);

  /** The deploy script asks this. A night that stopped on budget, failed, or never ran is not a pass. */
  function gate(maxAgeHours?: number, now = Date.now()) {
    return releaseGate(listRuns(deps.db), now, maxAgeHours);
  }

  return { settings, placement, configure, build, lastBuild, run, noise, compare, status, show, prepare, armSummary, baseline, sweep, gate };
}

export type BenchApi = ReturnType<typeof createBench>;
