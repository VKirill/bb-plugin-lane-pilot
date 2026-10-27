import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { threadUsage } from "./token-usage";

/** What a step of a graph run spent, in the shape the workflow engine adds to the run (`lane_pilot_wf_run.tokens_used`, `cost_micro_usd`). */
export type StepUsage = { tokens: number; costUsd: number; unknown?: true };

/**
 * For a wrapper executor that runs a legacy function which spawns its own helper thread: after the function ends, name the thread(s)
 * and get what they spent, as the two fields a step result carries (`usage`, `threadId`). The engine adds the usage to the run, so a
 * token or money budget sees the cost of wrapped work. Nothing named (a stage that spawned no thread) gives `{}`; a thread whose
 * provider reports no usage marks the usage `unknown` (the budget then holds the run to a time and step limit) instead of counting it free.
 * Never throws: a failing usage lookup must not fail the step.
 */
export async function withUsage(bb: BbPluginApi, threads: string | null | undefined | ReadonlyArray<string | null | undefined>): Promise<{ usage?: StepUsage; threadId?: string }> {
  const ids = [...new Set((Array.isArray(threads) ? threads : [threads]).filter((id): id is string => typeof id === "string" && id !== ""))];
  if (!ids.length) return {};
  const spent = await Promise.all(ids.map((id) => threadUsage(bb, id).catch(() => null)));
  const blind = spent.some((row) => !row || !row.known || row.unknown);
  return {
    usage: { tokens: spent.reduce((sum, row) => sum + (row?.tokens ?? 0), 0), costUsd: spent.reduce((sum, row) => sum + (row?.costUsd ?? 0), 0), ...(blind ? { unknown: true as const } : {}) },
    threadId: ids[0]!,
  };
}
