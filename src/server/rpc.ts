import { rpcContract } from "../contracts";
import type { ServerCore } from "./core";
import type { Services } from "./services";
import { preferencesRpc } from "./rpc/preferences";
import { runsRpc } from "./rpc/runs";
import { settingsRpc } from "./rpc/settings";
import { selectionsRpc } from "./rpc/selections";
import { stackRpc } from "./rpc/stack";

/** One handler object from the five groups; each group carries the exact contract keys it implements. */
export function registerRpc(ctx: ServerCore, services: Services) {
  ctx.bb.rpc.register(rpcContract, {
    ...preferencesRpc(ctx, services),
    ...runsRpc(ctx, services),
    ...settingsRpc(ctx, services),
    ...selectionsRpc(ctx, services),
    ...stackRpc(ctx),
  });
}
