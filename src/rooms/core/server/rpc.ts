import type { rpcContract } from "./plugin-contracts";
import type { ServerCore } from "../../contracts/server";

import { preferencesRpc } from "../../settings/server";
import { runsRpc } from "../../runs/server";
import { settingsRpc } from "../../settings/server";
import { selectionsRpc, roleModelsRpc } from "../../settings/server";
import { stackRpc } from "../../native-install/server";
import { insightsRpc } from "../../self-repair/server";
import { jevProviderRpc, secretsRpc } from "../../secrets/server";
import { workspaceProviderRpc } from "../../native-agent/server";
import { chatAgentRpc } from "./rpc-chat-agent";
import { tokenUsageRpc } from "../../usage/server";
import { workflowExportRpc, workflowsRpc } from "../../workflow/server";
import { workflowOpsRpc } from "../../workflow/server";
import { schedulesRpc } from "../../schedule/server";
import { councilRpc } from "../../council/server";
import { selfRepairRpc } from "../../self-repair/server";
import { canaryRpc } from "../../stability/server";
import { memoryProbeRpc } from "./rpc-memory-probe";
import { harnessRpc } from "../../harness/server";
import { deferralRpc } from "../../deferral/server";
import { cockpitRpc } from "../../cockpit";
import { recordTaskWord, waitingAttemptId } from "../../tasks";
import type { TaskWordPort } from "../../contracts";
import { taskFamily } from "@lane-pilot/contracts";
import { rollbackRpc } from "../../rollback/server";
import { acceptanceRpc } from "../../acceptance/server";
import { benchRpc } from "../../bench/server";
import { ownerWaitingRpc } from "../../owner-waiting/server";
import type { LearningItemsReader } from "../../owner-waiting";
import { writerQuestionSweep, budgetSpentSweep } from "../../writer/server";
import { runGoalSweep } from "../../run-goal/server";
import { phaseWordSweep } from "../../phase/server";
import { scheduleFailureSweep } from "../../schedule/server";
import { backlogRpc } from "../../backlog/server";
import { leadRpc } from "../../lead/server";
import { errandsRpc } from "../../errands/server";
import { baselineRpc } from "../../baseline/server";
import { stageReturnRpc } from "../../stage-return/server";
import { forecastRpc } from "../../forecast/server";
import { workGraphRpc } from "../../work-graph/server";
import { tokenCursorRow } from "../../usage/server";
import type { TokenCursorReader } from "../../work-graph/server";
import { runGoalRpc } from "../../run-goal/server";
import { phaseRpc } from "../../phase/server";
import { worldVersion } from "../../relay/server";
import { capabilityRpc } from "../../capability/server";
import { conveyorState, setConveyor } from "../../runs";
import { wallRpc } from "../../wall/server";
import { improvementRpc } from "../../improvement/server";
import { sessionMemoryRpc, type WallThreadReader } from "../../memory/server";
import { createWorkflowArchitect } from "../../workflow/server";
import { architectStartRpc } from "../../workflow/server";
import { selfRepairDeps } from "../../self-repair/server";
import { journalRpcHandlers, timeRpcHandlers } from "./rpc-timing";
import { anamnesisFor } from "../../anamnesis";
import { learningFor } from "../../learning";
import { worldRpc } from "../../world/server";

import type { BacklogApi } from "../../backlog/server/scanner";
import type { BaselineApi } from "../../baseline/server/baseline";
import type { RegressionApi } from "../../baseline/server/regress";
import type { BenchApi } from "../../bench/service";
import type { CapabilitiesApi } from "../../capability/server/capability";
import type { CouncilApi } from "../../council/server/council";
import type { DeferralApi } from "../../deferral/service";
import type { FrontApi } from "../../front/server/index";
import type { HarnessApi } from "../../harness/server/harness";
import type { LeadApi } from "../../lead/server/service";
import type { MoneyApi } from "../../money/server";
import type { PhaseApi } from "../../phase/server/driver";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { RunGoalApi } from "../../run-goal/server/run-goal";
import type { Canary } from "../../stability/server/canary";
import type { StageReturnApi } from "../../stage-return/server/stage-return";
import type { WallApi } from "../../wall/service";
import type { WorldApi } from "../../world/server/service";

