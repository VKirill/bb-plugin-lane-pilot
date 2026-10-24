import { rpcContract } from "../../contracts";
import type { ServerCore } from "./core";
import type { Services } from "./services";
import { preferencesRpc } from "../../settings/server";
import { runsRpc } from "../../runs/server";
import { settingsRpc } from "../../settings/server";
import { selectionsRpc } from "../../settings/server";
import { stackRpc } from "../../native-install/server";
import { insightsRpc } from "../../self-repair/server";
import { jevProviderRpc, secretsRpc } from "../../secrets/server";
import { workspaceProviderRpc } from "../../native-agent/server";
import { tokenUsageRpc } from "../../usage/server";
import { workflowsRpc } from "../../workflow/server";
import { workflowOpsRpc } from "../../workflow/server";
import { schedulesRpc } from "../../schedule/server";
import { councilRpc } from "../../council/server";
import { selfRepairRpc } from "../../self-repair/server";
import { canaryRpc } from "../../stability/server";
import { memoryProbeRpc } from "./rpc-memory-probe";
import { harnessRpc } from "../../harness/server";
import { deferralRpc } from "../../deferral/server";
import { recordTaskWord } from "../../tasks";
import { taskFamily } from "../../runs";
import { rollbackRpc } from "../../rollback/server";
import { acceptanceRpc } from "../../acceptance/server";
import { benchRpc } from "../../bench/server";
import { ownerWaitingRpc } from "../../owner-waiting/server";
import { baselineRpc } from "../../baseline/server";
import { stageReturnRpc } from "../../stage-return/server";
import { forecastRpc } from "../../forecast/server";
import { workGraphRpc } from "../../work-graph/server";
import { runGoalRpc } from "../../run-goal/server";
import { phaseRpc } from "../../phase/server";
import { worldVersion } from "../../outbound";
import { capabilityRpc } from "../../capability/server";
import { conveyorState, setConveyor } from "../../conveyor";
import { wallRpc } from "../../wall/server";
import { improvementRpc } from "../../improvement/server";
import { sessionMemoryRpc } from "../../memory/server";
import { createWorkflowArchitect } from "../../workflow/server";
import { architectStartRpc } from "../../workflow/server";
import { journalRpcHandlers, timeRpcHandlers } from "./rpc-timing";
import { anamnesisFor } from "../../anamnesis";
import { worldRpc } from "../../world/server";

/** One handler object from the five groups; each group carries the exact contract keys it implements. */
export function registerRpc(ctx: ServerCore, services: Services) {
  // Every call is timed (rpc-timing.ts). No caller check: every machine and every caller is the owner's (owner decision 2026-10-08).
  ctx.bb.rpc.register(rpcContract, journalRpcHandlers(timeRpcHandlers({
    ...preferencesRpc(ctx, services),
    ...runsRpc(ctx, services),
    ...settingsRpc(ctx, services),
    ...selectionsRpc(ctx, services),
    ...stackRpc(ctx),
    ...insightsRpc(ctx, services),
    ...tokenUsageRpc(ctx),
    ...secretsRpc(ctx),
    ...jevProviderRpc(ctx),
    ...workspaceProviderRpc(ctx),
    ...workflowsRpc(ctx, services),
    ...workflowOpsRpc(ctx, services),
    ...schedulesRpc(ctx, services),
    ...councilRpc(ctx.db, services.council),
    ...selfRepairRpc(ctx),
    ...canaryRpc(services.canary),
    ...memoryProbeRpc(services),
    ...harnessRpc(services.harness),
    ...deferralRpc(services.deferrals),
    ...rollbackRpc(services.rollback),
    ...acceptanceRpc(ctx.db),
    ...benchRpc(services.bench),
    ...ownerWaitingRpc(ctx.db),
    ...baselineRpc(services.baseline, services.regression),
    ...stageReturnRpc(services.stageReturn),
    ...forecastRpc(ctx.db),
    ...workGraphRpc(ctx),
    ...runGoalRpc(services.runGoal),
    ...phaseRpc(services.phases),
    first_run_get: async ({ projectId }: { projectId: string }) => services.front.firstRun(projectId),
    first_run_answer: async ({ projectId, step, answer }: { projectId: string; step: "goal" | "writer" | "quality" | "words"; answer: string }) => services.front.firstRunAnswer(projectId, step, answer),
    first_run_finish: async ({ projectId }: { projectId: string }) => services.front.firstRunFinish(projectId),
    helpers_list: async ({ runId }: { runId: string }) => services.front.helpers(runId),
    helpers_import: async ({ runId, names }: { runId: string; names: string[] }) => services.front.importHelpers(runId, names),
    peers_list: async () => services.front.peers(),
    coord_status: async ({ runId }: { runId: string }) => services.front.coord(runId),
    coord_clear: async ({ runId, session, reason }: { runId: string; session: string; reason: string }) => services.front.coord(runId, { session, reason }),
    door_audience: async () => services.front.doorAudience(),
    actions_recent: async ({ limit }: { limit?: number }) => services.front.actions(limit),
    task_word: async ({ runId, taskId, decision, text }: { runId: string; taskId: string; decision: "yes" | "no"; text: string }) => {
      await recordTaskWord(ctx.bb.storage.kv as never, runId, taskFamily(taskId), decision, text);
      return { ok: true as const };
    },
    world_version: async () => ({ version: worldVersion() }),
    money_status: async () => services.money.status(),
    ...capabilityRpc(services.capabilities),
    conveyor: async ({ set, reason }: { set?: "on" | "off"; reason?: string }) => set ? await setConveyor(ctx.bb.storage.kv as never, set === "on", reason) : await conveyorState(ctx.bb.storage.kv as never),
    ...wallRpc(services.wall),
    ...improvementRpc({ db: ctx.db, kv: ctx.bb.storage.kv, wall: services.wall, bench: services.bench, deferrals: services.deferrals }),
    ...sessionMemoryRpc(ctx, services),
    ...createWorkflowArchitect(ctx, services).rpc,
    ...architectStartRpc(ctx, services),
    ...anamnesisFor(ctx).rpc,
    ...worldRpc(services.world),
  }, (message) => ctx.bb.log.debug(message)), (name, input) => services.front?.journal(name, input)));
}
