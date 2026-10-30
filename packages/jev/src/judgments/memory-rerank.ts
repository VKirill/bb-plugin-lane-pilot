import { defineJudgment, noul, noulOf } from "../registry";

/**
 * Re-ranks the memory layer's lexical shortlist (B6; the rerank and classifying_rag_passages cookbooks). `episodes()`
 * scores by shared words; Jev answers for each candidate whether it actually helps the PM's query. One request, up to
 * `MAX_PASSAGES` nouls. Shadow by default: the receipt shows what Jev would have picked, the caller keeps word order.
 */
export const MEMORY_RERANK_ID = "memory.rerank";
export const MAX_PASSAGES = 8;

export type RerankInput = { query: string; passages: string[] };
export type RerankDecision = { scores: number[]; keep: number[] };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const memoryRerankJudgment = defineJudgment<RerankInput, RerankDecision>({
  id: MEMORY_RERANK_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 10_000,
  stateBuilder: (input) => ({
    query: clip(input.query, 800),
    passages: Object.fromEntries(input.passages.slice(0, MAX_PASSAGES).map((text, i) => [`p${i}`, clip(text, 1500)])),
  }),
  questions: (input) => Object.fromEntries(input.passages.slice(0, MAX_PASSAGES).map((_, i) => [
    `p${i}`,
    noul(`\`query\` is what the PM needs now; \`passages.p${i}\` is a note or a past task the memory search found. Does it actually help with the query — same problem, a lesson that applies, or a useful precedent — not just shared words?`,
      { true: "the passage helps with this query", false: "shared words but different problem, or irrelevant detail" }),
  ])),
  thresholds: {
    keep_p: { default: 0.5, min: 0.2, max: 0.9, about: "p(helps) a passage needs to be delivered" },
  },
  decide(answers, t, input) {
    const scores = input.passages.slice(0, MAX_PASSAGES).map((_, i) => Math.round((noulOf(answers, `p${i}`) ?? 0) * 1000) / 1000);
    return { decision: { scores, keep: scores.flatMap((p, i) => p >= t.keep_p! ? [i] : []) } };
  },
  fallback: (input) => ({ scores: input.passages.map(() => 1), keep: input.passages.map((_, i) => i) }),
  describe: (d) => `keep ${d.keep.length}/${d.scores.length}`,
});