import type { InsightsApi, LaneProjectNotice, ScheduleAgentApi } from "../../contracts";
import type { DocsNightlyApi } from "../../docs/server/docs-nightly";
import type { MemoryProbeApi } from "../../memory-probe/server/memory-probe";
import type { MemoryConflictsApi } from "../../memory/server/memory-conflicts";
import type { ActivationApi, AgentOpsApi } from "../../contracts/agent-ops";
import type { ScheduleService } from "../../schedule/server/schedule-service";
import type { RuleScanApi } from "../../self-repair/server/rule-scan";
import type { ReconcileApi } from "../../stability/server/reconcile";
import type { BuildCliInvocation, DispatchWriter, WorkflowEngineApi, WorkflowTriggersApi, WriterHostApi } from "../../platform/server";
import type { WriterStateApi } from "../../writer/server";

import type { StabilityPort } from "../../contracts";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  tokenCursorRow: TokenCursorReader;
  dispatchWriter: DispatchWriter;
  activate: ActivationApi["activate"];
  placeEmployeeOn: AgentOpsApi["placeEmployeeOn"];
  storeNativeSelection: AgentOpsApi["storeNativeSelection"];
  compileEffectiveMainAgent: AgentOpsApi["compileEffectiveMainAgent"];
  detectCompiledMainAgentCapability: AgentOpsApi["detectCompiledMainAgentCapability"];
  pendingSwitch: AgentOpsApi["pendingSwitch"];
  backlog: BacklogApi;
  baseline: BaselineApi;
  bench: BenchApi;
  canary: Canary;
  capabilities: CapabilitiesApi;
  council: CouncilApi;
  deferrals: DeferralApi;
  buildCliInvocation: BuildCliInvocation;
  docsLastRead: DocsNightlyApi["docsLastRead"];
  docsPlaceStatus: DocsNightlyApi["docsPlaceStatus"];
  docsPlaces: DocsNightlyApi["docsPlaces"];
  front: FrontApi;
  harness: HarnessApi;
  lead: LeadApi;
  listedAgentProfiles: WriterHostApi["listedAgentProfiles"];
  memoryConflicts: MemoryConflictsApi;
  memoryProbe: MemoryProbeApi;
  ownerLearningItems: LearningItemsReader;
  wallThreadReader: WallThreadReader;
  money: MoneyApi;
  phases: PhaseApi;
  phaseIntake: { dispatchRefusal(threadId: string): Promise<string | null> };
  regression: RegressionApi;
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  resumeOrphans: ReconcileApi["resumeOrphans"];
  rollback: RollbackApi;
  ruleScan: RuleScanApi;
  runBudgetFor?: WriterStateApi["runBudgetFor"];
  taskWords: TaskWordPort;
  insights: InsightsApi;
  laneProject: LaneProjectNotice;
  scheduleAgents: ScheduleAgentApi;
  runGoal: RunGoalApi;
  schedules: ScheduleService;
  selectionCatalog: WriterHostApi["selectionCatalog"];
  selectionCatalogHost: WriterHostApi["selectionCatalogHost"];
  stability: StabilityPort;
  stageReturn: StageReturnApi;
  wall: WallApi;
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
  world: WorldApi;
}

/** One handler object from the five groups; each group carries the exact contract keys it implements. */
const OWNER_ITEM_SWEEPS = [writerQuestionSweep, runGoalSweep, phaseWordSweep, scheduleFailureSweep];

