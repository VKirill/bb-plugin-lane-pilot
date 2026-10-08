import { createProviderBreaker, createRunBudget, parseRunBudgetLimits, type RunBudget } from "@lane-pilot/resilience";
import { RunWriterPool } from "../../tasks/run-policy";
import { createProviderUsage } from "../../usage/server/provider-usage";
import { createProviderRetryGuard } from "../../stability/server/provider-retry";
import { createTasksMirror } from "../../runs/server/tasks-mirror";
import { createConcurrencyLimit } from "./concurrency-limit";
import { getRunSettingsScopes } from "../../storage/database";
import type { ServerCore } from "../../core/server/core";

/** State shared by the writer modules: the live task set, the provider pool, the provider breaker and one budget per run. */
export function createWriterState(ctx: ServerCore) {
  const activeWriterTasks = new Set<string>();

  const runWriterPool = new RunWriterPool();

  /** Opens for a provider/model after repeated provider failures; poor work never trips it. */
  const providerBreaker = createProviderBreaker();

  /** Provider usage windows read from BB's usage sources; a writer pair whose window is nearly spent is skipped, never failed. */
  const providerUsage = createProviderUsage(ctx.bb);

  /** Cancels the retry BB's provider-retry queued in a writer thread once the task moved on to another writer. */
  const providerRetry = createProviderRetryGuard(ctx.bb);

  /** Copies a project's tasks into BB Tasks when the project turns `tasks.mirror` on; writes only, never read back. */
  const tasksMirror = createTasksMirror(ctx.bb, async (projectId, runId) => (await ctx.effectiveProjectSettings(projectId, getRunSettingsScopes(ctx.db, runId))).values);

  /** BB's concurrency-limit plugin: how many writers a host may run; null without the plugin. */
  const concurrencyLimit = createConcurrencyLimit(ctx.bb);

  const runBudgets = new Map<string, RunBudget>();

  /** The budget of a run, created from its effective settings the first time a writer starts there. */
  function runBudgetFor(runId: string, settings: Record<string, unknown>): RunBudget {
    let budget = runBudgets.get(runId);
    if (!budget) {
      let limits = {};
      try { limits = parseRunBudgetLimits(settings); } catch (cause) { ctx.log(`Lane Pilot run ${runId}: budget settings ignored: ${cause instanceof Error ? cause.message : String(cause)}`); }
      budget = createRunBudget(limits);
      runBudgets.set(runId, budget);
    }
    return budget;
  }

  return { activeWriterTasks, runWriterPool, providerBreaker, providerUsage, providerRetry, tasksMirror, concurrencyLimit, runBudgets, runBudgetFor };
}
