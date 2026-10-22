import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { StageReturnApi } from "./stage-return";

/** Return to an earlier stage over RPC, the same call as the CLI and the button in the task card. */
export function stageReturnRpc(stageReturn: StageReturnApi) {
  return {
    task_return_stage: async ({ ref, to, note, by }) => await stageReturn.returnTask({ ref, to, note, ...(by ? { by } : {}) }),
    task_returns: async ({ ref }) => stageReturn.status(ref),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "task_return_stage" | "task_returns">;
}
