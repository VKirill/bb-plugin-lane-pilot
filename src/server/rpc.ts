import { rpcContract } from "../contracts";
import type { ServerCore } from "./core";
import type { Services } from "./services";
import { preferencesRpc } from "./rpc/preferences";
import { runsRpc } from "./rpc/runs";
import { settingsRpc } from "./rpc/settings";
import { selectionsRpc } from "./rpc/selections";
import { stackRpc } from "./rpc/stack";
import { insightsRpc } from "./rpc/insights";
import { secretsRpc } from "./rpc/secrets";
import { workspaceProviderRpc } from "./rpc/workspace-provider";
import { tokenUsageRpc } from "./rpc/token-usage";
import { workflowsRpc } from "./rpc/workflows";
import { workflowOpsRpc } from "./rpc/workflow-ops";
import { schedulesRpc } from "./rpc/schedules";
import { councilRpc } from "./council";
import { selfRepairRpc } from "./self-repair";
import { canaryRpc } from "./canary";
import { sessionMemoryRpc } from "./session-memory";
import { createWorkflowArchitect } from "./workflow-architect";
import { architectStartRpc } from "./architect-start";
import { timeRpcHandlers } from "./rpc-timing";
import { anamnesisFor } from "../anamnesis/wiring";

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
