import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import { repoTrust, type RepoTrustCtx, type RepoTrustDeps } from "../services/repo-trust";

/** Console RPC handler for `repo_trust`. */
export function repoTrustRpc(ctx: RepoTrustCtx, deps: RepoTrustDeps = {}) {
  return {
    repo_trust: async (input) => repoTrust(ctx, input, deps),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "repo_trust">;
}
