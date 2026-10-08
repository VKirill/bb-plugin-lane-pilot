import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../core/server";
import { attachTokenUsage, queryTokenUsage } from "../token-usage";

export function tokenUsageRpc(ctx: ServerCore) {
  const sync = attachTokenUsage(ctx);
  return {
    token_usage: ({ range, month, projectId }) => queryTokenUsage(ctx, { range, month, projectId }),
    token_usage_sync: async () => ({ started: sync.start(90) }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "token_usage" | "token_usage_sync">;
}
