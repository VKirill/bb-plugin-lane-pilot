import { loadCandidates } from "./candidates";
import type { HostPort } from "./ports";
import { chooseFinal, DEFAULT_STRATA, freshStratum, interleave, noncodeStratum, smallStratum, warmOrder, type Stratum } from "./stratify";
import { insertSet, type BenchDb, type BenchSet } from "./store";
import type { Candidate, ManifestTask, Rejection } from "./types";
import { MIN_FREE_GB, freeGb, warmUp, type WarmOptions } from "./warmup";

export type BuildInput = {
  db: BenchDb;
  host: HostPort;
  version: string;
  seed?: string;
  strata?: readonly Stratum[];
  projectNames: ReadonlyMap<string, string>;
  isSandboxName: (name: string) => boolean;
  projects?: readonly import("./types").BenchProject[];
  hostFor?: (path: string) => string | null;
  /** Warm-up attempts per stratum as a multiple of its quota (the rest of the candidates stay untried). */
  triesFactor?: number;
  /** A host with less free space than this (GB) is not touched. */
  minFreeGb?: number;
  scratch?: string;
  /** Cap on a single check during warm-up. */
  checkTimeoutSec?: number;
  /** Plan and warm up but write nothing. */
  dryRun?: boolean;
  /** Only count the candidates per stratum (no clone, no check run). */
  planOnly?: boolean;
  /** Warm-up on these strata only (a partial build is never written). */
  only?: readonly string[];
  log?: (line: string) => void;
  /** Remap stored checkout paths and, with hostId, warm up on that machine (OVH) instead of the path's own. */
  reposRoot?: string | null;
  hostId?: string;
  /** Clock for the fresh window. Absent: the time of the build. */
  now?: number;
  freshWindowMs?: number;
  /** stats.epoch floor: tasks accepted before it are not counted as fresh (owner 2026-10-30). */
  statsEpochMs?: number;
};

export type StratumReport = { key: string; quota: number; candidates: number; hardCandidates: number; tried: number; survived: number; kept: number; keptHard: number; rejected: Record<string, number>; stoppedBecause: string };
export type BuildReport = {
  version: string; candidates: number; prefilter: Record<string, number>; strata: StratumReport[];
  tried: number; survived: number; survivalRate: number | null; kept: number; keptHard: number; hardShare: number | null;
  risks: Record<string, number>; set: BenchSet | null; note: string;
  /** The first warm-up rejections with their detail (the full list is stored with the set). */
  rejectedSample: Rejection[];
};

/** The strata a build walks. `small` and `noncode` join only when `--only` names them, so a full build stays the frozen mix. */
export function strataFor(input: { strata?: readonly Stratum[]; only?: readonly string[]; now?: number; freshWindowMs?: number; statsEpochMs?: number }): Stratum[] {
  const only = input.only;
  const extras = !input.strata ? [...(only?.includes("small") ? [smallStratum()] : []), ...(only?.includes("noncode") ? [noncodeStratum()] : [])] : [];
  const requested = input.strata ?? [...DEFAULT_STRATA, ...extras, freshStratum(input.now ?? Date.now(), input.freshWindowMs, undefined, input.statsEpochMs ?? 0)];
  return requested.filter((stratum) => !only || only.includes(stratum.key));
}

