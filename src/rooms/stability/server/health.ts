import { z } from "zod";
import { requirePmRun, type ServerContext } from "../../../server/context";
import { registerObservedTool } from "../../../server/tool-result";
import type { Services } from "../../../server/services";
import { bindRunChildBudget } from "../../../server/pm-spawn";
import { getRun, getRunSettingsScopes, loadProjectSettings } from "../../../database";

export const HEALTH_TOOLS = ["lane_pilot_run_health"] as const;

export const RUN_BUDGET_SETTINGS = ["run.max_attempts", "run.max_wall_minutes", "run.max_tokens", "run.max_children"] as const;

/** What the breaker and the budget of a run say right now; the PM reads it before dispatching more work. */
export function runHealth(services: Services, runId: string) {
  const budget = services.runBudgets.get(runId);
  if (!budget) return { runId, budget: null, providers: services.providerBreaker.snapshot() };
  const snapshot = budget.snapshot();
  return {
    runId,
    budget: {
      ...snapshot,
      childThreads: { used: snapshot.children, limit: snapshot.limits.maxChildren ?? null },
      check: budget.check(),
    },
    providers: services.providerBreaker.snapshot(),
  };
}

export function mountHealth(ctx: ServerContext, services: Services): void {
  bindRunChildBudget(ctx.bb, (runId) => {
    const run = getRun(ctx.db, runId);
    if (!run) return null;
    return services.runBudgetFor(runId, loadProjectSettings(ctx.db, run.project_id, getRunSettingsScopes(ctx.db, runId)));
  });
  registerObservedTool(ctx.bb.agents, {
    name: "lane_pilot_run_health",
    description: "Provider breaker state per provider/model and this run's budget (attempts, wall time, tokens, child threads) with the first exceeded limit, if any.",
    instructions: "Use from the active Lane Pilot PM thread before dispatching more writers. An open breaker means the next writer takes the next model in the writer chain (fallback 1, fallback 2, then the PM's model); an exceeded budget blocks new attempts.",
    parameters: z.object({ runId: z.string().min(1) }).strict(),
    execute: async (params, context) => {
      requirePmRun(ctx.db, { runId: params.runId, threadId: context.threadId, projectId: context.projectId });
      return JSON.stringify(runHealth(services, params.runId), null, 2);
    },
  });
}
