import Database from "better-sqlite3";
import { DOC_CHARS, EMBED_DIM, estimateTokens, hideRecord, memoryStem, memoryTokens, parseMemorySettings, pendingChunks, pendingVectors, storeChunkVectors, recordRelevance, rememberQueryVector, searchMemoryRecords, sharedScope, storeMemoryRecords, storeVectors, answerProbability, wordFrequencies, type MemoryAudience, type MemoryRecord, type MemorySettings } from "@lane-pilot/memory-core";
import type { LanePilotDatabase } from "../../storage";
import { mixWriterMemory, pmMemoryContext } from "../../memory/server";
import { SUITE_CASES, SUITE_NOTES, SUITE_PROJECT, type SuiteCase, type SuiteFamily, type SuiteNote } from "./suite-fixture";

/**
 * The offline memory suite: the cases H1-H7 of the memory research run against synthetic notes in a scratch database, no network and no model.
 * It scores retrieval, the part of memory a change can break without a model in the loop: which records reach the PM context or the writer's
 * brief, and whether the answer gate warns (`weakMatch`) or the floor empties the list (`nothingRelevant`). `e2e.ts` adds the model on top.
 *
 * The embedding is a stand-in: words hashed into the 768 numbers the real model makes, plus one shared direction so unrelated texts sit near
 * 0.6 like the real model's. The cosines therefore are not the production ones. The suite measures that the path (search, floor, gate, packing,
 * sections, supersede) behaves the same from version to version, not the calibration of `ANSWER_GATE` (that is `--gate` on the hub copy).
 */
const SHARED_WEIGHT = 1.2;
const hashOf = (text: string, seed: number): number => {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};
/** Deterministic stand-in for the embedding model: hashed word stems (length 4+, like the floor counts them) around a shared direction. */
export function standInEmbedding(text: string): Float32Array {
  const out = new Float32Array(EMBED_DIM);
  const stems = new Set(memoryTokens(text).filter((token) => token.length >= 4).map(memoryStem));
  for (const stem of stems) {
    const at = hashOf(stem, 1) % EMBED_DIM;
    out[at] = out[at]! + (hashOf(stem, 2) & 1 ? 1 : -1);
  }
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) out[i] = out[i]! / norm;
  out[0] = out[0]! + SHARED_WEIGHT;
  return out;
}

export type SuitePlant = { db: LanePilotDatabase; ids: Map<string, string>; keys: Map<string, string> };

const LIMITS = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 99_999 };

/** Plants the fixture through the write door (so supersede and scopes work as in production) and gives every active note a stand-in vector. */
export function plantSuite(migrations: readonly string[], notes: readonly SuiteNote[] = SUITE_NOTES): SuitePlant {
  const raw = new Database(":memory:");
  for (const statement of migrations) raw.exec(statement);
  const db = raw as unknown as LanePilotDatabase;
  const ids = new Map<string, string>(), keys = new Map<string, string>();
  const now = Date.now();
  notes.forEach((note, index) => {
    const oldId = note.supersedes ? ids.get(note.supersedes) : undefined;
    if (note.supersedes && !oldId) throw new Error(`suite note ${note.key} replaces ${note.supersedes}, which is not planted before it`);
    const scope = note.scope === "shared" ? sharedScope() : note.scope ?? [];
    const stored = storeMemoryRecords(db as never, { ...LIMITS, projectId: SUITE_PROJECT, audience: note.audience ?? "subagent", sourceSha256: "s".repeat(64), now: now - (notes.length - index) * 1000, scope, origin: "maintainer",
      entries: [{ kind: note.kind ?? "note", content: note.content, concepts: note.concepts ?? ["suite"], ...(oldId ? { supersedes: [oldId.slice(0, 12)] } : {}) }] });
    const id = stored.insertedIds[0] ?? stored.records.find((record) => record.content === note.content)?.id;
    if (!id) throw new Error(`suite note ${note.key} was not stored`);
    ids.set(note.key, id); keys.set(id, note.key);
  });
  // What the budget would do to a note: move it off the shelf, keep its indexes and give it a vector like any other.
  for (const note of notes) if (note.archived) hideRecord(db as never, SUITE_PROJECT, ids.get(note.key)!, "expired", null, () => {}, "budget");
  const active = pendingVectors(db as never, 100_000);
  for (const note of notes) if (!/-old$/.test(note.key) && !active.some((row) => row.id === ids.get(note.key))) throw new Error(`suite note ${note.key} is not embeddable after planting`);
  // The real model reads the first DOC_CHARS of a record; a longer one also gets a vector per chunk (`pendingChunks`).
  storeVectors(db as never, active.map((row) => ({ ...row, vector: standInEmbedding(row.content.slice(0, DOC_CHARS)) })));
  storeChunkVectors(db as never, pendingChunks(db as never, 100_000).map((row) => ({ ...row, vectors: row.chunks.map((chunk) => standInEmbedding(chunk)) })));
  return { db, ids, keys };
}

