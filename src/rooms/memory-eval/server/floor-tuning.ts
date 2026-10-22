import { clearsFloor, memoryContext, questionWords, recordRelevance, searchMemoryRecords, wordFrequencies, type MemoryRecord, type RecordRelevance, type RelevanceFloor } from "@lane-pilot/memory-core";
import { buildEvalDb, planCorpus, type EvalScope } from "./corpus";
import type { EvalQuestion } from "./questions";
import type { EvalData } from "./source";

/**
 * Choosing the relevance floor of the query paths without grading it on the questions it was chosen on. The questions are split in two
 * by a hash of their task (the same task is on the same side at every corpus size): the floor is chosen on the TUNING half and the
 * numbers that are reported as the result are the HELD-OUT half. The rule that picks a floor is fixed before looking at any number:
 * the lowest false-hit rate on the tuning half among the floors that lose at most `MAX_HIT_LOSS` of hit@5 there, on both query paths.
 *
 * Every question is asked twice: as the whole task text a dispatch searches with (title, objective, acceptance), and as its title alone,
 * the short question a person or an agent types into the terminal or the PM tool.
 */
export const MAX_HIT_LOSS = 0.05;
const CONTEXT_BUDGET = 2500;
const SEARCH_LIMIT = 100;
const K = 5;

/**
 * The thresholds tried, in two stages that each see only the tuning half. Stage 1 sets the weight a record must reach for a long question
 * (0.25 to 4; a shared word weighs 0.1 to 1) on the full task text. Stage 2 sets, with that fixed, the weight for a short question on the
 * titles, so a five-word question is not starved by a threshold a whole task text needs. The two lengths are where the questions themselves part: the 90th percentile of the titles (12 distinct words) and the 10th percentile of the full texts (17); the threshold moves in a straight line between. The
 * path anchor stays on.
 */
const LENGTHS = { shortWords: 12, longWords: 17, anchor: true } as const;
export const LONG_GRID: RelevanceFloor[] = Array.from({ length: 16 }, (_, index) => ({ minScore: 0.25 * (index + 1), minScoreShort: 0.25 * (index + 1), ...LENGTHS }));
export const shortGrid = (minScore: number): RelevanceFloor[] => Array.from({ length: 12 }, (_, index) => ({ minScore, minScoreShort: Math.min(minScore, 0.25 * index), ...LENGTHS }));

/** The PM tool and the council rank the records again within the context budget (`memoryContext`); the terminal's search hands over the fused ranking as it is. */
export type Path = "pm" | "search";
export const PATHS: readonly Path[] = ["pm", "search"];
export type Variant = "full" | "title";
export const VARIANTS: readonly Variant[] = ["full", "title"];
export type Half = "tune" | "held";
export const halfOf = (question: Pick<EvalQuestion, "taskId" | "id">): Half => {
  let hash = 2166136261;
  for (const char of question.taskId || question.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash >>> 7) % 2 === 0 ? "tune" : "held";
};

export type Counts = { positives: number; hits: number; nothings: number; falseAny: number; falseNonCore: number };
const empty = (): Counts => ({ positives: 0, hits: 0, nothings: 0, falseAny: 0, falseNonCore: 0 });
const add = (into: Counts, from: Counts) => { for (const key of Object.keys(into) as Array<keyof Counts>) into[key] += from[key]; };
export const rates = (counts: Counts) => ({ hit: counts.positives ? counts.hits / counts.positives : 0, falseAny: counts.nothings ? counts.falseAny / counts.nothings : 0, falseNonCore: counts.nothings ? counts.falseNonCore / counts.nothings : 0 });

type Observation = { question: EvalQuestion; variant: Variant; query: string; words: number; half: Half; records: MemoryRecord[]; relevance: Map<string, RecordRelevance>; gold: Set<string>; memo: Map<string, string[]> };
type Size = { size: number; observations: Observation[]; kinds: Map<string, "core" | "note"> };

type Cell = Record<Path, Record<Variant, Record<Half, Counts>>>;
export type CandidateResult = { floor: RelevanceFloor | null; bySize: Map<number, Cell> };
export type FloorTuning = {
  seed: number; baseline: CandidateResult; chosen: CandidateResult;
  /** Stage 1 (the weight, full task text) and stage 2 (the short-question rule, title only): the tuning-half frontier of each, floors no other floor beats on both hit and false hit. */
  stages: Array<{ variant: Variant; frontier: CandidateResult[]; chosen: CandidateResult }>;
  sizes: number[]; questions: Record<Half, { positive: number; nothing: number }>;
};

