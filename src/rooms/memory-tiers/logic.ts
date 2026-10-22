/**
 * Memory tiers (SMA atlas D2-8: «Demotion instead of forgetting», «Episode layer», «Real miss into the gold set»). Pure parts: the words
 * a query is matched by, the score of a text against them, and the lines the PM reads.
 */
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "что", "как", "для", "это", "при", "или"]);

/** The words of a query worth matching: four letters or more, no stop words, at most twelve. */
export function queryWords(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_./-]{4,}/gu) ?? []).filter((word) => !STOP.has(word)))].slice(0, 12);
}

/** How many of the words a text holds. */
export function wordHits(text: string, words: readonly string[]): number {
  const lower = text.toLowerCase();
  return words.filter((word) => lower.includes(word)).length;
}

/** The fewest words a cold note or an episode must hold to count: two, or one for a one-word query. */
export const minHits = (words: readonly string[]) => Math.min(2, words.length);

export type Episode = { taskId: string; title: string; state: string; reason: string | null; at: number };

/** The PM's lines for past tasks like this one: what was done and how it ended. */
export function episodeLines(episodes: readonly Episode[]): string {
  if (!episodes.length) return "";
  return ["Past tasks like this one (what happened):", ...episodes.map((row) => `- ${row.taskId} «${row.title}» (${new Date(row.at).toISOString().slice(0, 10)}): ${row.state}${row.reason ? ` — ${row.reason.replace(/\s+/g, " ").slice(0, 160)}` : ""}`)].join("\n");
}
