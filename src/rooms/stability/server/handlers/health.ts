import { z } from "zod";
import { bindRunChildBudget, registerObservedTool, requirePmRun, type ServerContext } from "../../../platform/server";
import { getRun, getRunSettingsScopes, loadProjectSettings } from "../../../storage";
import { runHealth, type HealthServices } from "../services/health";

export function mountHealth(ctx: ServerContext, services: HealthServices): void {
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
