import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { CapabilitiesApi } from "./capability";

/** The capability table over RPC. */
export function capabilityRpc(api: CapabilitiesApi) {
  return {
    capability_table: async () => await api.table(),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "capability_table">;
}