export function registerRpc(ctx: ServerCore, services: Services, contract: typeof rpcContract) {
  const ownerSweeps = [...OWNER_ITEM_SWEEPS, budgetSpentSweep(services)];
  // Every call is timed (rpc-timing.ts). No caller check: every machine and every caller is the owner's (owner decision 2026-10-08).
  ctx.bb.rpc.register(contract, journalRpcHandlers(timeRpcHandlers({
    ...preferencesRpc(ctx, services),
    ...runsRpc(ctx, services),
    ...settingsRpc(ctx, services),
    ...selectionsRpc(ctx, services),
    ...roleModelsRpc(ctx),
    ...stackRpc(ctx),
    ...insightsRpc(ctx, services),
    ...tokenUsageRpc(ctx),
    ...secretsRpc(ctx),
    ...jevProviderRpc(ctx),
    ...workspaceProviderRpc(ctx),
    ...chatAgentRpc(ctx),
    ...workflowsRpc(ctx, services),
    ...workflowExportRpc(ctx, services),
    ...workflowOpsRpc(ctx, services),
    ...schedulesRpc(ctx, services),
    ...councilRpc(ctx.db, services.council),
    ...selfRepairRpc(ctx, services, selfRepairDeps()),
    ...canaryRpc(services.canary),
    ...memoryProbeRpc(services),
    ...harnessRpc(services.harness),
    ...deferralRpc(services.deferrals),
    ...rollbackRpc(services.rollback),
    ...acceptanceRpc(ctx.db),
    ...benchRpc(services.bench),
    ...ownerWaitingRpc(ctx.db, ownerSweeps, services.ownerLearningItems),
    ...backlogRpc(services.backlog),
    ...leadRpc(ctx.db, services.lead),
    ...errandsRpc(ctx, services),
    ...baselineRpc(services.baseline, services.regression),
    ...stageReturnRpc(services.stageReturn),
    ...forecastRpc(ctx.db),
    ...workGraphRpc(ctx, { tokenCursorRow }),
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
      const family = taskFamily(taskId);
      // The first press claims the decision (SMA tr_approving): the second presser loses.
      const waiting = waitingAttemptId(ctx.db, runId, family) ?? null;
      const claim = services.taskWords.decide(ctx.db, runId, family, decision, "screen", Date.now(), waiting);
      if (!claim.ok) return { ok: false as const, reason: claim.reason };
      await recordTaskWord(ctx.bb.storage.kv as never, runId, family, decision, text, Date.now(), waiting);
      services.taskWords.answer(ctx.db, runId, family, decision, text, "screen");
      return { ok: true as const };
    },
    learning_decide: async ({ id, action }: { id: string; action: "accept" | "reject" | "drop" }) => {
      try {
        const learning = learningFor(ctx);
        if (!learning) return { ok: false as const, reason: "the learning room did not start" };
        const { item } = await learning.decisions[action](id);
        return { ok: true as const, item };
      } catch (cause) {
        return { ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    ...cockpitRpc(ctx, services),
    world_version: async () => ({ version: worldVersion() }),
    money_status: async () => services.money.status(),
    ...capabilityRpc(services.capabilities),
    conveyor: async ({ set, reason }: { set?: "on" | "off"; reason?: string }) => set ? await setConveyor(ctx.bb.storage.kv as never, set === "on", reason) : await conveyorState(ctx.bb.storage.kv as never),
    ...wallRpc(services.wall),
    ...improvementRpc({ db: ctx.db, kv: ctx.bb.storage.kv, wall: services.wall, bench: services.bench, deferrals: services.deferrals, ownerSweeps, ownerLearningItems: services.ownerLearningItems }),
    ...sessionMemoryRpc(ctx, services),
    ...createWorkflowArchitect(ctx, services).rpc,
    ...architectStartRpc(ctx, services),
    ...anamnesisFor(ctx).rpc,
    ...worldRpc(services.world),
  }, (message) => ctx.bb.log.debug(message)), (name, input) => services.front?.journal(name, input), (message) => ctx.log(message)));
}
