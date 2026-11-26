import type Database from "better-sqlite3";
import { MAX_BUDGET, estimateTokens, memoryJudgeStats, parseMemorySettings, queryVectorFor, type MemorySettings } from "@lane-pilot/memory-core";
import type { LanePilotDatabase } from "../../../storage";
import { MEMORY_SETTING_KEYS } from "../../../memory";
import { currentEmbedder, currentMemoryJudge, embedQuery, explicitMemorySearch, judgeWriterMemory, mixWriterMemory, setEmbedder, setMemoryJudge, type Embedder, type MemoryJudge } from "../../../memory/server";
import { pairedBootstrapInterval, type BootstrapInterval } from "../../../evolve";
import { copyOfDatabase, mergeIntoHub } from "../repositories/eval-db";

export { copyOfDatabase, mergeIntoHub };

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
export type RulerQuestion = { qid: string; project: string; query: string; answerable: boolean; gold: string[]; paths?: { owns_paths: string[]; read_first: string[] }; chain?: string[] };
export type RulerForks = { vectorMode: "bridge" | "all"; doorLock: "off" | "literal" | "translated"; judgeMode: "rerank" | "filter"; pinned: boolean };
export type RulerPath = "search" | "writer" | "none";
export type RulerOptions = RulerForks & {
  runs: number; scope: "project" | "hub" | "both"; limit: number; parallel: number; maxQuestions?: number;
  /** `off`: the search runs without a judge (retrieval alone). */
  judge: "on" | "off"; judgeModel?: string; candidates?: number;
  /** Which delivery path to measure: explicit `search` (default), `writer` brief, or `none` (no-memory control arm). */
  path?: RulerPath;
  /** Optional `memory.note_budget` and `memory.context_budget` overrides for arm comparisons. */
  noteBudget?: number; contextBudget?: number;
  arm?: string;
  log?: (line: string) => void;
  /** A fresh judge for each run (its cache would hide the variance between runs). Null: none available, the search runs without one. */
  makeJudge?: () => MemoryJudge | null;
  embedder?: Embedder | null;
};
export type Tally = { k: number; n: number };
export type QuestionOutcome = { hit3: boolean; delivered: boolean; noneOk: boolean; answerable: boolean; tokens: number; latencyMs: number };
export type RunScore = { delivered: Tally; strict3: Tally; silence: Tally; unparsed: Tally; latencies: number[]; tokens: number[]; byQuestion: Record<string, QuestionOutcome>; vectorQuestions: number; questions: number };
export type ScopeReport = { scope: "project" | "hub"; runs: RunScore[] };
export type RulerReport = { forks: RulerForks; options: Pick<RulerOptions, "runs" | "limit" | "judge" | "judgeModel" | "candidates" | "path" | "arm">; questions: { total: number; answerable: number; unanswerable: number }; scopes: ScopeReport[] };

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
    let row: { qid?: unknown; project?: unknown; query?: unknown; masked?: unknown; label?: unknown; gold?: unknown; paths?: { owns_paths?: unknown; read_first?: unknown }; chain?: unknown };
    try { row = JSON.parse(line); } catch { throw new Error(`ruler line ${index + 1} is not JSON`); }
    const preferred = useRawQuery ? row.query : row.masked;
    const query = typeof preferred === "string" && preferred ? preferred : typeof row.query === "string" ? row.query : "";
    if (typeof row.qid !== "string" || typeof row.project !== "string" || !query) throw new Error(`ruler line ${index + 1} lacks qid, project or the question`);
    const gold = Array.isArray(row.gold) ? row.gold.filter((id): id is string => typeof id === "string") : [];
    const owns = Array.isArray(row.paths?.owns_paths) ? row.paths.owns_paths.filter((p): p is string => typeof p === "string") : [];
    const read = Array.isArray(row.paths?.read_first) ? row.paths.read_first.filter((p): p is string => typeof p === "string") : [];
    const chain = Array.isArray(row.chain) ? row.chain.filter((s): s is string => typeof s === "string") : undefined;
    out.push({ qid: row.qid, project: row.project, query, answerable: row.label === "answerable" && gold.length > 0, gold, ...(row.paths ? { paths: { owns_paths: owns, read_first: read } } : {}), ...(chain ? { chain } : {}) });
  }
  return out;
}

const HUB = "hub";

export function memorySettingsOf(options: RulerOptions): MemorySettings {
  const settings = parseMemorySettings({
    [MEMORY_SETTING_KEYS.vectorMode]: options.vectorMode,
    [MEMORY_SETTING_KEYS.doorLock]: options.doorLock,
    [MEMORY_SETTING_KEYS.judgeMode]: options.judgeMode,
    [MEMORY_SETTING_KEYS.pinned]: options.pinned,
    [MEMORY_SETTING_KEYS.judgeEnabled]: options.judge === "on",
    ...(options.judgeModel ? { [MEMORY_SETTING_KEYS.judgeModel]: options.judgeModel } : {}),
    ...(options.candidates ? { [MEMORY_SETTING_KEYS.judgeCandidates]: options.candidates } : {}),
  });
  if (options.noteBudget) {
    if (!Number.isSafeInteger(options.noteBudget) || options.noteBudget < 1 || options.noteBudget > MAX_BUDGET) {
      throw new Error(`noteBudget must be an integer from 1 to ${MAX_BUDGET}`);
    }
    settings.noteBudget = options.noteBudget;
  }
  if (options.contextBudget) {
    if (!Number.isSafeInteger(options.contextBudget) || options.contextBudget < 1 || options.contextBudget > MAX_BUDGET) {
      throw new Error(`contextBudget must be an integer from 1 to ${MAX_BUDGET}`);
    }
    settings.contextBudget = options.contextBudget;
  }
  return settings;
}

