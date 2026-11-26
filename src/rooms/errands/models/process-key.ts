import { stems } from "@lane-pilot/workflow-engine";

/**
 * The process key of an errand (crystallization stage 1, stream R6): which recurring kind of work an errand belongs
 * to, as `subject|process`. The episode sweep proposes a candidate key (`process_key_proposed`); this module turns it
 * into `process_key`: the candidate's and the title's word stems are compared with every known key's words and titles,
 * and the candidate stands as the key (the deterministic answer).
 */

const NEAREST = 8;

export type KnownProcessKey = { key: string; titles: string[] };
export type NearProcessKey = KnownProcessKey & { score: number };

const stemSet = (text: string): Set<string> => new Set(stems(text));

/** Jaccard over stem sets — the same shape as learning/extract.ts similarity(), on stems instead of raw words. */
function score(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The `n` known keys nearest to the candidate and the title, by word stems; ties break on the key for a stable order. */
export function nearestKeys(candidate: string, title: string, known: KnownProcessKey[], n = NEAREST): NearProcessKey[] {
  const query = stemSet(`${candidate} ${title}`);
  return known
    .map((entry) => ({ ...entry, score: score(query, stemSet(`${entry.key} ${entry.titles.join(" ")}`)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, n);
}

export type ProcessKeyPick = { key: string; how: "new" | "fallback" };

/**
 * The process key of one errand. No known keys or nothing similar → the candidate is a new key; otherwise the candidate
 * stands as it is (an exact match with a known key is the same string).
 */
export async function chooseProcessKey(input: {
  candidate: string;
  title: string;
  known: KnownProcessKey[];
}): Promise<ProcessKeyPick> {
  const { candidate, title, known } = input;
  return { key: candidate, how: nearestKeys(candidate, title, known).length ? "fallback" : "new" };
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Pairs of ids that share a key, in gold and in predicted; `one-off|…` keys never pair (each is its own singleton). */
function sharedPairs(rows: Array<{ id: string; key: string }>): Set<string> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.key.startsWith("one-off|") ? `${row.key}#${row.id}` : row.key;
    const list = groups.get(key) ?? [];
    list.push(row.id);
    groups.set(key, list);
  }
  const pairs = new Set<string>();
  for (const ids of groups.values()) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) pairs.add(pairKey(ids[i]!, ids[j]!));
    }
  }
  return pairs;
}

/** Pairwise precision/recall/F1 of the predicted keys against the gold ones (~15 lines, no dependencies). */
export function pairwiseF1(gold: Array<{ id: string; key: string }>, predicted: Array<{ id: string; key: string }>): { precision: number; recall: number; f1: number; pairs: { gold: number; predicted: number; both: number } } {
  const goldPairs = sharedPairs(gold);
  const predictedPairs = sharedPairs(predicted);
  let both = 0;
  for (const pair of predictedPairs) if (goldPairs.has(pair)) both += 1;
  const precision = predictedPairs.size ? both / predictedPairs.size : goldPairs.size ? 0 : 1;
  const recall = goldPairs.size ? both / goldPairs.size : predictedPairs.size ? 0 : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, pairs: { gold: goldPairs.size, predicted: predictedPairs.size, both } };
}
