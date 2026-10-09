import { rpcContract } from "../../contracts";
import type { ServerCore } from "./core";
import type { Services } from "./services";
import { preferencesRpc } from "../../settings/server";
import { runsRpc } from "../../runs/server";
import { settingsRpc } from "../../settings/server";
import { selectionsRpc } from "../../settings/server";
import { stackRpc } from "../../native-install/server";
import { insightsRpc } from "../../self-repair/server";
import { secretsRpc } from "../../secrets/server";
import { workspaceProviderRpc } from "../../native-agent/server";
import { tokenUsageRpc } from "../../usage/server";
import { workflowsRpc } from "../../workflow/server";
import { workflowOpsRpc } from "../../workflow/server";
import { schedulesRpc } from "../../schedule/server";
import { councilRpc } from "../../council/server";
import { selfRepairRpc } from "../../self-repair/server";
import { canaryRpc } from "../../stability/server";
import { sessionMemoryRpc } from "../../memory/server";
import { createWorkflowArchitect } from "../../workflow/server";
import { architectStartRpc } from "../../workflow/server";
import { timeRpcHandlers } from "./rpc-timing";
import { anamnesisFor } from "../../anamnesis";
import { worldRpc } from "../../world/server";

/** One handler object from the five groups; each group carries the exact contract keys it implements. */
export function registerRpc(ctx: ServerCore, services: Services) {
  // Every call is timed (rpc-timing.ts). No caller check: every machine and every caller is the owner's (owner decision 2026-10-08).
  ctx.bb.rpc.register(rpcContract, timeRpcHandlers({
    ...preferencesRpc(ctx, services),
    ...runsRpc(ctx, services),
    ...settingsRpc(ctx, services),
    ...selectionsRpc(ctx, services),
    ...stackRpc(ctx),
    ...insightsRpc(ctx, services),
    ...tokenUsageRpc(ctx),
    ...secretsRpc(ctx),
    ...workspaceProviderRpc(ctx),
    ...workflowsRpc(ctx, services),
    ...workflowOpsRpc(ctx, services),
    ...schedulesRpc(ctx, services),
    ...councilRpc(ctx.db, services.council),
    ...selfRepairRpc(ctx),
    ...canaryRpc(services.canary),
    ...sessionMemoryRpc(ctx, services),
    ...createWorkflowArchitect(ctx, services).rpc,
    ...architectStartRpc(ctx, services),
    ...anamnesisFor(ctx).rpc,
    ...worldRpc(services.world),
  }, (message) => ctx.bb.log.debug(message)));
}
