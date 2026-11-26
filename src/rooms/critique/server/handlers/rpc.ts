import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { criticStats } from "../services/critic-stats";

/** Critic statistics RPC owned by critique. */
export function critiqueRpc(ctx: ServerCore) {
  return {
    critic_stats: async ({ projectId, days }) => ({ days, stats: criticStats(ctx.db, projectId, Date.now() - days * 86400_000) }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "critic_stats">;
}
