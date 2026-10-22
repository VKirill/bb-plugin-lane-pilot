import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../core/server";
import { attemptMetrics } from "../attempt-metrics";
import { attachTokenUsage, queryTokenUsage } from "../token-usage";

export function tokenUsageRpc(ctx: ServerCore) {
  const sync = attachTokenUsage(ctx);
  return {
    token_usage: ({ range, month, projectId }) => queryTokenUsage(ctx, { range, month, projectId }),
    lp_attempt_metrics: async ({ projectId, days }) => attemptMetrics(ctx.db, { projectId, days }),
    token_usage_sync: async () => ({ started: sync.start(90) }),
    token_usage_rebuild: async () => sync.rebuild(90),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "token_usage" | "lp_attempt_metrics" | "token_usage_sync" | "token_usage_rebuild">;
}
