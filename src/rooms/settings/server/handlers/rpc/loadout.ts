import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../../contracts";
import type { ServerCore } from "../../../../contracts/server";
import { agentLoadout } from "../../services/agent-loadout";

/** RPC handler for `agent_loadout`: effective per-role loadout at system/project/section scope. */
export function loadoutRpc(ctx: ServerCore) {
  return {
    agent_loadout: (input) => agentLoadout(ctx, input),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "agent_loadout">;
}
