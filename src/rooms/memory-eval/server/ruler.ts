import Database from "better-sqlite3";
import { memoryJudgeStats, parseMemorySettings, queryVectorFor, type MemorySettings } from "@lane-pilot/memory-core";
import type { LanePilotDatabase } from "../../storage";
import { currentEmbedder, currentMemoryJudge, explicitMemorySearch, setEmbedder, setMemoryJudge, type Embedder, type MemoryJudge } from "../../memory/server";

/**
 * The ruler (`memory-eval --ruler <working.jsonl> --db <copy of the hub database>`): the owner's real questions with the notes that answer them
 * (the human-signed ruler of the memory research), run through the plugin's own explicit search (`explicitMemorySearch`: the question's vector, the
 * search, the floor, the pins, the judge or the reranker; the very code `bb lane-pilot memory search` runs) over a COPY of the hub database, under one
 * combination of the forks `memory.vector_mode`, `memory.door_lock`, `memory.judge.mode` (+ `memory.pinned`), several runs, twice: over the question's
 * project alone, and over the whole hub (every project's notes as one shelf, the way a person's memory is one pile).
 * It prints, per scope: delivered (the share of the answering notes that reached the reader), strict recall@3 (the share that stood in the first three),
 * silence on the questions nothing answers, replies that could not be read, and the latency, each with the spread over runs and a Wilson 95 % interval.
 * The model and the embedder are injected (a room reads no files and holds no keys); the room never writes the database it is given.
 */
export type RulerQuestion = { qid: string; project: string; query: string; answerable: boolean; gold: string[] };
export type RulerForks = { vectorMode: "bridge" | "all"; doorLock: "off" | "literal" | "translated"; judgeMode: "rerank" | "filter"; pinned: boolean };
export type RulerOptions = RulerForks & {
  runs: number; scope: "project" | "hub" | "both"; limit: number; parallel: number; maxQuestions?: number;
  /** `off`: the search runs without a judge (retrieval alone). */
  judge: "on" | "off"; judgeModel?: string; candidates?: number;
  /** A fresh judge for each run (its cache would hide the variance between runs). Null: none available, the search runs without one. */
  makeJudge?: () => MemoryJudge | null;
  embedder?: Embedder | null;
};
export type Tally = { k: number; n: number };
export type RunScore = { delivered: Tally; strict3: Tally; silence: Tally; unparsed: Tally; latencies: number[]; vectorQuestions: number; questions: number };
export type ScopeReport = { scope: "project" | "hub"; runs: RunScore[] };
export type RulerReport = { forks: RulerForks; options: Pick<RulerOptions, "runs" | "limit" | "judge" | "judgeModel" | "candidates">; questions: { total: number; answerable: number; unanswerable: number }; scopes: ScopeReport[] };

/** Wilson score interval of k successes in n trials, as shares (95 % at z = 1.96). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const p = k / n, z2 = z * z, denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** The ruler file: one JSON object per line with `qid`, `project`, the question (`masked`, or `query` with `useRawQuery`), `label` (`answerable` / `unanswerable`) and `gold` note ids. */
export function parseRuler(text: string, useRawQuery = false): RulerQuestion[] {
  const out: RulerQuestion[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let row: { qid?: unknown; project?: unknown; query?: unknown; masked?: unknown; label?: unknown; gold?: unknown };
    try { row = JSON.parse(line); } catch { throw new Error(`ruler line ${index + 1} is not JSON`); }
    const preferred = useRawQuery ? row.query : row.masked;
    const query = typeof preferred === "string" && preferred ? preferred : typeof row.query === "string" ? row.query : "";
    if (typeof row.qid !== "string" || typeof row.project !== "string" || !query) throw new Error(`ruler line ${index + 1} lacks qid, project or the question`);
    const gold = Array.isArray(row.gold) ? row.gold.filter((id): id is string => typeof id === "string") : [];
    out.push({ qid: row.qid, project: row.project, query, answerable: row.label === "answerable" && gold.length > 0, gold });
  }
  return out;
}

const HUB = "hub";
/** The whole hub as one shelf: every note, its indexes and its vectors move under one project id. The copy is changed, never the original. */
export function mergeIntoHub(db: Pick<Database.Database, "prepare">): void {
  for (const table of ["lane_pilot_memory", "lane_pilot_memory_fts", "lane_pilot_memory_trgm", "lane_pilot_memory_vec", "lane_pilot_memory_vec_chunk"]) {
    try { db.prepare(`UPDATE ${table} SET project_id=?`).run(HUB); } catch { /* a table the copy does not have */ }
  }
}

/** A writable in-memory copy of a database file (opened read-only; the file is never touched). */
export function copyOfDatabase(path: string): Database.Database {
  const source = new Database(path, { readonly: true });
  try { return new Database(source.serialize()); } finally { source.close(); }
}

export function memorySettingsOf(options: RulerOptions): MemorySettings {
  return parseMemorySettings({
    "memory.vector_mode": options.vectorMode, "memory.door_lock": options.doorLock, "memory.judge.mode": options.judgeMode, "memory.pinned": options.pinned,
    "memory.judge.enabled": options.judge === "on",
    ...(options.judgeModel ? { "memory.judge.model": options.judgeModel } : {}), ...(options.candidates ? { "memory.judge.candidates": options.candidates } : {}),
  });
}

const share = (part: Tally) => (part.n ? part.k / part.n : 0);