const emptyCell = (): Cell => Object.fromEntries(PATHS.map((path) => [path, Object.fromEntries(VARIANTS.map((variant) => [variant, { tune: empty(), held: empty() }]))])) as Cell;

function evaluate(sizes: readonly Size[], floor: RelevanceFloor | null): CandidateResult {
  const bySize = new Map<number, Cell>();
  for (const size of sizes) {
    const cell = emptyCell();
    for (const obs of size.observations) {
      const kept = floor ? obs.records.filter((record) => clearsFloor(obs.relevance.get(record.id)!, floor, obs.words)) : obs.records;
      const key = kept.map((record) => record.id).join(",");
      let packed = obs.memo.get(key);
      if (!packed) { packed = memoryContext(kept, obs.query, CONTEXT_BUDGET).records.map((record) => record.id); obs.memo.set(key, packed); }
      for (const path of PATHS) {
        const delivered = (path === "pm" ? packed : kept.map((record) => record.id)).slice(0, K);
        const counts = cell[path][obs.variant][obs.half];
        if (obs.question.kind === "positive") { counts.positives++; if (delivered.some((id) => obs.gold.has(id))) counts.hits++; }
        else { counts.nothings++; if (delivered.length) counts.falseAny++; if (delivered.some((id) => size.kinds.get(id) !== "core")) counts.falseNonCore++; }
      }
    }
    bySize.set(size.size, cell);
  }
  return { floor, bySize };
}

/** Counts summed over the sizes, and over the question forms unless one is asked for. */
export const pooled = (result: CandidateResult, half: Half, path: Path = "pm", variant?: Variant): Counts => {
  const out = empty();
  for (const cell of result.bySize.values()) for (const form of variant ? [variant] : VARIANTS) add(out, cell[path][form][half]);
  return out;
};

