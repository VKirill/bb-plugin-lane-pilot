import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { RollbackApi } from "./rollback";

/** Reverify and revert over RPC, the same calls as the CLI; `task_changes` reads what is on record. */
export function rollbackRpc(rollback: RollbackApi) {
  return {
    task_reverify: async ({ ref }) => await rollback.reverify(ref),
    task_revert: async ({ ref, dryRun, skipGate }) => await rollback.revert(ref, { dryRun, skipGate }),
    task_changes: async ({ ref }) => rollback.status(ref),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "task_reverify" | "task_revert" | "task_changes">;
}