export type CaseResult = {
  id: string; family: SuiteFamily; kind: string; pass: boolean;
  expect: string[] | "nothing";
  /** Keys of the notes that reached the reader, in the order of the context. */
  returned: string[]; missing: string[]; leaked: string[];
  weakMatch: boolean; nothingRelevant: boolean;
  /** The answer gate's probability that the search holds an answer; null where it cannot tell. */
  p: number | null;
  tokens: number; ms: number;
  /** Text the reader got; e2e gives it to the model. */
  context: string;
};

const SETTINGS = (audience: MemoryAudience): MemorySettings => parseMemorySettings({ "memory.audience": audience });

/** One case: embeds the question (stand-in), reads the context like the PM tool or the writer's brief does, and judges it against what the case expects. */
export function runCase(plant: SuitePlant, item: SuiteCase): CaseResult {
  const { db, ids, keys } = plant;
  rememberQueryVector(item.question, standInEmbedding(item.question));
  const audience = item.audience ?? "subagent";
  const started = performance.now();
  let text: string, returnedIds: string[], weakMatch = false, nothingRelevant = false;
  if (item.surface === "writer") {
    const mixed = mixWriterMemory(db, { projectId: SUITE_PROJECT, query: item.question, task: { owns_paths: item.paths ?? [], read_first: [] }, searchEngine: "auto", personalBot: "", ruleMemoryIds: new Set(), chain: item.chain ?? [] });
    text = mixed.text; returnedIds = mixed.ids;
    nothingRelevant = returnedIds.length === 0;
  } else {
    const packed = pmMemoryContext(db, SUITE_PROJECT, SETTINGS(audience), item.question, item.chain ?? [], "pm", undefined, true);
    text = packed.text; returnedIds = packed.records.map((record) => record.id);
    weakMatch = "weakMatch" in packed && packed.weakMatch === true; nothingRelevant = packed.nothingRelevant;
  }
  const ms = performance.now() - started;
  const returned = returnedIds.map((id) => keys.get(id) ?? id);
  const wanted = item.expect === "nothing" ? [] : item.expect;
  const missing = [...wanted.filter((key) => !returned.includes(key)), ...(item.contains ?? []).filter((snippet) => !text.includes(snippet)).map((snippet) => `text «${snippet}»`)];
  const leaked = (item.forbid ?? []).filter((key) => returned.includes(key));
  const abstained = nothingRelevant || weakMatch;
  // H5 is about leaks: a question with no answer in the reader's reach may still get other, allowed notes.
  const needsAbstain = item.expect === "nothing" && item.family !== "H5";
  const pass = missing.length === 0 && leaked.length === 0 && (!needsAbstain || abstained);
  return { id: item.id, family: item.family, kind: item.kind, pass, expect: item.expect, returned, missing, leaked, weakMatch, nothingRelevant, p: gateProbability(db, item, audience), tokens: estimateTokens(text), ms, context: text };
}

function gateProbability(db: LanePilotDatabase, item: SuiteCase, audience: MemoryAudience): number | null {
  if (item.surface === "writer") return null;
  const records: MemoryRecord[] = searchMemoryRecords(db as never, SUITE_PROJECT, item.question, 100, "auto", audience, "", { chain: item.chain ?? [] });
  return answerProbability(records, recordRelevance(wordFrequencies(db as never, SUITE_PROJECT, audience, ""), item.question, records));
}

export type FamilyScore = { family: SuiteFamily | "H7"; title: string; n: number; pass: number; rate: number; detail: string };
export type SuiteCost = { meanTokens: number; p95Ms: number; maxTokens: number; cases: number };
export type SuiteReport = { cases: CaseResult[]; families: FamilyScore[]; cost: SuiteCost; leaks: string[] };

const TITLES: Record<SuiteFamily, string> = { H1: "writer brief recall", H2: "PM question on a past decision", H3: "no answer (incl. near-miss)", H4: "updated fact returns the new version", H5: "cross-section leakage", H6: "grey band of the gate", H8: "archived record found by PM search", H9: "history question shows the old version", H10: "long record found by a later paragraph" };
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

