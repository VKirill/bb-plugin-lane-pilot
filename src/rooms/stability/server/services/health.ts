import { RUN_BUDGET_EXCEEDED_PREFIX } from "@lane-pilot/resilience";
import { wayOut } from "../../../contracts";
import type { WriterStateApi } from "../../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface HealthServices {
  providerBreaker: WriterStateApi["providerBreaker"];
  runBudgetFor: WriterStateApi["runBudgetFor"];
  runBudgets: WriterStateApi["runBudgets"];
}

/** What the breaker and the budget of a run say right now; the PM reads it before dispatching more work. */
export function runHealth(services: HealthServices, runId: string) {
  const budget = services.runBudgets.get(runId);
  if (!budget) return { runId, budget: null, providers: services.providerBreaker.snapshot() };
  const snapshot = budget.snapshot();
  const check = budget.check();
  return {
    runId,
    budget: {
      ...snapshot,
      childThreads: { used: snapshot.children, limit: snapshot.limits.maxChildren ?? null },
      check,
    },
    ...(!check.ok ? { next: wayOut("blocked", `${RUN_BUDGET_EXCEEDED_PREFIX}${check.exceeded}`) ?? undefined } : {}),
    providers: services.providerBreaker.snapshot(),
  };
}
