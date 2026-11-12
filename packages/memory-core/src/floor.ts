import type { MemoryDatabase } from "./store";
import type { MemoryAudience, MemoryRecord } from "./settings";
import { memoryStem, memoryTokens } from "./terms";

/**
 * The relevance floor of the query paths (the PM tool, the terminal's `lane-memory search`, the council). The search always returns
 * its best matches, even when the question has nothing to do with memory, so a question the notes cannot answer still got notes
 * back. A record clears the floor when it names a path written in the question, or when the words it shares with the question add up
 * to enough weight. The writer's brief does not use this: its path anchors already are a floor.
 *
 * The weight of a shared word is how uncommon it is in the project's own notes, so it needs no list of words:
 * ln(1 + notes / notes holding the word) / ln(1 + notes). A word only one note holds weighs close to 1, a word in half the notes about 0.1,
 * and the scale does not move with the size of the memory.
 *
 * The weight a record must reach depends on how long the question is: a whole task text shares many words with the notes by chance, a
 * five-word question cannot. It is `minScore` at `longWords` distinct words and more, `minScoreShort` at `shortWords` and fewer, and
 * moves in a straight line between (the two lengths are where the evaluation titles and full task texts part: the 90th percentile of the titles and the 10th of the full texts).
 */
export type RelevanceFloor = {
  /** The weights of the words a record shares with a long question (a task text) must add up to this much. */
  minScore: number;
  /** The same for a short question (a title). */
  minScoreShort: number;
  shortWords: number;
  longWords: number;
  /** A record that names a path written in the question clears the floor whatever its words weigh. */
  anchor: boolean;
};

/** Chosen on the tuning half of the evaluation (`bb lane-pilot memory-eval --floor`); see docs/memory.md. */
export const DEFAULT_RELEVANCE_FLOOR: RelevanceFloor = { minScore: 2, minScoreShort: 0, shortWords: 12, longWords: 17, anchor: true };

/** What an agent is told when nothing clears the floor: plainly, so it does not fill the gap with a guess. */
export const NOTHING_RELEVANT = "Memory has nothing relevant to this query. Do not assume or invent project facts; read the code or ask the owner.";

export type RecordRelevance = { shared: number; score: number; anchor: boolean };

const stemsOf = (text: string): Set<string> => new Set(memoryTokens(text).filter((token) => token.length >= 4).map(memoryStem));

/** How many distinct words a question has, as the floor counts them. */
export const questionWords = (query: string): number => stemsOf(query).size;

/** `dir/file.ts` and `dir/sub` written in a text: the last two segments of each path it contains. */
export function pathAnchorsOf(text: string): string[] {
  const out = new Set<string>();
  for (const path of text.match(/[\p{L}\p{N}_.@-]+(?:\/[\p{L}\p{N}_.@-]+)+/gu) ?? []) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 2) out.add(parts.slice(-2).join("/"));
  }
  return [...out];
}

export type Frequencies = { total: number; counts: Map<string, number> };
const cache = new WeakMap<object, Map<string, { key: string; value: Frequencies }>>();

/** In how many of the project's active notes each word stem appears. Kept until the project's notes change. */
export function wordFrequencies(db: MemoryDatabase, projectId: string, audience: MemoryAudience, personalBot: string): Frequencies {
  const stamp = db.prepare("SELECT count(*) AS n, COALESCE(max(created_at),0) AS last, COALESCE(sum(length(content)),0) AS size FROM lane_pilot_memory WHERE project_id=? AND audience=? AND personal_bot=? AND status='active'")
    .get(projectId, audience, personalBot) as { n: number; last: number; size: number };
  const key = `${stamp.n}|${stamp.last}|${stamp.size}`;
  const byProject = cache.get(db) ?? new Map<string, { key: string; value: Frequencies }>();
  cache.set(db, byProject);
  const slot = `${projectId}|${audience}|${personalBot}`;
  const known = byProject.get(slot);
  if (known?.key === key) return known.value;
  const counts = new Map<string, number>();
  for (const row of db.prepare("SELECT content, concepts_json FROM lane_pilot_memory WHERE project_id=? AND audience=? AND personal_bot=? AND status='active'").iterate(projectId, audience, personalBot) as Iterable<{ content: string; concepts_json: string }>)
    for (const stem of stemsOf(`${row.content} ${row.concepts_json}`)) counts.set(stem, (counts.get(stem) ?? 0) + 1);
  const value = { total: stamp.n, counts };
  byProject.set(slot, { key, value });
  return value;
}

/** What each record shares with the question: how many words, what they weigh together, and whether it names a path written in the question. */
export function recordRelevance(frequencies: Frequencies, query: string, records: readonly MemoryRecord[]): Map<string, RecordRelevance> {
  const asked = stemsOf(query);
  const anchors = pathAnchorsOf(query);
  const total = Math.max(1, frequencies.total);
  const scale = Math.log(1 + total);
  const out = new Map<string, RecordRelevance>();
  for (const record of records) {
    const text = `${record.content} ${record.concepts.join(" ")}`;
    const own = stemsOf(text);
    let shared = 0, score = 0;
    for (const stem of asked) {
      if (!own.has(stem)) continue;
      shared++;
      score += Math.log(1 + total / Math.max(1, frequencies.counts.get(stem) ?? 1)) / scale;
    }
    out.set(record.id, { shared, score, anchor: anchors.some((anchor) => text.includes(anchor)) });
  }
  return out;
}