export function scoreSuite(cases: readonly CaseResult[]): SuiteReport {
  const families: FamilyScore[] = (Object.keys(TITLES) as SuiteFamily[]).map((family) => {
    const mine = cases.filter((item) => item.family === family);
    const pass = mine.filter((item) => item.pass).length;
    let detail = "";
    if (family === "H3" || family === "H6") {
      const nothing = mine.filter((item) => item.expect === "nothing");
      const silent = nothing.filter((item) => item.nothingRelevant).length, warned = nothing.filter((item) => !item.nothingRelevant && item.weakMatch).length;
      detail = `of ${nothing.length} without answer: ${silent} silent, ${warned} warned, ${nothing.length - silent - warned} answered falsely`;
      const yes = mine.filter((item) => item.expect !== "nothing");
      if (yes.length) detail += `; ${yes.filter((item) => item.weakMatch).length}/${yes.length} answerable ones warned`;
    } else if (family === "H5") {
      detail = `${mine.reduce((sum, item) => sum + item.leaked.length, 0)} leaks`;
    } else if (family === "H4") {
      detail = `${mine.filter((item) => item.leaked.length > 0).length} returned a replaced version`;
    } else detail = `${mine.filter((item) => item.missing.length === 0).length}/${mine.length} found every expected note`;
    return { family, title: TITLES[family], n: mine.length, pass, rate: mine.length ? pass / mine.length : 1, detail };
  });
  const timed = cases.map((item) => item.ms).sort((a, b) => a - b);
  const cost: SuiteCost = { cases: cases.length, meanTokens: cases.length ? Math.round(cases.reduce((sum, item) => sum + item.tokens, 0) / cases.length) : 0,
    maxTokens: Math.max(0, ...cases.map((item) => item.tokens)), p95Ms: timed.length ? Math.round(timed[Math.min(timed.length - 1, Math.ceil(timed.length * 0.95) - 1)]! * 100) / 100 : 0 };
  families.push({ family: "H7", title: "cost and latency", n: cost.cases, pass: cost.cases, rate: 1, detail: `${cost.meanTokens} tokens per case (max ${cost.maxTokens}), p95 ${cost.p95Ms} ms` });
  const leaks = cases.filter((item) => item.leaked.length > 0 && item.family === "H5").map((item) => `${item.id}: ${item.leaked.join(", ")}`);
  return { cases: [...cases], families, cost, leaks };
}

/** The whole offline suite on a fresh scratch database. */
export function runSuite(migrations: readonly string[], cases: readonly SuiteCase[] = SUITE_CASES): SuiteReport {
  const plant = plantSuite(migrations);
  try { return scoreSuite(cases.map((item) => runCase(plant, item))); }
  finally { (plant.db as unknown as Database.Database).close(); }
}

export type SuiteBaseline = { version: number; families: Record<string, { n: number; pass: number }>; meanTokens: number; note?: string };
export const baselineOf = (report: SuiteReport, note?: string): SuiteBaseline => ({ version: 1, families: Object.fromEntries(report.families.filter((row) => row.family !== "H7").map((row) => [row.family, { n: row.n, pass: row.pass }])), meanTokens: report.cost.meanTokens, ...(note ? { note } : {}) });

/** What got worse than the recorded baseline: a family with fewer passes, any leak, a context more than a quarter bigger. Empty is clean. */
export function regressions(report: SuiteReport, baseline: SuiteBaseline, previous?: ReadonlyMap<string, boolean>): string[] {
  const out: string[] = [];
  if (report.leaks.length) out.push(`leakage (H5): ${report.leaks.join("; ")}`);
  for (const row of report.families) {
    if (row.family === "H7") continue;
    const was = baseline.families[row.family];
    if (!was) continue;
    if (row.pass < was.pass) {
      const changed = report.cases.filter((item) => item.family === row.family && !item.pass && previous?.get(item.id) !== false).map((item) => item.id);
      out.push(`${row.family} fell from ${was.pass}/${was.n} to ${row.pass}/${row.n}${changed.length ? ` (failing: ${changed.join(", ")})` : ""}`);
    }
  }
  if (baseline.meanTokens > 0 && report.cost.meanTokens > baseline.meanTokens * 1.25) out.push(`H7 context grew from ${baseline.meanTokens} to ${report.cost.meanTokens} tokens per case`);
  return out;
}

export function formatSuite(report: SuiteReport, baseline?: SuiteBaseline): string {
  const rows = report.families.map((row) => {
    const was = baseline?.families[row.family];
    const against = was ? ` (baseline ${was.pass}/${was.n})` : "";
    return `${row.family.padEnd(3)} ${row.title.padEnd(38)} ${row.family === "H7" ? "" : `${String(row.pass).padStart(3)}/${String(row.n).padEnd(3)} ${pct(row.rate).padStart(4)}`}  ${row.detail}${against}`;
  });
  const failing = report.cases.filter((item) => !item.pass).map((item) => `  ${item.id}: ${item.missing.length ? `missing ${item.missing.join(",")}; ` : ""}${item.leaked.length ? `leaked ${item.leaked.join(",")}; ` : ""}${item.expect === "nothing" && !item.weakMatch && !item.nothingRelevant ? "answered with notes and no warning; " : ""}p=${item.p === null ? "n/a" : item.p.toFixed(3)}`);
  return [`memory suite: ${report.cases.length} cases, stand-in embedding (offline)`, ...rows, ...(failing.length ? ["failing cases:", ...failing] : [])].join("\n");
}
