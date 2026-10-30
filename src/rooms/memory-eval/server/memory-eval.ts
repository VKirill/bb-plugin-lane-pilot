import { buildEvalDb, planCorpus, prng, type EvalScope, type SizePlan } from "./corpus";
import { createRetrievers, type Retriever } from "./retrievers";
import type { EvalQuestion } from "./questions";
import type { EvalData } from "./source";

/**
 * The memory evaluation (SMA block 4 «Next», P2-7): does retrieval find what a task needs, and does it say nothing when nothing is
 * relevant, at 30, 300 and 3,000 notes? It builds a corpus of each size from the notes the hub really holds (padded with changed copies
 * of real notes where the hub has fewer), asks it the questions real accepted tasks pose, and scores what each delivery path would
 * hand over against the notes that task's accepted solution really touched. The same questions go to a plain baseline (a path match and
 * a count of uncommon words) so the claim «plain retrieval you can explain beats clever retrieval» is tested at one person's size.
 */
export type Stat = { mean: number; lo: number; hi: number; n: number };
export type RetrieverScore = {
  id: string; production: boolean; group: string; k: number;
  /** Positive questions. */
  hit: Stat; precision: Stat; recall: Stat;
  /** Delivered notes that are not gold but name a folder of the solution. */
  nearby: Stat;
  /** Questions whose right answer is nothing: how often anything was delivered at all, and how often something other than core. */
  falseHit: Stat; falseHitNonCore: Stat; offtopicFalseHit: Stat; poisonHit: Stat;
  /** Mean notes delivered for a question. */
  delivered: number;
  latencyMs: { p50: number; p95: number };
};
export type SizeReport = {
  size: number; notes: number; composition: SizePlan["composition"];
  questions: { positive: number; negative: number; offtopic: number; goldPerPositive: number };
  scores: RetrieverScore[];
  /** Paired difference plain minus production on the same questions (positive: plain better). */
  versus: Array<{ plain: string; production: string; metric: "hit" | "falseHit"; diff: Stat }>;
  /** M7: share of delivered notes from a foreign (non-ancestor, non-shared) section, per production retriever. */
  foreign: Record<string, Stat>;
};
export type EvalReport = { seed: number; scope: EvalScope; origin: string; at: number; sizes: SizeReport[]; caveats: string[] };

const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

/** Mean and a 95 % bootstrap interval; the questions are the sample. */
export function stat(values: readonly number[], seed = 1): Stat {
  if (!values.length) return { mean: 0, lo: 0, hi: 0, n: 0 };
  const random = prng(seed);
  const means: number[] = [];
  for (let round = 0; round < 400; round++) {
    let sum = 0;
    for (let index = 0; index < values.length; index++) sum += values[Math.floor(random() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(values), lo: means[Math.floor(means.length * 0.025)]!, hi: means[Math.floor(means.length * 0.975)]!, n: values.length };
}
const quantile = (values: number[], share: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))]! : 0;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Row = { question: EvalQuestion; ids: string[]; ms: number };

/** Scores one retriever on one corpus. Pure over the rows, so the scoring is testable without a database. */
export function score(retriever: Pick<Retriever, "id" | "production" | "group" | "k">, rows: readonly Row[], kindOf: (id: string) => "core" | "note", seed = 1, poisonOf: (id: string) => boolean = () => false): RetrieverScore {
  const positives = rows.filter((row) => row.question.kind === "positive");
  const nothing = rows.filter((row) => row.question.kind !== "positive");
  const cut = (row: Row) => row.ids.slice(0, retriever.k);
  const perPositive = positives.map((row) => {
    const delivered = cut(row), gold = new Set(row.question.gold), area = new Set(row.question.area);
    const good = delivered.filter((id) => gold.has(id)).length;
    return {
      hit: good > 0 ? 1 : 0, precision: delivered.length ? good / delivered.length : 0, recall: good / Math.min(retriever.k, gold.size),
      nearby: delivered.length ? delivered.filter((id) => area.has(id)).length / delivered.length : 0,
    };
  });
  const falseOf = (selected: readonly Row[], nonCore: boolean) => selected.map((row) => cut(row).filter((id) => !nonCore || kindOf(id) !== "core").length > 0 ? 1 : 0);
  return {
    id: retriever.id, production: retriever.production, group: retriever.group, k: retriever.k,
    hit: stat(perPositive.map((item) => item.hit), seed), precision: stat(perPositive.map((item) => item.precision), seed), recall: stat(perPositive.map((item) => item.recall), seed),
    nearby: stat(perPositive.map((item) => item.nearby), seed),
    falseHit: stat(falseOf(nothing, false), seed), falseHitNonCore: stat(falseOf(nothing, true), seed),
    // A poisoned twin in the top-k is a delivered wrong fact on the question's own subject (audit #27).
    poisonHit: stat(positives.map((row) => cut(row).some((id) => poisonOf(id)) ? 1 : 0), seed),
    offtopicFalseHit: stat(falseOf(rows.filter((row) => row.question.kind === "offtopic"), false), seed),
    delivered: mean(rows.map((row) => cut(row).length)),
    latencyMs: { p50: quantile(rows.map((row) => row.ms), 0.5), p95: quantile(rows.map((row) => row.ms), 0.95) },
  };
}

