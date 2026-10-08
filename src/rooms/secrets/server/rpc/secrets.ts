import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../../contracts";
import { listSecretIssuance } from "../../../storage/database";
import type { ServerCore } from "../../../../server/core";

export function secretsRpc(ctx: ServerCore) {
  return {
    secret_issuance: ({ projectId, limit }) => ({ entries: listSecretIssuance(ctx.db, projectId, limit ?? 100) }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "secret_issuance">;
}
