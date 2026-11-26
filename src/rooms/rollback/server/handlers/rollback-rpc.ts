import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { RollbackApi } from "../services/rollback";

/** Diff over RPC, the same read as the UI task card. */
export function rollbackRpc(rollback: RollbackApi) {
  return {
    task_diff: async ({ ref }) => await rollback.diff(ref),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "task_diff">;
}
