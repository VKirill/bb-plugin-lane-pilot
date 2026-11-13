import type { MemoryDatabase } from "./store";
import type { MemoryAudience } from "./settings";
import { wordFrequencies } from "./floor";
import { memoryStem, memoryTokens } from "./terms";

/**
 * The door lock (`memory.door_lock`): the vectors may not open a question the word layer left closed. The word layer «opens the door» when some
 * candidate shares words with the question that weigh at least `DOOR_MIN_WEIGHT` together (the floor's own word weight: how uncommon the words
 * are in the project's notes). One everyday word does not open it; a word only a few notes hold does.
 *   off        no lock (today's behaviour);
 *   literal    the question's own words only (a Russian question over English notes finds almost nothing: the lock closes it);
 *   translated the question's words and English keywords of the question made by one cheap model call (`rememberLockTerms`, made by the async
 *              caller before the sync search, cached per question); if the call failed there are no terms and the lock is the literal one.
 */
export const DOOR_LOCKS = ["off", "literal", "translated"] as const;
export type DoorLock = (typeof DOOR_LOCKS)[number];
export const DOOR_MIN_WEIGHT = 0.35;

const lockTerms = new Map<string, string[]>();
/** English keywords of a question, made by the caller (`memory-translate.ts`); kept for the last 256 questions. */
export function rememberLockTerms(query: string, terms: readonly string[]): void {
  lockTerms.delete(query);
  lockTerms.set(query, [...new Set(terms.flatMap((term) => memoryTokens(term)))].slice(0, 16));
  if (lockTerms.size > 256) lockTerms.delete(lockTerms.keys().next().value!);
}
export const lockTermsFor = (query: string): string[] | undefined => lockTerms.get(query);
export const forgetLockTerms = (): void => lockTerms.clear();

/** The words the word layer searches with under a lock mode: the question's, plus the translated keywords under `translated`. */
export const lockQueryText = (query: string, mode: DoorLock): string => mode === "translated" ? `${query} ${(lockTermsFor(query) ?? []).join(" ")}`.trim() : query;

const trigramCount = (db: MemoryDatabase, projectId: string, audience: MemoryAudience, personalBot: string, stem: string): number => {
  try {
    return (db.prepare(`SELECT count(*) AS n FROM lane_pilot_memory_trgm t JOIN lane_pilot_memory m ON m.id=t.id AND m.project_id=t.project_id
      WHERE lane_pilot_memory_trgm MATCH ? AND t.project_id=? AND m.audience=? AND m.personal_bot=?`).get(`"${stem.replaceAll('"', "")}"`, projectId, audience, personalBot) as { n: number }).n;
  } catch { return 0; }
};
const wordCount = (db: MemoryDatabase, projectId: string, audience: MemoryAudience, personalBot: string, word: string): number => {
  try {
    return (db.prepare(`SELECT count(*) AS n FROM lane_pilot_memory_fts f JOIN lane_pilot_memory m ON m.id=f.id AND m.project_id=f.project_id
      WHERE lane_pilot_memory_fts MATCH ? AND f.project_id=? AND m.audience=? AND m.personal_bot=?`).get(`"${word.replaceAll('"', "")}"`, projectId, audience, personalBot) as { n: number }).n;
  } catch { return 0; }
};

/**
 * Whether the word layer opens the door for this question: the words of the question (and under `translated` the keywords) that some note holds,
 * counted the way the index reads them (whole words, then word forms through the trigram index), weigh `ln(1 + notes / notes holding the word) / ln(1 + notes)`
 * each, as in the relevance floor; the door opens when they add up to `DOOR_MIN_WEIGHT`. An identifier such as `ZX-7741` counts as the index splits it.
 * `candidates` is how many records the word layer returned: none, closed.
 */
export function doorOpens(db: MemoryDatabase, projectId: string, query: string, mode: DoorLock, candidates: number, audience: MemoryAudience, personalBot: string): boolean {
  if (mode === "off") return true;
  if (!candidates) return false;
  const total = Math.max(1, wordFrequencies(db, projectId, audience, personalBot).total);
  const scale = Math.log(1 + total);
  let weight = 0;
  for (const word of [...new Set(memoryTokens(lockQueryText(query, mode)))].slice(0, 32)) {
    let held = wordCount(db, projectId, audience, personalBot, word);
    if (!held) held = trigramCount(db, projectId, audience, personalBot, memoryStem(word));
    if (held > 0) weight += Math.log(1 + total / held) / scale;
    if (weight >= DOOR_MIN_WEIGHT) return true;
  }
  return false;
}
