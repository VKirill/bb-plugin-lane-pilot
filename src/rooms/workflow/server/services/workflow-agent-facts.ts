import type { CostState } from "@lane-pilot/contracts";
import { bestEffort } from "@lane-pilot/kit";
import type { Usage } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { threadUsage } from "../../../usage/server";

/** A thread a helper step started or went on in, with the marker its own turns begin at (`since`, ms; none = from the thread's start) and the model/provider it ran on. */
export type TrackedThread = { id: string; since?: number; model?: string; provider?: string };

export type SpentByContext = {
  requestedProvider?: string | null;
  requestedModel?: string | null;
  answeredProvider?: string | null;
  answeredModel?: string | null;
};

/**
 * What the threads of a step spent, summed: tokens, separated cache/uncached counts, requested vs answered model/provider,
 * and model-prices-only cost state across all threads a step touched.
 */
export async function spentBy(
  bb: ServerCore["bb"],
  threads: readonly TrackedThread[],
  ctx: SpentByContext = {},
): Promise<Usage & { tokens: number; costUsd: number; unknown?: true }> {
  const rows = await Promise.all(threads.map((thread) =>
    bestEffort(
      bb.log,
      "workflow helper usage",
      threadUsage(bb, thread.id, {
        ...(thread.since !== undefined ? { since: thread.since } : {}),
        ...(thread.model ? { fallbackModel: thread.model } : {}),
        ...(thread.provider ? { fallbackProvider: thread.provider } : {}),
      }),
      null,
    )));
  const blind = rows.some((row) => !row || !row.known);
  const measuredRows = rows.filter((row): row is NonNullable<typeof row> => Boolean(row && row.known));
  const lastRow = [...rows].reverse().find((row) => Boolean(row)) ?? null;
  const firstRow = rows.find((row) => Boolean(row)) ?? null;
  const lastThread = threads.at(-1) ?? null;

  const requestedProvider = firstRow?.requestedProvider ?? ctx.requestedProvider ?? null;
  const requestedModel = firstRow?.requestedModel ?? ctx.requestedModel ?? null;
  const answeredProvider = lastRow?.answeredProvider ?? lastThread?.provider ?? ctx.answeredProvider ?? null;
  const answeredModel = lastRow?.answeredModel ?? lastThread?.model ?? ctx.answeredModel ?? null;

  let costState: CostState;
  if (blind) {
    costState = measuredRows.some((row) => row.costState === "measured" || row.costState === "partial")
      ? "partial"
      : "not_measured";
  } else if (measuredRows.length === 0) {
    costState = "not_measured";
  } else if (measuredRows.every((row) => row.costState === "measured")) {
    costState = "measured";
  } else if (measuredRows.some((row) => row.costState === "measured" || row.costState === "partial")) {
    costState = "partial";
  } else {
    costState = "not_measured";
  }

  return {
    tokens: rows.reduce((sum, row) => sum + (row?.tokens ?? 0), 0),
    costUsd: rows.reduce((sum, row) => sum + (row?.costUsd ?? 0), 0),
    ...(blind ? { unknown: true as const } : {}),
    inputTokens: rows.reduce((sum, row) => sum + (row?.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (row?.outputTokens ?? 0), 0),
    cacheReadTokens: rows.reduce((sum, row) => sum + (row?.cacheReadTokens ?? 0), 0),
    cacheWriteTokens: rows.reduce((sum, row) => sum + (row?.cacheWriteTokens ?? 0), 0),
    requestedProvider,
    requestedModel,
    answeredProvider,
    answeredModel,
    costState,
    requestId: lastRow?.requestId ?? null,
    sessionId: lastThread?.id ?? null,
  };
}