export async function tuneFloor(data: EvalData, options: { sizes?: readonly number[]; seed?: number; scope?: EvalScope; skipProjects: ReadonlySet<string>; skipTask: (taskId: string) => boolean; now?: number }): Promise<FloorTuning> {
  const seed = options.seed ?? 1;
  const sizes: Size[] = [];
  for (const size of options.sizes ?? [30, 300, 3000]) {
    const plan = planCorpus({ data, size, seed, scope: options.scope ?? "project", skipProjects: options.skipProjects, skipTask: options.skipTask, ...(options.now !== undefined ? { now: options.now } : {}) });
    const db = buildEvalDb(plan);
    try {
      const times = plan.notes.map((note) => [note.id, note.createdAt] as const);
      const observations: Observation[] = [];
      for (const question of plan.questions) {
        const excluded = new Set(times.filter(([, at]) => at >= question.startedAt).map(([id]) => id));
        for (const variant of VARIANTS) {
          const query = variant === "full" ? question.query : question.text.title;
          const records = searchMemoryRecords(db, question.scope, query, SEARCH_LIMIT, "auto", "subagent", "").filter((record) => !excluded.has(record.id));
          const relevance = recordRelevance(wordFrequencies(db, question.scope, "subagent", ""), query, records);
          observations.push({ question, variant, query, words: questionWords(query), half: halfOf(question), records, relevance, gold: new Set(question.gold), memo: new Map() });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      sizes.push({ size, observations, kinds: new Map(plan.notes.map((note) => [note.id, note.kind])) });
    } finally { db.close(); }
  }
  const baseline = evaluate(sizes, null);
  const stage = (grid: RelevanceFloor[], variant: Variant) => {
    const candidates = grid.map((floor) => evaluate(sizes, floor));
    const tuned = (result: CandidateResult, path: Path = "pm") => rates(pooled(result, "tune", path, variant));
    const allowed = candidates.filter((candidate) => PATHS.every((path) => tuned(candidate, path).hit >= tuned(baseline, path).hit - MAX_HIT_LOSS));
    // Fewest false hits; then the higher hit rate; then the first in grid order (the lowest threshold, the simplest rule).
    const chosen = [...allowed].sort((a, b) => tuned(a).falseAny - tuned(b).falseAny || tuned(b).hit - tuned(a).hit)[0] ?? baseline;
    const better = (a: CandidateResult, b: CandidateResult) => tuned(a).hit >= tuned(b).hit && tuned(a).falseAny <= tuned(b).falseAny && (tuned(a).hit > tuned(b).hit || tuned(a).falseAny < tuned(b).falseAny);
    const seen = new Set<string>();
    const frontier = candidates.filter((candidate) => !candidates.some((other) => better(other, candidate)))
      .filter((candidate) => { const key = `${tuned(candidate).hit}|${tuned(candidate).falseAny}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((a, b) => tuned(b).hit - tuned(a).hit);
    return { variant, frontier, chosen };
  };
  const first = stage(LONG_GRID, "full");
  const second = stage(shortGrid(first.chosen.floor?.minScore ?? LONG_GRID[0]!.minScore), "title");
  const count = (half: Half) => ({ positive: pooled(baseline, half, "pm", "full").positives, nothing: pooled(baseline, half, "pm", "full").nothings });
  return { seed, baseline, chosen: second.chosen, stages: [first, second], sizes: sizes.map((size) => size.size), questions: { tune: count("tune"), held: count("held") } };
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
export const describeFloor = (floor: RelevanceFloor | null) => !floor ? "no floor"
  : `weight >= ${floor.minScoreShort === floor.minScore ? floor.minScore : `${floor.minScoreShort} (title) .. ${floor.minScore} (task text)`}${floor.anchor ? ", or names a path of the question" : ""}`;

export function formatFloorTuning(result: FloorTuning): string {
  const lines = [`memory-eval floor seed=${result.seed}; questions are split by task: tuning ${result.questions.tune.positive} positive + ${result.questions.tune.nothing} nothing, held-out ${result.questions.held.positive} positive + ${result.questions.held.nothing} nothing (per question form, pooled over sizes ${result.sizes.join("/")}; each asked as the full task text and as its title alone)`, ""];
  for (const [index, stage] of result.stages.entries()) {
    const base = rates(pooled(result.baseline, "tune", "pm", stage.variant));
    lines.push(`Stage ${index + 1}, trade-off curve on the TUNING half, ${stage.variant === "full" ? "full task text" : "title only"}, PM path (floors no other floor beats; without a floor: hit@5 ${pct(base.hit)}, false hit ${pct(base.falseAny)}):`, "  hit@5   false-hit  non-core   search hit@5  floor");
    for (const candidate of stage.frontier) { const r = rates(pooled(candidate, "tune", "pm", stage.variant)); lines.push(`  ${pct(r.hit).padEnd(7)} ${pct(r.falseAny).padEnd(10)} ${pct(r.falseNonCore).padEnd(10)} ${pct(rates(pooled(candidate, "tune", "search", stage.variant)).hit).padEnd(13)} ${describeFloor(candidate.floor)}${candidate === stage.chosen ? "   <- chosen" : ""}`); }
    lines.push("");
  }
  lines.push(`Chosen on the tuning half (lowest false hit within ${MAX_HIT_LOSS * 100} points of hit@5 on both paths): ${describeFloor(result.chosen.floor)}`);
  for (const path of PATHS) for (const variant of VARIANTS) {
    lines.push("", `${path === "pm" ? "PM tool / council" : "terminal search"}, ${variant === "full" ? "full task text" : "title only"}:`, "size  half      positives  hit@5 old -> new   nothing-questions  false hit old -> new  non-core old -> new");
    const row = (label: string, half: Half, before: Counts, after: Counts) => {
      const b = rates(before), a = rates(after);
      lines.push(`${label.padEnd(5)} ${(half === "held" ? "HELD-OUT" : "tuning").padEnd(9)} ${String(before.positives).padEnd(10)} ${`${pct(b.hit)} -> ${pct(a.hit)}`.padEnd(18)} ${String(before.nothings).padEnd(18)} ${`${pct(b.falseAny)} -> ${pct(a.falseAny)}`.padEnd(21)} ${pct(b.falseNonCore)} -> ${pct(a.falseNonCore)}`);
    };
    for (const half of ["held", "tune"] as const) {
      for (const size of result.sizes) row(String(size), half, result.baseline.bySize.get(size)![path][variant][half], result.chosen.bySize.get(size)![path][variant][half]);
      row("all", half, pooled(result.baseline, half, path, variant), pooled(result.chosen, half, path, variant));
    }
  }
  return lines.join("\n");
}
