import { jev } from "@lane-pilot/jev";
import { MAX_PASSAGES, memoryRerankJudgment } from "@lane-pilot/jev/judgments/memory-rerank";

/**
 * M4: the query paths' last step. Words give the shortlist (search + relevance floor); Jev's `memory.rerank` answers for each of the
 * first MAX_PASSAGES whether it actually helps with the question, and in active mode only the kept ones are delivered — so a
 * question the notes cannot answer gets an honest «nothing» (hub copy 2026-11-06: words alone 26/30 hits, 0/10 silent; with the
 * rerank 27/30 and 10/10). Shadow, off, no Jev or a failed call: the word order stands untouched.
 */
export async function rerankRecords<T extends { content: string }>(records: readonly T[], query: string,
  ctx: { projectId: string; runId?: string | null; settings: Record<string, unknown> }): Promise<T[]> {
  const judge = jev();
  if (!judge || !records.length || !judge.enabled(ctx.settings as never)) return [...records];
  const head = records.slice(0, MAX_PASSAGES);
  const verdict = await judge.judge(memoryRerankJudgment, { query, passages: head.map((record) => record.content) },
    { projectId: ctx.projectId, ...(ctx.runId ? { runId: ctx.runId } : {}), settings: ctx.settings as never }).catch(() => null);
  if (verdict?.by !== "jev") return [...records];
  return verdict.decision.keep.map((index) => head[index]!);
}
