import { rpcContract } from "../../contracts";
import type { ServerCore } from "./core";
import type { Services } from "./services";
import { preferencesRpc } from "../../settings/server/rpc/preferences";
import { runsRpc } from "../../runs/server/rpc/runs";
import { settingsRpc } from "../../settings/server/rpc/settings";
import { selectionsRpc } from "../../settings/server/rpc/selections";
import { stackRpc } from "../../native-install/server/rpc/stack";
import { insightsRpc } from "../../self-repair/server/rpc/insights";
import { secretsRpc } from "../../secrets/server/rpc/secrets";
import { workspaceProviderRpc } from "../../native-agent/server/rpc/workspace-provider";
import { tokenUsageRpc } from "../../usage/server/rpc/token-usage";
import { workflowsRpc } from "../../workflow/server/rpc/workflows";
import { workflowOpsRpc } from "../../workflow/server/rpc/workflow-ops";
import { schedulesRpc } from "../../schedule/server/rpc/schedules";
import { councilRpc } from "../../council/server/council";
import { selfRepairRpc } from "../../self-repair/server/self-repair";
import { canaryRpc } from "../../stability/server/canary";
import { sessionMemoryRpc } from "../../memory/server/session-memory";
import { createWorkflowArchitect } from "../../workflow/server/workflow-architect";
import { architectStartRpc } from "../../workflow/server/architect-start";
import { timeRpcHandlers } from "./rpc-timing";
import { anamnesisFor } from "../../anamnesis/wiring";

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
