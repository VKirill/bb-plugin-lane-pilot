import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { listProjectSecretIssuance } from "../services/secret-issuance-service";

/** RPC handlers for inspecting Env Catalog secret issuance in a project. */
export function secretsRpc(ctx: ServerCore) {
  return {
    secret_issuance: ({ projectId, limit }) => ({ entries: listProjectSecretIssuance(ctx.db, projectId, limit ?? 100) }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "secret_issuance">;
}
