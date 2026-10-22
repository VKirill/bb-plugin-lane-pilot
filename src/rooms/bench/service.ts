import { hubFields, writeHubFields } from "../improvement";
import { buildSet, type BuildReport } from "./build";
import { compareArms, computeNoise, renderComparison, summarizeArm, type ArmSummary, type Comparison } from "./compare";
import type { HostPort, PipelinePort } from "./ports";
import { DEFAULT_BUDGET_HOURS, DEFAULT_BUDGET_TOKENS, defaultProjectName, runSeries, type SeriesInput, type SeriesReport } from "./runner";
import {
  getSet, latestNoise, listResults, listRuns, listSets, saveNoise, saveVerdict, type BenchDb, type NoiseRecord,
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
  /** The name of the bench project for a task (default «LP bench <project>»). */
  projectNameFor?: (task: import("./types").ManifestTask) => string;
};

export type BenchSettings = { budgetTokens: number; budgetHours: number };
const CONFIG_KEY = "bench:config";
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
  async function configure(patch: Partial<BenchSettings>): Promise<BenchSettings> {
    for (const [key, value] of Object.entries(patch)) if (value !== undefined && !(Number.isFinite(value) && value > 0)) throw new Error(`${key} must be a positive number`);
    const next = { ...(await settings()), ...patch };
    // Whole numbers are what the setting holds; the old record kept any positive number.
    writeHubFields(deps.db, "bench", Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Math.max(1, Math.round(value as number))])));
    return { ...next, ...(await settings()) };
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
      const { report } = await buildSet({
        db: deps.db, host: deps.host, version: input.version, projectNames: await deps.projectNames(), isSandboxName: deps.isSandboxName, log: deps.log,
        ...(input.seed ? { seed: input.seed } : {}), ...(input.only ? { only: input.only } : {}), ...(input.triesFactor ? { triesFactor: input.triesFactor } : {}),
        ...(input.dryRun ? { dryRun: true } : {}), ...(input.planOnly ? { planOnly: true } : {}), ...(input.minFreeGb ? { minFreeGb: input.minFreeGb } : {}), ...(input.checkTimeoutSec ? { checkTimeoutSec: input.checkTimeoutSec } : {}),
      });
      await deps.kv.set(BUILD_KEY(input.version), report as never).catch(() => undefined);
      return report;
    });
  }

  async function lastBuild(version: string): Promise<BuildReport | null> {
    return await deps.kv.get(BUILD_KEY(version)).catch(() => null) as BuildReport | null;
  }

  async function run(input: Omit<SeriesInput, "budgetTokens" | "budgetHours"> & { repeat?: number; budgetTokens?: number; budgetHours?: number; wait?: boolean }) {
    const caps = await settings();
    const repeats = Math.max(1, input.repeat ?? 1);
    return await job(`run:${input.version}:${input.arm}`, input.wait ?? false, async () => {
      const reports: SeriesReport[] = [];
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const report = await runSeries({ db: deps.db, host: deps.host, pipeline: deps.pipeline, log: deps.log, ...(deps.projectNameFor ? { projectNameFor: deps.projectNameFor } : {}) }, { ...input, repeat, budgetTokens: input.budgetTokens ?? caps.budgetTokens, budgetHours: input.budgetHours ?? caps.budgetHours });
        reports.push(report);
        if (report.state === "stopped_budget" || report.state === "failed") break;
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
    return summarizeArm(arm, runs.map((row) => listResults(deps.db, row.id)));
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
    const verdict = input.harnessId ? saveVerdict(deps.db, { setId: set.id, armA: input.armA, armB: input.armB, harnessId: input.harnessId, passed: comparison.verdict === "pass", report: comparison }) : null;
    return { comparison, text: renderComparison(comparison), verdictId: verdict?.id ?? null };
  }

  function status(version?: string) {
    const sets = listSets(deps.db).filter((row) => !version || row.version === version);
    return sets.map((set) => ({
      version: set.version, manifestSha256: set.manifestSha256, tasks: set.taskCount, candidates: set.candidateCount, createdAt: set.createdAt,
      runs: listRuns(deps.db, set.id).map((row) => {
        const results = listResults(deps.db, row.id);
        return { arm: row.arm, repeat: row.repeat, state: row.state, stopReason: row.stopReason, spentTokens: row.spentTokens, tasks: results.length, accepted: results.filter((r) => r.accepted).length, skipped: results.filter((r) => r.state === "skipped_budget").length };
      }),
    }));
  }

  function show(version: string) {
    const set = getSet(deps.db, version);
    if (!set) return null;
    return {
      version: set.version, manifestSha256: set.manifestSha256, candidates: set.candidateCount, tasks: set.tasks.map((task) => ({
        position: task.position, taskId: task.taskId, project: task.projectName, repo: task.repoPath, stratum: task.stratum, hard: task.hard, risk: task.risk, area: task.area,
        base: task.initialHeadSha.slice(0, 10), solution: task.solutionCommit.slice(0, 10), discriminating: task.warm.discriminating.length,
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

  return { settings, configure, build, lastBuild, run, noise, compare, status, show, prepare, armSummary };
}

export type BenchApi = ReturnType<typeof createBench>;
