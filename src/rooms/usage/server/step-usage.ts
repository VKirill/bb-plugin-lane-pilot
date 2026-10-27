import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { threadUsage } from "./token-usage";

/** What a step of a graph run spent, in the shape the workflow engine adds to the run (`lane_pilot_wf_run.tokens_used`, `cost_micro_usd`). */
export type StepUsage = { tokens: number; costUsd: number; unknown?: true };

/** A thread read for the turns of one step only: from `since` (ms, none = the thread's start) up to `until` (ms, exclusive; none = its end). */
export type UsageWindow = { id: string; since?: number; until?: number };

/**
 * For a wrapper executor that runs a legacy function which spawns its own helper thread: after the function ends, name the thread(s)
 * and get what they spent, as the two fields a step result carries (`usage`, `threadId`). The engine adds the usage to the run, so a
 * token or money budget sees the cost of wrapped work. Nothing named (a stage that spawned no thread) gives `{}`; a thread whose
 * provider reports no usage marks the usage `unknown` (the budget then holds the run to a time and step limit) instead of counting it free.
 * A thread named by id is read whole; one named with a window is read for the turns of that window only (a sticky writer's thread carries
 * the turns of several tasks, and each task is charged its own). Never throws: a failing usage lookup must not fail the step.
 */
export async function withUsage(bb: BbPluginApi, threads: string | UsageWindow | null | undefined | ReadonlyArray<string | UsageWindow | null | undefined>): Promise<{ usage?: StepUsage; threadId?: string }> {
  const listed = (Array.isArray(threads) ? threads : [threads]) as ReadonlyArray<string | UsageWindow | null | undefined>;
  const windows = new Map<string, UsageWindow>();
  for (const entry of listed) {
    const window = typeof entry === "string" ? { id: entry } : entry;
    if (window && typeof window.id === "string" && window.id !== "") windows.set(`${window.id}|${window.since ?? ""}|${window.until ?? ""}`, window);
  }
  if (!windows.size) return {};
  const spent = await Promise.all([...windows.values()].map((window) => threadUsage(bb, window.id, { ...(window.since !== undefined ? { since: window.since } : {}), ...(window.until !== undefined ? { until: window.until } : {}) }).catch(() => null)));
  const blind = spent.some((row) => !row || !row.known || row.unknown);
  return {
    usage: { tokens: spent.reduce((sum, row) => sum + (row?.tokens ?? 0), 0), costUsd: spent.reduce((sum, row) => sum + (row?.costUsd ?? 0), 0), ...(blind ? { unknown: true as const } : {}) },
    threadId: [...windows.values()][0]!.id,
  };
}