/** The weight a record must reach for a question of this many distinct words. */
export function floorThreshold(floor: RelevanceFloor, words: number): number {
  const along = Math.min(1, Math.max(0, (words - floor.shortWords) / Math.max(1, floor.longWords - floor.shortWords)));
  return floor.minScoreShort + (floor.minScore - floor.minScoreShort) * along;
}

/**
 * The floor of a meaning search (a record carrying `similarity`, `vectors.ts`): the cosine below which a record is noise. Chosen on the
 * hub copy 2026-11-06 (gemini-embedding-2, 768): 0.65 keeps 99.5% of the wanted records; a question with no answer still mostly finds
 * something above it, so this floor cuts noise and does not decide «nothing» (that is the answer gate's job, below).
 */
export const DENSE_FLOOR = 0.65;

/**
 * The answer gate: «does the memory answer this question at all», decided by arithmetic on the search score. It replaced the model rerank
 * (Jev `memory.rerank`, 96.7% answered / 96.1% silent on the hub copy of 2026-11-06). A logistic score over five numbers of one search:
 * the cosine of the best record, the mean cosine of the best ten (a question the memory is about has a crowd of close records), the best record's z-score among the first 40, and the word weight of the best
 * record and of the strongest record. Fitted on the same 150 questions with an answer and 228 without, validated on held-out folds
 * (5-fold, repeated): at `ANSWER_GATE.min` it passes 87% of the questions that have an answer and doubts 67% of those that do
 * not. Too weak to silence the memory (`WEAK_MATCH` below), strong enough to warn the model that reads it. Recalibrate with `bb lane-pilot memory-eval`
 * on a fresh hub copy when the embedding model changes (the coefficients belong to `gemini-embedding-2`, 768 numbers).
 */
export const ANSWER_GATE = { bias: -39.73, top: 9.74, near: 37.06, z: 1.25, topWords: -1.13, maxWords: 1.98, min: 0.25, head: 40, nearN: 10 } as const;

/** The probability that the search holds an answer, or null when it cannot tell (no meaning search, fewer than three records). */
export function answerProbability(records: readonly MemoryRecord[], relevance: ReadonlyMap<string, RecordRelevance>): number | null {
  const ranked = records.filter((record) => record.similarity !== undefined).sort((a, b) => b.similarity! - a.similarity!).slice(0, ANSWER_GATE.head);
  if (ranked.length < 3) return null;
  const sims = ranked.map((record) => record.similarity!);
  const mean = sims.reduce((sum, value) => sum + value, 0) / sims.length;
  const sd = Math.sqrt(sims.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sims.length) + 1e-9;
  const near = sims.slice(0, ANSWER_GATE.nearN);
  const top = sims[0]!;
  const weights = ranked.map((record) => relevance.get(record.id)?.score ?? 0);
  const g = ANSWER_GATE;
  const x = g.bias + g.top * top + g.near * (near.reduce((sum, value) => sum + value, 0) / near.length) + g.z * ((top - mean) / sd) + g.topWords * weights[0]! + g.maxWords * Math.max(...weights);
  return 1 / (1 + Math.exp(-x));
}

export const clearsFloor = (relevance: RecordRelevance, floor: RelevanceFloor, words: number): boolean =>
  (floor.anchor && relevance.anchor) || relevance.score >= floorThreshold(floor, words);

/**
 * What the reader is told when the answer gate doubts the search. The gate does not empty the list: at its threshold it would drop 13% of
 * the questions that have an answer. The notes still go out under this line, and the reader (the PM or a session, both models) decides
 * whether they answer. On the hub copy the line marks 67% of the questions without an answer and 13% of those with one.
 */
export const WEAK_MATCH = "Memory has no confident answer to this query: the notes below only look related. Rely on a note only if it clearly answers the question; otherwise read the code or ask the owner.";

type FloorOpts = { audience?: MemoryAudience; personalBot?: string; floor?: RelevanceFloor | null };

/** True when the search (the records as it returned them, before the floor) does not look like an answer and no record names a path written in the question. */
export function weakAnswer(db: MemoryDatabase, projectId: string, query: string, records: readonly MemoryRecord[], opts: FloorOpts = {}): boolean {
  const floor = opts.floor === undefined ? DEFAULT_RELEVANCE_FLOOR : opts.floor;
  if (!floor || records.length === 0) return false;
  const relevance = recordRelevance(wordFrequencies(db, projectId, opts.audience ?? "subagent", opts.personalBot ?? ""), query, records);
  if (floor.anchor && records.some((record) => relevance.get(record.id)?.anchor)) return false;
  const p = answerProbability(records, relevance);
  return p !== null && p < ANSWER_GATE.min;
}

/** The records that clear the floor, in the order they came; `floor: null` leaves them as they were (the behaviour before the floor). */
export function relevantRecords(db: MemoryDatabase, projectId: string, query: string, records: readonly MemoryRecord[], opts: FloorOpts = {}): MemoryRecord[] {
  const floor = opts.floor === undefined ? DEFAULT_RELEVANCE_FLOOR : opts.floor;
  if (!floor || records.length === 0) return [...records];
  const relevance = recordRelevance(wordFrequencies(db, projectId, opts.audience ?? "subagent", opts.personalBot ?? ""), query, records);
  const words = questionWords(query);
  return records.filter((record) => record.similarity !== undefined
    ? (floor.anchor && relevance.get(record.id)!.anchor) || record.similarity >= DENSE_FLOOR
    : clearsFloor(relevance.get(record.id)!, floor, words));
}
