import { jev } from "@lane-pilot/jev";
import { MAX_PASSAGES, memoryRerankJudgment } from "@lane-pilot/jev/judgments/memory-rerank";

/**
 * M4: the query paths' last step. Words give the shortlist (search + relevance floor); Jev's `memory.rerank` answers for each of the
 * first MAX_PASSAGES whether it actually helps with the question, and in active mode only the kept ones are delivered — so a
 * question the notes cannot answer gets an honest «nothing». With the meaning search in front (hub copy 2026-11-06, 150 questions with an
 * answer and 228 without): 96.7% answered and 96.1% silent at keep_p 0.8; the words-only shortlist reached 26/30 and 10/10 on the hand set. Shadow, off, no Jev or a failed call: the word order stands untouched.
 */
/**
 * A meaning search whose best record is this close to the question answers without Jev (hub copy 2026-11-06: 17% of the questions with
 * an answer, under 1% of those without one). Below it Jev decides what helps — words and cosine alone cannot tell «close» from «answers».
 */
export const SURE_SIMILARITY = 0.82;

export async function rerankRecords<T extends { content: string; similarity?: number }>(records: readonly T[], query: string,
  ctx: { projectId: string; runId?: string | null; settings: Record<string, unknown> }): Promise<T[]> {
  const judge = jev();
  if (!judge || !records.length || !judge.enabled(ctx.settings as never)) return [...records];
  if ((records[0]!.similarity ?? 0) >= SURE_SIMILARITY) return [...records];
  const head = records.slice(0, MAX_PASSAGES);
  const verdict = await judge.judge(memoryRerankJudgment, { query, passages: head.map((record) => record.content) },
    { projectId: ctx.projectId, ...(ctx.runId ? { runId: ctx.runId } : {}), settings: ctx.settings as never }).catch(() => null);
  if (verdict?.by !== "jev") return [...records];
  return verdict.decision.keep.map((index) => head[index]!);
}
