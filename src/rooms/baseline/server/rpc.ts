import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { BaselineApi } from "./baseline";
import type { RegressionApi } from "./regress";

/** The baseline of a task and the regression pass over RPC, the same calls as the CLI. */
export function baselineRpc(baseline: BaselineApi, regression: RegressionApi) {
  return {
    baseline_status: async ({ taskId }) => ({ taskId, baselines: baseline.status(taskId) }),
    regress_run: async (input) => await regression.run(input),
    regress_list: async ({ projectId, all }) => regression.list({ projectId, all }),
    regress_close: async ({ id, reason }) => regression.close(id, reason),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "baseline_status" | "regress_run" | "regress_list" | "regress_close">;
}
