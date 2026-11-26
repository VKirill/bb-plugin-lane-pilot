import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../../contracts";
import type { ServerCore } from "../../../../contracts/server";
import { attemptMetrics } from "../../services/attempt-metrics";
import { queryTokenUsage } from "../../services/token-usage";
import { attachTokenUsage } from "../token-usage-events";

export function tokenUsageRpc(ctx: ServerCore) {
  const sync = attachTokenUsage(ctx);
  return {
    token_usage: ({ range, month, projectId }) => queryTokenUsage(ctx, { range, month, projectId }),
    lp_attempt_metrics: async ({ projectId, days }) => attemptMetrics(ctx.db, { projectId, days }),
    token_usage_sync: async () => ({ started: sync.start(90) }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "token_usage" | "lp_attempt_metrics" | "token_usage_sync">;
}
