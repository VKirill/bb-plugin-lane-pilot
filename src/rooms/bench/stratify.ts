import { sha256, type Candidate, type Risk } from "./types";

/** One slice of the set. `quota` is how many tasks the set takes from it; `minHardShare` of them must be «hard» (accepted after a retry). */
export type Stratum = { key: string; quota: number; match: (candidate: Candidate) => boolean };

const SELFY = "proj_acpiaqf4wq", BB = "proj_ejbam66722", CAKE = "proj_a35nni238u";
const area = (candidate: Candidate, prefix: string) => candidate.area.startsWith(prefix);

/** ~30 tasks (SMA plan P0-1): 10 SelfyStudio pages, 8 features, 2 other SelfyStudio, 6 BB-сервис, 4 cakekeeper. */
export const DEFAULT_STRATA: readonly Stratum[] = [
  { key: "selfystudio-page", quota: 10, match: (c) => c.projectId === SELFY && area(c, "page:") },
  { key: "selfystudio-feature", quota: 8, match: (c) => c.projectId === SELFY && area(c, "feature:") },
  { key: "selfystudio-other", quota: 2, match: (c) => c.projectId === SELFY && !area(c, "page:") && !area(c, "feature:") },
  { key: "bb-service", quota: 6, match: (c) => c.projectId === BB },
  { key: "cakekeeper", quota: 4, match: (c) => c.projectId === CAKE },
];

export const MIN_HARD_SHARE = 0.3;

/** Recently accepted tasks, reported apart from the frozen strata. A fixed set goes stale (SWE-rebench); this one does not replace it. */
export const FRESH_WINDOW_MS = 14 * 86_400_000;
export const FRESH_QUOTA = 8;

/** Live projects only: `loadCandidates` has already dropped sandboxes, drills and folders the owner did not allow. */
export function freshStratum(now: number, windowMs = FRESH_WINDOW_MS, quota = FRESH_QUOTA, floor = 0): Stratum {
  const since = Math.max(now - windowMs, floor);
  return { key: "fresh", quota, match: (candidate) => (candidate.acceptedAt ?? 0) >= since };
}

export function cohortOf(stratum: string): "fixed" | "fresh" {
  return stratum === "fresh" ? "fresh" : "fixed";
}

export type CohortCounts = { tasks: number; accepted: number };

/** Judged tasks of one run, split by stratum. A task is counted once. */
export function cohortCounts(tasks: readonly { taskId: string; stratum: string }[], results: readonly { taskId: string; accepted: boolean; state: string }[]): { fixed: CohortCounts; fresh: CohortCounts } {
  const kind = new Map(tasks.map((task) => [task.taskId, cohortOf(task.stratum)]));
  const out = { fixed: { tasks: 0, accepted: 0 }, fresh: { tasks: 0, accepted: 0 } };
  const seen = new Set<string>();
  for (const row of results) {
    if (row.state === "skipped_budget" || row.state === "error") continue;
    if (seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    const bucket = out[kind.get(row.taskId) ?? "fixed"];
    bucket.tasks++;
    if (row.accepted) bucket.accepted++;
  }
  return out;
}
const RISKS: readonly Risk[] = ["low", "medium", "high", "critical"];

/** Fixed order for the same seed: a hash, not a random number, so a rebuild picks the same candidates. */
const rank = (seed: string, candidate: Candidate) => sha256(`${seed}:${candidate.taskId}`);

/** Candidates of a stratum in the order the warm-up tries them: hard and easy interleaved (4 in 10 hard), risks rotated inside each group. */
export function warmOrder(candidates: readonly Candidate[], seed: string): Candidate[] {
  const rotate = (list: Candidate[]): Candidate[] => {
    const buckets = new Map<Risk, Candidate[]>();
    for (const risk of RISKS) buckets.set(risk, list.filter((c) => c.risk === risk).sort((a, b) => rank(seed, a).localeCompare(rank(seed, b))));
    const out: Candidate[] = [];
    while ([...buckets.values()].some((bucket) => bucket.length)) for (const risk of RISKS) { const next = buckets.get(risk)!.shift(); if (next) out.push(next); }
    return out;
  };
  const hard = rotate(candidates.filter((c) => c.hard)), easy = rotate(candidates.filter((c) => !c.hard));
  const out: Candidate[] = [];
  let h = 0, e = 0;
  for (let slot = 0; h < hard.length || e < easy.length; slot++) {
    const wantHard = slot % 10 < 4;
    if ((wantHard && h < hard.length) || e >= easy.length) out.push(hard[h++]!); else out.push(easy[e++]!);
  }
  return out;
}

/**
 * The tasks a stratum keeps out of those that survived the warm-up: at least `minHardShare` hard when it has them, the risks
 * rotated (low, medium, high, critical), then by the seed hash. Returns fewer than `quota` when fewer survived.
 */
export function chooseFinal<T extends Candidate>(survivors: readonly T[], quota: number, seed: string, minHardShare = MIN_HARD_SHARE): T[] {
  const need = Math.min(quota, Math.ceil(quota * minHardShare));
  const pick = (pool: T[], count: number): T[] => {
    const buckets = new Map<Risk, T[]>();
    for (const risk of RISKS) buckets.set(risk, pool.filter((c) => c.risk === risk).sort((a, b) => rank(seed, a).localeCompare(rank(seed, b))));
    const out: T[] = [];
    while (out.length < count && [...buckets.values()].some((bucket) => bucket.length)) for (const risk of RISKS) { const next = buckets.get(risk)!.shift(); if (next && out.length < count) out.push(next); }
    return out;
  };
  const hard = pick(survivors.filter((c) => c.hard), need);
  const taken = new Set(hard.map((c) => c.taskId));
  const rest = pick(survivors.filter((c) => !taken.has(c.taskId)), quota - hard.length);
  return [...hard, ...rest];
}

/** The order tasks run in: strata interleaved, so the first N of a set are a mix and not N pages. */
export function interleave<T extends { stratum: string }>(tasks: readonly T[], strataOrder: readonly string[]): T[] {
  const lanes = strataOrder.map((key) => tasks.filter((task) => task.stratum === key));
  const out: T[] = [];
  while (lanes.some((lane) => lane.length)) for (const lane of lanes) { const next = lane.shift(); if (next) out.push(next); }
  return out;
}
