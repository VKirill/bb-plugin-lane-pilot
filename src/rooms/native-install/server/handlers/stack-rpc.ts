import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import {
  connectProjectStack,
  detectProjectStack,
  installProjectStack,
  removeClaudeLeftovers,
  rollbackProjectStack,
} from "../services/stack-service";

export function stackRpc(ctx: ServerCore) {
  return {
    remove_claude_lane_leftovers: async ({ hostId, apply }) => removeClaudeLeftovers(ctx, hostId, apply),
    stack_detect: async ({ projectId }) => detectProjectStack(ctx, projectId),
    stack_install: async ({ projectId, confirmExternalOps }) => installProjectStack(ctx, projectId, confirmExternalOps),
    stack_connect: async ({ projectId, confirmExternalOps }) => connectProjectStack(ctx, projectId, confirmExternalOps),
    stack_rollback: async ({ projectId, snapshotPath }) => rollbackProjectStack(ctx, projectId, snapshotPath),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "remove_claude_lane_leftovers" | "stack_detect" | "stack_install" | "stack_connect" | "stack_rollback">;
}
