import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { RunGoalApi } from "./run-goal";

/** The run-goal verdict over RPC, and a check by hand. */
export function runGoalRpc(api: RunGoalApi) {
  return {
    run_goal_status: async ({ runId }) => api.status(runId),
    run_goal_check: async ({ runId }) => await api.check(runId),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "run_goal_status" | "run_goal_check">;
}