import { DEFAULT_RELEVANCE_FLOOR, type RelevanceFloor } from "@lane-pilot/memory-core";
export type RunOptions = { /** The floor of the query paths; `null` runs them as they were before it. */ floor?: RelevanceFloor | null; sizes?: readonly number[]; seed?: number; scope?: EvalScope; skipProjects: ReadonlySet<string>; skipTask: (taskId: string) => boolean; now?: number };

export async function runMemoryEval(data: EvalData, options: RunOptions): Promise<EvalReport> {
  const seed = options.seed ?? 1;
  const sizes: SizeReport[] = [];
  for (const size of options.sizes ?? [30, 300, 3000]) {
    const plan = planCorpus({ data, size, seed, scope: options.scope ?? "project", skipProjects: options.skipProjects, skipTask: options.skipTask, ...(options.now !== undefined ? { now: options.now } : {}) });
    const db = buildEvalDb(plan);
    try {
      const retrievers = createRetrievers(db, plan.notes, options.now, options.floor === undefined ? DEFAULT_RELEVANCE_FLOOR : options.floor);
      const kinds = new Map(plan.notes.map((note) => [note.id, note.kind]));
      const times = plan.notes.map((note) => [note.id, note.createdAt] as const);
      const rowsBy = new Map<string, Row[]>(retrievers.map((retriever) => [retriever.id, []]));
      for (const question of plan.questions) {
        // The notes written after the task started did not exist for it.
        const excluded = new Set(times.filter(([, at]) => at >= question.startedAt).map(([id]) => id));
        for (const retriever of retrievers) {
          const started = performance.now();
          const out = retriever.run(question, excluded);
          rowsBy.get(retriever.id)!.push({ question, ids: out.ids, ms: performance.now() - started });
        }
        await tick();
      }
      const kindOf = (id: string) => kinds.get(id) ?? "note";
      const poisonIds = new Set(plan.notes.filter((note) => note.poison).map((note) => note.id));
      const scores = retrievers.map((retriever) => score(retriever, rowsBy.get(retriever.id)!, kindOf, seed, (id) => poisonIds.has(id)));
      const paired = (plainId: string, productionId: string, metric: "hit" | "falseHit") => {
        const solid = (id: string) => kindOf(id) !== "core";
        const plain = rowsBy.get(plainId)!, production = rowsBy.get(productionId)!;
        const pick = (rows: Row[], k: number) => rows.map((row) => {
          const delivered = row.ids.slice(0, k);
          return row.question.kind === "positive" ? (metric === "hit" ? (delivered.some((id) => new Set(row.question.gold).has(id)) ? 1 : 0) : null)
            : (metric === "falseHit" ? (delivered.some(solid) ? 1 : 0) : null);
        });
        const a = pick(plain, retrievers.find((item) => item.id === plainId)!.k), b = pick(production, retrievers.find((item) => item.id === productionId)!.k);
        const diffs = a.flatMap((value, index) => value === null || b[index] === null ? [] : [value - (b[index] as number)]);
        return { plain: plainId, production: productionId, metric, diff: stat(diffs, seed) };
      };
      // M7: share of delivered notes that live in a section outside the question's chain and are not marked project-wide.
      const scopeOf = new Map<string, string[]>();
      for (const row of db.prepare("SELECT id, scope_json FROM lane_pilot_memory").all() as Array<{ id: string; scope_json: string | null }>)
        scopeOf.set(row.id, row.scope_json ? (JSON.parse(row.scope_json) as string[]) : []);
      const foreign = Object.fromEntries(retrievers.filter((retriever) => retriever.production).map((retriever) => [retriever.id, stat(rowsBy.get(retriever.id)!.flatMap((row) => {
        if (!row.ids.length) return [];
        const chain = row.question.chain ?? [];
        const foreignCount = row.ids.filter((id) => {
          const scope = scopeOf.get(id) ?? [];
          const shared = scope.some((entry) => /^project(:|$)/.test(entry));
          return !shared && scope.length && !(scope.length <= chain.length && scope.every((entry, index) => chain[index] === entry));
        }).length;
        return [foreignCount / row.ids.length];
      }), seed)]));
      const positives = plan.questions.filter((question) => question.kind === "positive");
      sizes.push({
        size, notes: plan.notes.length, composition: plan.composition,
        questions: { positive: positives.length, negative: plan.questions.filter((question) => question.kind === "negative").length,
          offtopic: plan.questions.filter((question) => question.kind === "offtopic").length, goldPerPositive: mean(positives.map((question) => question.gold.length)) },
        scores, foreign,
        versus: [paired("plain", "writer", "hit"), paired("plain", "writer", "falseHit"), paired("plain-keyword", "pm", "hit"), paired("plain-keyword", "pm", "falseHit")],
      });
    } finally { db.close(); }
  }
  return {
    seed, scope: options.scope ?? "project", origin: data.origin, at: options.now ?? Date.now(), sizes,
    caveats: [
      "Gold is the set of earlier notes that name a file the accepted solution produced: a lower bound (a note can help without naming a file), so precision is a floor and «nearby» shows delivered notes that name the same folder.",
      "A negative question is a real task no earlier note names a file or folder of; a delivered note there is a false hit, a core convention is reported apart (it is handed to every task by design).",
      "Notes written after a task started are hidden from it after the search, so a note can crowd the top 100 of the search that the task never had; the use and acceptance counters start at zero for every note.",
      "A corpus above what the hub holds is padded with copies of real notes whose first path folders are renamed: they read like the project and name no file anyone touched.",
    ],
  };
}