export async function buildSet(input: BuildInput): Promise<{ report: BuildReport; tasks: ManifestTask[]; rejected: Rejection[] }> {
  const log = input.log ?? (() => undefined);
  const seed = input.seed ?? input.version;
  const now = input.now ?? Date.now();
  const requested = strataFor({ ...(input.strata ? { strata: input.strata } : {}), ...(input.only ? { only: input.only } : {}), now, ...(input.freshWindowMs ? { freshWindowMs: input.freshWindowMs } : {}), ...(input.statsEpochMs ? { statsEpochMs: input.statsEpochMs } : {}) });
  const strata = requested.filter((stratum) => !input.only || input.only.includes(stratum.key));
  const fixedStrata = strata.filter((stratum) => stratum.key !== "fresh");
  const fresh = strata.find((stratum) => stratum.key === "fresh");
  const loaded = loadCandidates(input.db, { projectNames: input.projectNames, isSandboxName: input.isSandboxName, ...(input.projects ? { projects: input.projects } : {}), ...(input.hostFor ? { hostFor: input.hostFor } : {}) });
  const rejected: Rejection[] = [...loaded.rejected];
  const scratch = input.scratch ?? "$HOME/lp-bench/warm";
  const warmOptions: WarmOptions = { scratch, ...(input.checkTimeoutSec ? { checkTimeoutSec: input.checkTimeoutSec } : {}) };
  const homes = new Map<string, string>();
  /** `$HOME/...` written for any machine, expanded on the one that runs the warm-up (a quoted `$HOME` is not expanded by the shell). */
  const scratchOn = async (hostId: string): Promise<string> => {
    if (!scratch.startsWith("$HOME")) return scratch;
    if (!homes.has(hostId)) homes.set(hostId, (await input.host.run(hostId, "/", "printf %s \"$HOME\"", 15).catch(() => ({ stdout: "" }))).stdout.trim() || "/tmp");
    return scratch.replace("$HOME", homes.get(hostId)!);
  };
  const minFree = input.minFreeGb ?? MIN_FREE_GB;
  const factor = input.triesFactor ?? 4;

  type Kept = { candidate: Candidate; stratum: string; solutionCommit: string; patchSha256: string; warm: ManifestTask["warm"] };
  const reports = new Map<string, StratumReport>();
  const keptByStratum = new Map<string, Kept[]>();

  // One chain per host: two warm-ups never run on one machine at once (the disk and the CPU are the owner's); different machines go side by side.
  const claimed = new Set<string>();
  /** Candidates a fixed stratum already warmed; a fresh retry of the same warm-up fails the same way and burns the quota. */
  const warmed = new Set<string>();
  const byStratum = fixedStrata.map((stratum) => {
    const pool = loaded.candidates.filter((candidate) => stratum.match(candidate) && !claimed.has(candidate.taskId));
    pool.forEach((candidate) => claimed.add(candidate.taskId));
    return { stratum, pool };
  });
  const hostOf = (pool: Candidate[]) => pool[0]?.hostId ?? "none";
  const chains = new Map<string, typeof byStratum>();
  for (const entry of byStratum) chains.set(hostOf(entry.pool), [...(chains.get(hostOf(entry.pool)) ?? []), entry]);

  // A host that stops answering (a plugin reload, a machine gone) would turn every remaining candidate into a host error and freeze a
  // stunted set: three in a row stop that host's chain, and the build writes nothing.
  const HOST_ERRORS_IN_A_ROW = 3;
  const lostHosts: string[] = [];
  await Promise.all([...chains.entries()].map(async ([hostId, entries]) => {
    let hostErrors = 0;
    for (const { stratum, pool } of entries) {
      const report: StratumReport = { key: stratum.key, quota: stratum.quota, candidates: pool.length, hardCandidates: pool.filter((c) => c.hard).length, tried: 0, survived: 0, kept: 0, keptHard: 0, rejected: {}, stoppedBecause: "" };
      reports.set(stratum.key, report);
      const survivors: Kept[] = [];
      const need = Math.ceil(stratum.quota * 0.3);
      const order = warmOrder(pool, seed);
      const maxTries = Math.max(stratum.quota, Math.round(stratum.quota * factor));
      for (const candidate of input.planOnly ? [] : order) {
        const enough = survivors.length >= stratum.quota && survivors.filter((s) => s.candidate.hard).length >= Math.min(need, pool.filter((c) => c.hard).length);
        if (enough) { report.stoppedBecause = "quota filled"; break; }
        if (lostHosts.includes(hostId)) { report.stoppedBecause = `host ${hostId} stopped answering`; break; }
        if (report.tried >= maxTries) { report.stoppedBecause = `tried ${maxTries} candidates`; break; }
        const touch = input.hostId ?? hostId;
        const free = touch === "none" ? null : await freeGb(input.host, touch);
        if (free !== null && free < minFree) { report.stoppedBecause = `host ${touch} has ${free} GB free, below ${minFree}`; log(`bench build: ${report.stoppedBecause}`); break; }
        report.tried++;
        warmed.add(candidate.taskId);
        const started = Date.now();
        const result = await warmUp(input.host, candidate, { ...warmOptions, scratch: await scratchOn(input.hostId ?? hostId), ...(input.reposRoot ? { reposRoot: input.reposRoot } : {}), ...(input.hostId ? { hostId: input.hostId } : {}) }).catch((cause: unknown) => ({ ok: false as const, reason: "host_error" as const, detail: cause instanceof Error ? cause.message : String(cause) }));
        hostErrors = !result.ok && result.reason === "host_error" ? hostErrors + 1 : 0;
        if (result.ok) {
          report.survived++;
          survivors.push({ candidate, stratum: stratum.key, solutionCommit: result.solutionCommit, patchSha256: result.patchSha256, warm: result.record });
          log(`bench build: ${stratum.key} ${candidate.taskId} warm in ${Math.round((Date.now() - started) / 1000)}s (${result.record.discriminating.length} discriminating checks)`);
        } else {
          report.rejected[result.reason] = (report.rejected[result.reason] ?? 0) + 1;
          rejected.push({ taskId: candidate.taskId, stratum: stratum.key, reason: result.reason, ...(result.detail ? { detail: result.detail.slice(0, 300) } : {}) });
          log(`bench build: ${stratum.key} ${candidate.taskId} rejected: ${result.reason}`);
          if (hostErrors >= HOST_ERRORS_IN_A_ROW) {
            lostHosts.push(hostId);
            report.stoppedBecause = `host ${hostId} stopped answering (${HOST_ERRORS_IN_A_ROW} host errors in a row; last: ${(result.detail ?? "").slice(0, 160)})`;
            log(`bench build: ${report.stoppedBecause}`);
            break;
          }
        }
      }
      if (!report.stoppedBecause) report.stoppedBecause = "candidates exhausted";
      const chosen = chooseFinal(survivors.map((s) => s.candidate), stratum.quota, seed);
      const keep = survivors.filter((s) => chosen.includes(s.candidate));
      keptByStratum.set(stratum.key, keep);
      report.kept = keep.length;
      report.keptHard = keep.filter((s) => s.candidate.hard).length;
    }
  }));

  // Fresh is beside the fixed quotas, not instead of them: a task the fixed strata kept stays fixed. The rest of the recent live tasks fill `fresh`.
  if (fresh && !lostHosts.length) {
    const keptIds = new Set([...keptByStratum.values()].flat().map((row) => row.candidate.taskId));
    // Out: what a fixed stratum kept, and what it already tried — the same warm-up would fail again. In: what matched but was never warmed.
    const pool = loaded.candidates.filter((candidate) => fresh.match(candidate) && !keptIds.has(candidate.taskId) && !warmed.has(candidate.taskId));
    const report: StratumReport = { key: fresh.key, quota: fresh.quota, candidates: pool.length, hardCandidates: pool.filter((c) => c.hard).length, tried: 0, survived: 0, kept: 0, keptHard: 0, rejected: {}, stoppedBecause: "" };
    reports.set(fresh.key, report);
    const survivors: Kept[] = [];
    const order = warmOrder(pool, seed);
    const maxTries = Math.max(fresh.quota, Math.round(fresh.quota * factor));
    for (const candidate of input.planOnly ? [] : order) {
      if (survivors.length >= fresh.quota) { report.stoppedBecause = "quota filled"; break; }
      if (report.tried >= maxTries) { report.stoppedBecause = `tried ${maxTries} candidates`; break; }
      const touch = input.hostId ?? candidate.hostId;
      const free = touch === "none" ? null : await freeGb(input.host, touch);
      if (free !== null && free < minFree) { report.stoppedBecause = `host ${touch} has ${free} GB free, below ${minFree}`; break; }
      report.tried++;
      const result = await warmUp(input.host, candidate, { ...warmOptions, scratch: await scratchOn(touch), ...(input.reposRoot ? { reposRoot: input.reposRoot } : {}), ...(input.hostId ? { hostId: input.hostId } : {}) }).catch((cause: unknown) => ({ ok: false as const, reason: "host_error" as const, detail: cause instanceof Error ? cause.message : String(cause) }));
      if (result.ok) {
        report.survived++;
        survivors.push({ candidate, stratum: fresh.key, solutionCommit: result.solutionCommit, patchSha256: result.patchSha256, warm: result.record });
      } else {
        report.rejected[result.reason] = (report.rejected[result.reason] ?? 0) + 1;
        rejected.push({ taskId: candidate.taskId, stratum: fresh.key, reason: result.reason, ...(result.detail ? { detail: result.detail.slice(0, 300) } : {}) });
        if (result.reason === "host_error") { report.stoppedBecause = `host ${candidate.hostId} stopped answering`; break; }
      }
    }
    if (!report.stoppedBecause) report.stoppedBecause = "candidates exhausted";
    const chosen = chooseFinal(survivors.map((row) => row.candidate), fresh.quota, seed);
    const keep = survivors.filter((row) => chosen.includes(row.candidate));
    keptByStratum.set(fresh.key, keep);
    report.kept = keep.length;
    report.keptHard = keep.filter((row) => row.candidate.hard).length;
  }

  const kept = strata.flatMap((stratum) => keptByStratum.get(stratum.key) ?? []);
  const ordered = interleave(kept.map((entry) => ({ ...entry, stratum: entry.stratum })), strata.map((stratum) => stratum.key));
  const tasks: ManifestTask[] = ordered.map((entry, index) => ({
    taskId: entry.candidate.taskId, position: index + 1, projectId: entry.candidate.projectId, projectName: entry.candidate.projectName, hostId: entry.candidate.hostId, repoPath: entry.candidate.repoPath,
    stratum: entry.stratum, hard: entry.candidate.hard, risk: entry.candidate.risk, area: entry.candidate.area, initialHeadSha: entry.candidate.initialHeadSha,
    solutionCommit: entry.solutionCommit, solutionPatchSha256: entry.patchSha256, contract: entry.candidate.contract, warm: entry.warm,
  }));
  const tried = [...reports.values()].reduce((sum, row) => sum + row.tried, 0), survived = [...reports.values()].reduce((sum, row) => sum + row.survived, 0);
  const risks: Record<string, number> = {};
  for (const task of tasks) risks[task.risk] = (risks[task.risk] ?? 0) + 1;
  let set: BenchSet | null = null;
  let note = "";
  if (input.planOnly) note = "plan only: candidates counted, nothing warmed up or written";
  else if (input.dryRun) note = "dry run: nothing written";
  else if (lostHosts.length) note = `host ${lostHosts.join(", ")} stopped answering during the warm-up: nothing written; run the build again`;
  else if (!tasks.length) note = "no task survived the warm-up: nothing written";
  else if (input.only) note = `partial set: strata ${input.only.join(", ")} only; the other strata are not in this version`;
  if (!input.dryRun && !input.planOnly && !lostHosts.length && tasks.length) set = insertSet(input.db, { version: input.version, tasks, rejected, candidateCount: loaded.candidates.length, config: { seed, triesFactor: factor, strata: strata.map((s) => ({ key: s.key, quota: s.quota })) } });
  const keptHard = tasks.filter((task) => task.hard).length;
  return {
    tasks, rejected,
    report: {
      version: input.version, candidates: loaded.candidates.length, prefilter: loaded.counts, strata: strata.map((stratum) => reports.get(stratum.key)!).filter(Boolean),
      tried, survived, survivalRate: tried ? survived / tried : null, kept: tasks.length, keptHard, hardShare: tasks.length ? keptHard / tasks.length : null, risks, set, note,
      rejectedSample: rejected.filter((row) => row.stratum).slice(0, 12),
    },
  };
}
