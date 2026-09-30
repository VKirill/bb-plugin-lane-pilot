import { createProviderBreaker, createRunBudget, parseRunBudgetLimits, type RunBudget } from "@lane-pilot/resilience";
import { RunWriterPool } from "../../stages/run-policy";
import type { ServerCore } from "../core";

/** State shared by the writer modules: the live task set, the provider pool, the provider breaker and one budget per run. */
export function createWriterState(ctx: ServerCore) {
  const activeWriterTasks = new Set<string>();

  const runWriterPool = new RunWriterPool();

  /** Opens for a provider/model after repeated provider failures; poor work never trips it. */
  const providerBreaker = createProviderBreaker();

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

  return { activeWriterTasks, runWriterPool, providerBreaker, runBudgets, runBudgetFor };
}
