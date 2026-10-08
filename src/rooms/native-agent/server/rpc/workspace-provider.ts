import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../contracts";
import { HARNESS_VERSION } from "../../../storage";
import { createProviderGate } from "../../../verification";
import type { ServerCore } from "../../../core/server";

/** The per-machine switch-off of the worktree provider (state lives in the plugin's KV, so a gate of its own reads the same record). */
export function workspaceProviderRpc(ctx: ServerCore) {
  const gate = () => createProviderGate({ kv: ctx.bb.storage.kv, serialized: (work) => ctx.serializedKv(work), version: HARNESS_VERSION, warn: (message) => ctx.bb.log.warn(message) });
  return {
    workspace_provider_status: async () => ({ hosts: await gate().hosts() }),
    workspace_provider_reset: async ({ hostId }) => ({ cleared: await gate().reset(hostId) }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "workspace_provider_status" | "workspace_provider_reset">;
}
