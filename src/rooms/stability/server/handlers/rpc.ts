import packageJson from "../../../../../package.json";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";

const VERSION: string = packageJson.version;

/** Deploy drain status and control RPCs owned by stability. */
export function stabilityRpc(ctx: ServerCore) {
  return {
    deploy_drain: async ({ on }) => ({ version: VERSION, ...ctx.deployDrain.set(on) }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "deploy_drain">;
}
