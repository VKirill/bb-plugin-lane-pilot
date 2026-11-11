import type { PluginCliContext } from "@get-bb/plugin-sdk";
import { phaseWordSweep, runGoalSweep, scheduleFailureSweep, writerQuestionSweep } from "./cli-imports";
import type { ActivationApi, BacklogApi, BaselineApi, BenchApi, CapabilitiesApi, CheckersApi, CouncilApi, DeferralApi, DocsNightlyApi, HarnessApi, HypothesesApi, InsightsApi, LeadApi, LearningItemsReader, MemoryConflictsApi, MemoryProbeApi, MoneyApi, OwnerPresenceApi, PhaseApi, PhaseIntake, PmReplay, ProbesApi, ProviderUsage, ReconcileApi, RegressionApi, RollbackApi, RuleScanApi, RunGoalApi, ScheduleAgentApi, ScheduleService, ServerCore, StageReturnApi, WallApi, WorkflowEngineApi, WorkflowTriggersApi, WriterDispatchApi, WriterHostApi, WriterSpawnApi, WriterStartApi, WriterStateApi, WriterVerifyApi, WallThreadReader } from "./cli-imports";
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
