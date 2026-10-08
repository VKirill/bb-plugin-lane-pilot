import { rpcContract } from "../contracts";
import type { ServerCore } from "./core";
import type { Services } from "./services";
import { preferencesRpc } from "../rooms/settings/server/rpc/preferences";
import { runsRpc } from "./rpc/runs";
import { settingsRpc } from "../rooms/settings/server/rpc/settings";
import { selectionsRpc } from "../rooms/settings/server/rpc/selections";
import { stackRpc } from "../rooms/native-install/server/rpc/stack";
import { insightsRpc } from "../rooms/self-repair/server/rpc/insights";
import { secretsRpc } from "../rooms/secrets/server/rpc/secrets";
import { workspaceProviderRpc } from "./rpc/workspace-provider";
import { tokenUsageRpc } from "../rooms/usage/server/rpc/token-usage";
import { workflowsRpc } from "../rooms/workflow/server/rpc/workflows";
import { workflowOpsRpc } from "../rooms/workflow/server/rpc/workflow-ops";
import { schedulesRpc } from "../rooms/schedule/server/rpc/schedules";
import { councilRpc } from "../rooms/council/server/council";
import { selfRepairRpc } from "../rooms/self-repair/server/self-repair";
import { canaryRpc } from "../rooms/stability/server/canary";
import { sessionMemoryRpc } from "../rooms/memory/server/session-memory";
import { createWorkflowArchitect } from "../rooms/workflow/server/workflow-architect";
import { architectStartRpc } from "../rooms/workflow/server/architect-start";
import { timeRpcHandlers } from "./rpc-timing";
import { anamnesisFor } from "../rooms/anamnesis/wiring";

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
  }, (message) => ctx.bb.log.debug(message)));
}