const pct = (value: Stat) => `${(value.mean * 100).toFixed(0)}% [${(value.lo * 100).toFixed(0)}-${(value.hi * 100).toFixed(0)}]`;

/** The report as a table a person can read. */
export function formatEvalReport(report: EvalReport): string {
  const lines = [`memory-eval seed=${report.seed} scope=${report.scope} data=${report.origin}`];
  for (const size of report.sizes) {
    const c = size.composition;
    lines.push("", `== ${size.size} notes (${size.notes}: ${c.gold} gold, ${c.fill} real filler, ${c.synthetic} padding, ${c.core} core; the largest ${report.scope === "pile" ? "pile" : "project"} holds ${c.pool}) · ${size.questions.positive} positive, ${size.questions.negative} negative, ${size.questions.offtopic} off-topic questions · ${size.questions.goldPerPositive.toFixed(1)} gold notes per positive ==`);
    lines.push("retriever        k  hit@k          precision      recall         nearby   false-hit(any) false-hit(non-core) off-topic   poison   delivered  p50/p95 ms");
    for (const row of size.scores) {
      lines.push(`${(row.production ? row.id : row.id.startsWith("plain") ? `${row.id} (plain)` : `${row.id} (diag)`).padEnd(16)} ${row.k}  ${pct(row.hit).padEnd(14)} ${pct(row.precision).padEnd(14)} ${pct(row.recall).padEnd(14)} ${pct(row.nearby).padEnd(8)} ${pct(row.falseHit).padEnd(14)} ${pct(row.falseHitNonCore).padEnd(19)} ${pct(row.offtopicFalseHit).padEnd(11)} ${pct(row.poisonHit).padEnd(9)} ${row.delivered.toFixed(1).padEnd(10)} ${row.latencyMs.p50.toFixed(1)}/${row.latencyMs.p95.toFixed(1)}`);
    }
    for (const [id, share] of Object.entries(size.foreign)) lines.push(`  ${id} foreign-section share: ${(share.mean * 100).toFixed(0)}% over ${share.n} questions`);
    for (const item of size.versus) lines.push(`  ${item.plain} minus ${item.production}, ${item.metric}: ${item.diff.mean >= 0 ? "+" : ""}${(item.diff.mean * 100).toFixed(0)} points [${(item.diff.lo * 100).toFixed(0)}, ${(item.diff.hi * 100).toFixed(0)}] over ${item.diff.n} questions`);
  }
  lines.push("", ...report.caveats.map((item) => `- ${item}`));
  return lines.join("\n");
}
