import { createProviderBreaker, createRunBudget, parseRunBudgetLimits, type RunBudget } from "@lane-pilot/resilience";
import { RunWriterPool } from "../../tasks";
import { createProviderUsage, usageSkipPercent } from "../../usage/server";
import { createProviderRetryGuard } from "../../stability/server";
import { createConcurrencyLimit } from "./concurrency-limit";
import { registerSpawnUsage } from "../../core/server";
import type { ServerCore } from "../../core/server";

/** State shared by the writer modules: the live task set, the provider pool, the provider breaker and one budget per run. */
export function createWriterState(ctx: ServerCore) {
  const activeWriterTasks = new Set<string>();

  const runWriterPool = new RunWriterPool();

  /** Opens for a provider/model after repeated provider failures; poor work never trips it. */
  const providerBreaker = createProviderBreaker();

  /** Provider usage windows read from BB's usage sources; a writer pair whose window is nearly spent is skipped, never failed. */
  const providerUsage = createProviderUsage(ctx.bb);
  // The helpers' resolver (resolveSpawnModel) reads the same cache, under the same threshold, to move a table pick off a nearly spent provider.
  // Gemini through 9router runs on OpenCode v2 (`opencode2`); a usage source may list its quota under the router's own id (`router9`), so both are read.
  const viaRouter = (providerId: string, model: string) => providerId === "opencode2" && model.startsWith("router9/");
  registerSpawnUsage(ctx.bb, {
    peek: (query) => {
      const base = { model: query.model, hostId: query.hostId ?? "", threshold: usageSkipPercent(query.settings) };
      return providerUsage.peek({ ...base, providerId: query.providerId }) ?? (viaRouter(query.providerId, query.model) ? providerUsage.peek({ ...base, providerId: "router9" }) : null);
    },
    warm: (query) => providerUsage.warm({ providerIds: query.providerIds.includes("opencode2") ? [...query.providerIds, "router9"] : query.providerIds, hostId: query.hostId ?? "" }),
  });

  /** Cancels the retry BB's provider-retry queued in a writer thread once the task moved on to another writer. */
  const providerRetry = createProviderRetryGuard(ctx.bb);

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

  return { activeWriterTasks, runWriterPool, providerBreaker, providerUsage, providerRetry, concurrencyLimit, runBudgets, runBudgetFor };
}
