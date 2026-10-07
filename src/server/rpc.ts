import { rpcContract } from "../contracts";
import type { ServerCore } from "./core";
import type { Services } from "./services";
import { preferencesRpc } from "./rpc/preferences";
import { runsRpc } from "./rpc/runs";
import { settingsRpc } from "./rpc/settings";
import { selectionsRpc } from "./rpc/selections";
import { stackRpc } from "./rpc/stack";
import { insightsRpc } from "./rpc/insights";
import { tokenUsageRpc } from "./rpc/token-usage";
import { councilRpc } from "./council";
import { selfRepairRpc } from "./self-repair";
import { canaryRpc } from "./canary";
import { sessionMemoryRpc } from "./session-memory";

/** One handler object from the five groups; each group carries the exact contract keys it implements. */
export function registerRpc(ctx: ServerCore, services: Services) {
  ctx.bb.rpc.register(rpcContract, {
    ...preferencesRpc(ctx, services),
    ...runsRpc(ctx, services),
    ...settingsRpc(ctx, services),
    ...selectionsRpc(ctx, services),
    ...stackRpc(ctx),
    ...insightsRpc(ctx, services),
    ...tokenUsageRpc(ctx),
    ...councilRpc(ctx.db, services.council),
    ...selfRepairRpc(ctx),
    ...canaryRpc(services.canary),
    ...sessionMemoryRpc(ctx, services),
  });
}
