import type { PluginCliContext } from "@get-bb/plugin-sdk";
import type { ServerCore } from "../../contracts/server";
import type { InsightsApi, ScheduleAgentApi } from "../../contracts";
import type { ProviderUsage } from "../../usage/server";
import type { WallThreadReader } from "../../memory/server";
import type { LearningItemsReader } from "../../owner-waiting";
import type { WorkflowEngineApi, WorkflowTriggersApi, WriterHostApi } from "../../platform/server";
import { runGoalSweep } from "../../run-goal/server";
import { phaseWordSweep } from "../../phase/server";
import { scheduleFailureSweep } from "../../schedule/server";
import type { BacklogApi } from "../../backlog/server/scanner";
import type { BenchApi } from "../../bench/service";
import type { CapabilitiesApi } from "../../capability/server/capability";
import type { CheckersApi } from "../../checkers/api";
import type { CouncilApi } from "../../council/server/council";
import type { DeferralApi } from "../../deferral/service";
import type { DocsNightlyApi } from "../../docs/server/docs-nightly";
import type { HarnessApi } from "../../harness/server/harness";
import type { HypothesesApi } from "../../hypotheses/server/hypotheses";
import type { LeadApi } from "../../lead/server/service";
import type { MemoryProbeApi } from "../../memory-probe/server/memory-probe";
import type { MemoryConflictsApi } from "../../memory/server/memory-conflicts";
import type { MoneyApi } from "../../money/server";
import type { ActivationApi } from "../../contracts/agent-ops";
import type { OwnerPresenceApi } from "../../owner-presence/server/presence";
import type { PhaseApi } from "../../phase/server/driver";
import type { PhaseIntake } from "../../phase/server/intake";
import type { PmReplay } from "../../pm-replay/service";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { RunGoalApi } from "../../run-goal/server/run-goal";
import type { ProbesApi } from "../../stability/server/probes";
import type { ReconcileApi } from "../../stability/server/reconcile";
import type { StageReturnApi } from "../../stage-return/server/stage-return";
import type { WallApi } from "../../wall/service";
import { writerQuestionSweep, budgetSpentSweep } from "../../writer/server";
import type { WriterDispatchApi } from "../../writer/server/dispatch";
import type { WriterStateApi } from "../../writer/server/state";
import type { WriterVerifyApi } from "../../writer/server/verify";

import type { BaselineApi } from "../../baseline/server/baseline";
import type { ScheduleService } from "../../schedule/server/schedule-service";
import type { RuleScanApi } from "../../self-repair/server/rule-scan";

import type { RegressionApi } from "../../baseline/server/regress";
import type { WriterSpawnApi } from "../../writer/server/spawn";
import type { WriterStartApi } from "../../writer/server/start";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  activate: ActivationApi["activate"];
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  backlog: BacklogApi;
  baseline: BaselineApi;
  bench: BenchApi;
  capabilities: CapabilitiesApi;
  checkers: CheckersApi;
  council: CouncilApi;
  deferrals: DeferralApi;
  dispatchWriter: WriterDispatchApi["dispatchWriter"];
  docsPlaces: DocsNightlyApi["docsPlaces"];
  harness: HarnessApi;
  hypotheses: HypothesesApi;
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  lead: LeadApi;
  listedAgentProfiles: WriterHostApi["listedAgentProfiles"];
  memoryConflicts: MemoryConflictsApi;
  memoryProbe: MemoryProbeApi;
  money: MoneyApi;
  wallThreadReader: WallThreadReader;
  ownerLearningItems: LearningItemsReader;
  ownerPresence: OwnerPresenceApi;
  persistWriterAcceptance: WriterVerifyApi["persistWriterAcceptance"];
  phaseIntake: PhaseIntake;
  phases: PhaseApi;
  pmReplay?: PmReplay;
  providerBreaker: WriterStateApi["providerBreaker"];
  providerUsage?: Pick<ProviderUsage, "windows">;
  reconcileAttemptThread: ReconcileApi["reconcileAttemptThread"];
  regression: RegressionApi;
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  resumeOrphans: ReconcileApi["resumeOrphans"];
  rollback: RollbackApi;
  ruleScan: RuleScanApi;
  insights: InsightsApi;
  scheduleAgents: ScheduleAgentApi;
  runBudgetFor: WriterStateApi["runBudgetFor"];
  runBudgets: WriterStateApi["runBudgets"];
  runGoal: RunGoalApi;
  runNightlyDocs: DocsNightlyApi["runNightlyDocs"];
  schedules: ScheduleService;
  stageReturn: StageReturnApi;
  startAmbiguousProbe: ProbesApi["startAmbiguousProbe"];
  startCancelProbe: ProbesApi["startCancelProbe"];
  startHelperProbe: ProbesApi["startHelperProbe"];
  startProviderErrorProbe: ProbesApi["startProviderErrorProbe"];
  startWriterTask: WriterStartApi["startWriterTask"];
  validateWriterResult: WriterVerifyApi["validateWriterResult"];
  wall: WallApi;
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

export const OWNER_ITEM_SWEEPS = [writerQuestionSweep, runGoalSweep, phaseWordSweep, scheduleFailureSweep];

/** What the split command handlers share from `registerCli`: the server context, the services bag and the parsed argv. */
export interface CliRunDeps {
  ctx: ServerCore;
  services: Services;
  command: string | undefined;
  args: string[];
  invocation: PluginCliContext;
  commands: Array<{ name: string; summary: string; usage: string }>;
  migrations: readonly string[];
}