async function inPool<T>(items: readonly T[], parallel: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

async function runOnce(db: LanePilotDatabase, questions: readonly RulerQuestion[], scope: "project" | "hub", options: RulerOptions, memory: MemorySettings): Promise<RunScore> {
  const score: RunScore = { delivered: { k: 0, n: 0 }, strict3: { k: 0, n: 0 }, silence: { k: 0, n: 0 }, unparsed: { k: 0, n: 0 }, latencies: [], vectorQuestions: 0, questions: questions.length };
  const since = Date.now();
  const previous = currentMemoryJudge();
  if (options.judge === "on") setMemoryJudge(options.makeJudge?.() ?? null);
  try {
    await inPool(questions, options.parallel, async (question) => {
      const started = performance.now();
      const result = await explicitMemorySearch(db, { projectId: scope === "hub" ? HUB : question.project, query: question.query, limit: options.limit, memory, allSections: true });
      score.latencies.push(performance.now() - started);
      if (queryVectorFor(question.query)) score.vectorQuestions++;
      const ids = result.records.map((record) => record.id);
      if (question.answerable) {
        score.delivered.n += question.gold.length; score.strict3.n += question.gold.length;
        score.delivered.k += question.gold.filter((id) => ids.includes(id)).length;
        score.strict3.k += question.gold.filter((id) => ids.slice(0, 3).includes(id)).length;
      } else {
        score.silence.n++;
        if (ids.length === 0) score.silence.k++;
      }
    });
    try {
      const stats = memoryJudgeStats(db, since);
      score.unparsed = { k: stats.unparsed, n: Math.max(0, stats.calls - stats.cached) };
    } catch { /* a copy without the receipt table */ }
  } finally { if (options.judge === "on") setMemoryJudge(previous); }
  return score;
}

/** The whole ruler: `runs` runs of every question, over the project alone and/or the whole hub. `open` makes a fresh writable copy of the database for each scope. */
export async function runRuler(open: () => Database.Database, questions: readonly RulerQuestion[], options: RulerOptions): Promise<RulerReport> {
  const asked = options.maxQuestions ? questions.slice(0, options.maxQuestions) : [...questions];
  const memory = memorySettingsOf(options);
  const scopes: ScopeReport[] = [];
  const previousEmbedder = currentEmbedder();
  if (options.embedder !== undefined) setEmbedder(options.embedder);
  try {
    for (const scope of (options.scope === "both" ? ["project", "hub"] as const : [options.scope])) {
      const db = open();
      try {
        if (scope === "hub") mergeIntoHub(db);
        const runs: RunScore[] = [];
        for (let run = 0; run < options.runs; run++) runs.push(await runOnce(db as unknown as LanePilotDatabase, asked, scope, options, memory));
        scopes.push({ scope, runs });
      } finally { db.close(); }
    }
  } finally { if (options.embedder !== undefined) setEmbedder(previousEmbedder); }
  const answerable = asked.filter((question) => question.answerable).length;
  return { forks: { vectorMode: options.vectorMode, doorLock: options.doorLock, judgeMode: options.judgeMode, pinned: options.pinned },
    options: { runs: options.runs, limit: options.limit, judge: options.judge, ...(options.judgeModel ? { judgeModel: options.judgeModel } : {}), ...(options.candidates ? { candidates: options.candidates } : {}) },
    questions: { total: asked.length, answerable, unanswerable: asked.length - answerable }, scopes };
}

const pct = (value: number) => (value * 100).toFixed(1);
const percentile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);

/** One measure over the runs: mean (lowest–highest run) [Wilson 95 % of the pooled trials], all in percent. */
function cell(runs: readonly RunScore[], pick: (run: RunScore) => Tally): string {
  const parts = runs.map(pick);
  const k = parts.reduce((sum, part) => sum + part.k, 0), n = parts.reduce((sum, part) => sum + part.n, 0);
  if (!n) return "n/a";
  const shares = parts.map(share);
  const [low, high] = wilson(k, n);
  return `${pct(k / n)} (${pct(Math.min(...shares))}–${pct(Math.max(...shares))}) [${pct(low)}–${pct(high)}]`;
}

export function formatRuler(report: RulerReport): string {
  const { forks, options } = report;
  const lines = [`memory ruler: ${report.questions.total} questions (${report.questions.answerable} with an answer, ${report.questions.unanswerable} without), ${options.runs} runs, limit ${options.limit}, judge ${options.judge}${options.judgeModel ? ` ${options.judgeModel}` : ""}`,
    `forks: memory.vector_mode=${forks.vectorMode} memory.door_lock=${forks.doorLock} memory.judge.mode=${forks.judgeMode} memory.pinned=${forks.pinned ? "on" : "off"}`,
    "cells: mean % (lowest–highest run) [Wilson 95 % over all runs pooled]"];
  for (const { scope, runs } of report.scopes) {
    const times = runs.flatMap((run) => run.latencies).sort((a, b) => a - b);
    const vectors = runs.reduce((sum, run) => sum + run.vectorQuestions, 0), asked = runs.reduce((sum, run) => sum + run.questions, 0);
    lines.push("", `${scope === "project" ? "project-only memory" : "whole-hub memory"}${vectors < asked ? `  (the question had a vector in ${vectors} of ${asked} searches: the rest ran on words)` : ""}`,
      `  delivered              ${cell(runs, (run) => run.delivered)}`,
      `  strict recall@3        ${cell(runs, (run) => run.strict3)}`,
      `  silence (unanswerable) ${cell(runs, (run) => run.silence)}`,
      `  unparsed replies       ${cell(runs, (run) => run.unparsed)}`,
      `  latency ms p50 / p95   ${Math.round(percentile(times, 0.5))} / ${Math.round(percentile(times, 0.95))}`);
  }
  return lines.join("\n");
}