const share = (part: Tally) => (part.n ? part.k / part.n : 0);

async function inPool<T>(items: readonly T[], parallel: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

async function runOnce(db: LanePilotDatabase, questions: readonly RulerQuestion[], scope: "project" | "hub", options: RulerOptions, memory: MemorySettings): Promise<RunScore> {
  const score: RunScore = { delivered: { k: 0, n: 0 }, strict3: { k: 0, n: 0 }, silence: { k: 0, n: 0 }, unparsed: { k: 0, n: 0 }, latencies: [], tokens: [], byQuestion: {}, vectorQuestions: 0, questions: questions.length };
  const since = Date.now();
  const previous = currentMemoryJudge();
  const pathMode = options.path ?? "search";
  if (options.judge === "on" && pathMode !== "none") setMemoryJudge(options.makeJudge?.() ?? null);
  try {
    await inPool(questions, options.parallel, async (question) => {
      const started = performance.now();
      const projectId = scope === "hub" ? HUB : question.project;
      let ids: string[] = [];
      let tokens = 0;
      if (pathMode === "none") {
        ids = [];
        tokens = 0;
      } else if (pathMode === "writer") {
        await embedQuery(question.query);
        const mixInput = {
          projectId,
          query: question.query,
          task: question.paths ?? { owns_paths: [], read_first: [] },
          searchEngine: memory.searchEngine,
          personalBot: memory.personalBot,
          ruleMemoryIds: new Set<string>(),
          kind: memory.projectKind,
          tagNotes: memory.tagNotes,
          scopeMode: memory.scope ?? "section",
          chain: question.chain ?? [],
        };
        const allowedIds = options.judge === "on" ? await judgeWriterMemory(db, mixInput, memory) : null;
        const mixed = mixWriterMemory(db, { ...mixInput, allowedIds });
        ids = mixed.ids;
        tokens = estimateTokens(mixed.text);
      } else {
        const result = await explicitMemorySearch(db, { projectId, query: question.query, limit: options.limit, memory, allSections: true });
        ids = result.records.map((record) => record.id);
        tokens = estimateTokens(result.records.map((record) => record.content).join("\n"));
      }
      const latencyMs = performance.now() - started;
      score.latencies.push(latencyMs);
      score.tokens.push(tokens);
      if (pathMode !== "none" && queryVectorFor(question.query)) score.vectorQuestions++;
      let hit3 = false;
      let delivered = false;
      let noneOk = false;
      if (question.answerable) {
        score.delivered.n += question.gold.length; score.strict3.n += question.gold.length;
        const delivCount = question.gold.filter((id) => ids.includes(id)).length;
        const strictCount = question.gold.filter((id) => ids.slice(0, 3).includes(id)).length;
        score.delivered.k += delivCount;
        score.strict3.k += strictCount;
        delivered = delivCount > 0;
        hit3 = strictCount > 0;
      } else {
        score.silence.n++;
        noneOk = ids.length === 0;
        if (noneOk) score.silence.k++;
      }
      score.byQuestion[question.qid] = { hit3, delivered, noneOk, answerable: question.answerable, tokens, latencyMs };
    });
    if (pathMode !== "none") {
      try {
        const stats = memoryJudgeStats(db, since);
        score.unparsed = { k: stats.unparsed, n: Math.max(0, stats.calls - stats.cached) };
      } catch { /* a copy without the receipt table */ }
    }
  } finally { if (options.judge === "on" && pathMode !== "none") setMemoryJudge(previous); }
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
        const reportScope: ScopeReport = { scope, runs };
        scopes.push(reportScope);
        if (options.log) {
          const summary = summarizeScopeArm(reportScope);
          options.log(`INFO ${armLogLine(`${options.path ?? "search"}:${scope}`, summary)}`);
        }
      } finally { db.close(); }
    }
  } finally { if (options.embedder !== undefined) setEmbedder(previousEmbedder); }
  const answerable = asked.filter((question) => question.answerable).length;
  return { forks: { vectorMode: options.vectorMode, doorLock: options.doorLock, judgeMode: options.judgeMode, pinned: options.pinned },
    options: { runs: options.runs, limit: options.limit, judge: options.judge, ...(options.judgeModel ? { judgeModel: options.judgeModel } : {}), ...(options.candidates ? { candidates: options.candidates } : {}), ...(options.path ? { path: options.path } : {}), ...(options.arm ? { arm: options.arm } : {}) },
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

export type ScopeArmSummary = {
  hit3: number;
  noneOk: number;
  meanTokens: number;
  p95Ms: number;
  byQuestion: Map<string, QuestionOutcome>;
};

const meanOf = (values: readonly number[]) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0);

