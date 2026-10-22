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

export const clearsFloor = (relevance: RecordRelevance, floor: RelevanceFloor, words: number): boolean =>
  (floor.anchor && relevance.anchor) || relevance.score >= floorThreshold(floor, words);

/** The records that clear the floor, in the order they came; `floor: null` leaves them as they were (the behaviour before the floor). */
export function relevantRecords(db: MemoryDatabase, projectId: string, query: string, records: readonly MemoryRecord[], opts: { audience?: MemoryAudience; personalBot?: string; floor?: RelevanceFloor | null } = {}): MemoryRecord[] {
  const floor = opts.floor === undefined ? DEFAULT_RELEVANCE_FLOOR : opts.floor;
  if (!floor || records.length === 0) return [...records];
  const relevance = recordRelevance(wordFrequencies(db, projectId, opts.audience ?? "subagent", opts.personalBot ?? ""), query, records);
  const words = questionWords(query);
  return records.filter((record) => clearsFloor(relevance.get(record.id)!, floor, words));
}
