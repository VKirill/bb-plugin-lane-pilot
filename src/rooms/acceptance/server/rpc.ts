import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { LanePilotDatabase } from "../../storage";
import { buildAcceptanceCard } from "../card";

/** The acceptance card of a task, read from the records the pipeline already keeps. */
export function acceptanceRpc(db: LanePilotDatabase) {
  return {
    task_acceptance_card: async ({ runId, taskId }) => buildAcceptanceCard(db, { runId, taskId }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "task_acceptance_card">;
}