export function summarizeScopeArm(scopeReport: ScopeReport): ScopeArmSummary {
  const strictK = scopeReport.runs.reduce((sum, r) => sum + r.strict3.k, 0);
  const strictN = scopeReport.runs.reduce((sum, r) => sum + r.strict3.n, 0);
  const silK = scopeReport.runs.reduce((sum, r) => sum + r.silence.k, 0);
  const silN = scopeReport.runs.reduce((sum, r) => sum + r.silence.n, 0);
  const allTokens = scopeReport.runs.flatMap((r) => r.tokens);
  const allLatencies = scopeReport.runs.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const grouped = new Map<string, QuestionOutcome[]>();
  for (const run of scopeReport.runs) {
    for (const [qid, outcome] of Object.entries(run.byQuestion ?? {})) {
      const list = grouped.get(qid) ?? [];
      list.push(outcome);
      grouped.set(qid, list);
    }
  }
  const byQuestion = new Map<string, QuestionOutcome>();
  for (const [qid, items] of grouped) {
    const answerable = items[0]!.answerable;
    byQuestion.set(qid, {
      answerable,
      hit3: items.filter((i) => i.hit3).length * 2 > items.length,
      delivered: items.filter((i) => i.delivered).length * 2 > items.length,
      noneOk: items.filter((i) => i.noneOk).length * 2 > items.length,
      tokens: meanOf(items.map((i) => i.tokens)),
      latencyMs: meanOf(items.map((i) => i.latencyMs)),
    });
  }
  return {
    hit3: strictN ? strictK / strictN : 0,
    noneOk: silN ? silK / silN : 1,
    meanTokens: meanOf(allTokens),
    p95Ms: percentile(allLatencies, 0.95),
    byQuestion,
  };
}

export function armLogLine(path: string, summary: Pick<ScopeArmSummary, "hit3" | "noneOk" | "meanTokens" | "p95Ms">): string {
  return `memory.arm path=${path} hit3=${(summary.hit3 * 100).toFixed(1)}% none_ok=${(summary.noneOk * 100).toFixed(1)}% tokens=${Math.round(summary.meanTokens)} p95=${Math.round(summary.p95Ms)}ms`;
}

export type ArmComparison = {
  pairs: number;
  hit3: BootstrapInterval;
  noneOk: BootstrapInterval;
  tokens: BootstrapInterval;
  latencyMs: BootstrapInterval;
  candidate: ScopeArmSummary;
  control: ScopeArmSummary;
  withinBudget: boolean;
  adopt: boolean;
};

export function compareRulerArms(
  controlScope: ScopeReport,
  candidateScope: ScopeReport,
  options: { level?: number; resamples?: number; seed?: number; maxTokens?: number; maxP95Ms?: number; gateClean?: boolean } = {},
): ArmComparison {
  const control = summarizeScopeArm(controlScope);
  const candidate = summarizeScopeArm(candidateScope);
  const shared = [...control.byQuestion.keys()].filter((qid) => candidate.byQuestion.has(qid));
  const ans = shared.filter((qid) => control.byQuestion.get(qid)!.answerable);
  const unans = shared.filter((qid) => !control.byQuestion.get(qid)!.answerable);
  const bootOpts = {
    ...(options.level !== undefined ? { level: options.level } : {}),
    ...(options.resamples !== undefined ? { resamples: options.resamples } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  };
  const hit3 = pairedBootstrapInterval(ans.map((q) => control.byQuestion.get(q)!.hit3), ans.map((q) => candidate.byQuestion.get(q)!.hit3), bootOpts);
  const noneOk = pairedBootstrapInterval(unans.map((q) => control.byQuestion.get(q)!.noneOk), unans.map((q) => candidate.byQuestion.get(q)!.noneOk), bootOpts);
  const tokens = pairedBootstrapInterval(shared.map((q) => control.byQuestion.get(q)!.tokens), shared.map((q) => candidate.byQuestion.get(q)!.tokens), bootOpts);
  const latencyMs = pairedBootstrapInterval(shared.map((q) => control.byQuestion.get(q)!.latencyMs), shared.map((q) => candidate.byQuestion.get(q)!.latencyMs), bootOpts);
  const withinBudget = (options.maxTokens === undefined || candidate.meanTokens <= options.maxTokens)
    && (options.maxP95Ms === undefined || candidate.p95Ms <= options.maxP95Ms);
  const gateClean = options.gateClean ?? true;
  const adopt = ans.length > 0 && hit3.mean > 0 && (unans.length === 0 || noneOk.mean >= 0) && withinBudget && gateClean;
  return { pairs: shared.length, hit3, noneOk, tokens, latencyMs, candidate, control, withinBudget, adopt };
}
