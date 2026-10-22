import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { DeferralApi } from "../service";

/** The register over RPC: the deploy drill reads it (`deferral_list`), the CLI and agents write through the same checks. */
export function deferralRpc(deferrals: DeferralApi) {
  return {
    deferral_list: async ({ projectId, state, refs }) => deferrals.list({ projectId, state, refs }),
    deferral_defer: async (input) => await deferrals.defer(input),
    deferral_close: async ({ id, evidence }) => deferrals.close({ id, evidence }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "deferral_list" | "deferral_defer" | "deferral_close">;
}
