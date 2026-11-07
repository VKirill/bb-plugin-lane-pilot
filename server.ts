import { getReasoningTrace, getRunSettingsScopes, listOpenAttempts, listUnfinishedStages, loadPrototypeConfig, loadProjectSettings, openDatabase } from "./src/rooms/storage";
import { migrations as lanePilotMigrations } from "./src/rooms/migrations";
import { coupledSettingKeys, validateSettingChanges, validateSettingValue, validateSettingsObject } from "./src/rooms/settings";
import { createTaskReconcile } from "./src/rooms/runs/server";
import { createActivation } from "./src/rooms/native-agent/server";
import { placeEmployeeOn, compileEffectiveMainAgent, detectCompiledMainAgentCapability, pendingSwitch } from "./src/rooms/native-agent";
import { storeNativeSelection } from "./src/rooms/native-agent/server/native-profile";
import { createMergeIntentRecovery, gateResolverFor } from "./src/rooms/verification/server";
import { registerCli } from "./src/rooms/tools/server/cli";
import { createCore } from "./src/rooms/core/server/core";
import { createCanary, mountCanary } from "./src/rooms/stability/server";
import { createCouncil, mountCouncilGraph } from "./src/rooms/council/server";
import { createWorldService } from "./src/rooms/world/server";
import { createDocsNightly } from "./src/rooms/docs/server";
import { mountNativeWiring } from "./src/rooms/core/server/native-wiring";
import { createProbes } from "./src/rooms/stability/server";
import { createMemoryProbe } from "./src/rooms/memory-probe/server";
import { createMemoryConflicts } from "./src/rooms/memory/server";
import { createReconcile } from "./src/rooms/stability/server";
import { createStability } from "./src/rooms/stability/server";
import { adoptWaitingRules } from "./src/rooms/self-repair/server";
import { createRuleScan } from "./src/rooms/self-repair/server";
import { createPromotionService } from "./src/rooms/rule-forms";
import { mountNightGraphs } from "./src/rooms/night-graphs/server";
import { mountPmReplay } from "./src/rooms/pm-replay/server";
import { createHarness } from "./src/rooms/harness/server";
import { createDeferrals, sdkOwnerMessagePort } from "./src/rooms/deferral/server";
import { createRollback } from "./src/rooms/rollback/server";
import { createPluginBench, mountBenchNightly, mountBenchSweep, mountBenchWeekly, mountServiceModelRecheck } from "./src/rooms/bench/server";
import { createBaselineRoom, mountRegress, mountRegressionTools } from "./src/rooms/baseline/server";
import { createRunGoal, mountRunGoal } from "./src/rooms/run-goal/server";
import { createProfileCheck, mountProfileCheck } from "./src/rooms/native-agent/server";
import { createLeadService, mountLead, taskWordPort, type LeadApi } from "./src/rooms/lead/server";
import { addRoad, doneRoad, getRoad, listRoad, reopenRoad } from "./src/rooms/lead/server";
import { acceptRuleProposal, adoptRuleProposal, deleteMemoryRecord, rejectRuleProposal, retireAdoptedRule } from "./src/rooms/self-repair/server";
import { lanePilotProjectOrNotice } from "./src/rooms/self-repair/server";
import { recordErrandEpisode, errandSpawnOf } from "./src/rooms/errands";
import { loadEvalData, runMemoryEval } from "./src/rooms/memory-eval/server";
import type { ErrandEpisodesApi, InsightsApi, LaneProjectNotice, LeadRoadApi, MemoryEvalRunner, ScheduleAgentApi, TaskWordPort } from "./src/rooms/contracts";
import { createPhaseDriver, mountPhaseDriver, mountPhaseIntake, registerPhaseTool } from "./src/rooms/phase/server";
import { createPhaseReactions } from "./src/rooms/core/server";
import { selfRepairDeps } from "./src/rooms/self-repair/server";
import { registerConversationTools, registerQueueTool } from "./src/rooms/tasks/server";
import { mountOutbound } from "./src/rooms/relay/server";
import { createMoney } from "./src/rooms/money";
import { mountPermits } from "./src/rooms/writer/server";
import { mountForge } from "./src/rooms/forge";
import { createFront, mountFront } from "./src/rooms/front";
import { createCapabilities, mountCapabilities } from "./src/rooms/capability/server";
import { createBacklog, mountBacklog } from "./src/rooms/backlog/server";
import { createHypotheses } from "./src/rooms/hypotheses/server";
import { createOwnerPresence, mountOwnerPresence } from "./src/rooms/owner-presence/server";
import { mountOutage } from "./src/rooms/outage/server";
import { createPluginWall } from "./src/rooms/wall/server";
import { buildCliInvocation, skillSwitchMorningLine } from "./src/rooms/writer";
import { createPluginCheckers } from "./src/rooms/checkers/server";
import { createStageReturn } from "./src/rooms/stage-return/server";
import { cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees, closeAbandonedRuns, closeStaleRuns, isTaskSatisfied } from "./src/rooms/runs/server"
import { pluginStopped } from "./src/rooms/contracts/errors";
import { registerRpc } from "./src/rooms/core/server/rpc";
import { mountAnamnesis } from "./src/rooms/anamnesis";
import { mountWorldAssets } from "./src/rooms/world/server";
import { registerLaneWorktreeProvider } from "./src/rooms/native-agent/server";
import { scheduleIsolated } from "./src/rooms/platform/server";
import { clearDrainSnapshot, readDrainSnapshot, skipRedundantStartupScans } from "./src/rooms/stability/server";
import { tokenCursorRow, tokenDailyByModel } from "./src/rooms/usage/server";
import type { TokenCursorReader } from "./src/rooms/work-graph/server";
import { createWriterQuestionTimeout, DEFAULT_SILENCE_NUDGE_MIN, OPENCODE_WRITER_PROVIDER, sweepWriterSilence, sweepWriterWakes } from "./src/rooms/writer/server";
import { threadPendingInteractions } from "./src/rooms/relay/server";
import { createStageChildren, mountErrands } from "./src/rooms/qa/server";
import { createDocsStage } from "./src/rooms/docs/server";
import { createMemoryStage, mountMemoryEmbeddings, mountThreadBlock } from "./src/rooms/memory/server";
import { createNightStages } from "./src/rooms/night/server";
import { createProjectLifeStage } from "./src/rooms/project-life/server";
import { createQaStages } from "./src/rooms/qa/server";
import { registerTools } from "./src/rooms/tools/server/tools";
import { bindToolLocale, toolLocale } from "./src/rooms/platform/server";
import { createWriterHost } from "./src/rooms/writer/server";
import { createWriterState } from "./src/rooms/writer/server";
import { createWriterSpawn } from "./src/rooms/writer/server";
import { createWriterVerify } from "./src/rooms/writer/server";
import { createWriterFinish } from "./src/rooms/writer/server";
import { createWriterStart } from "./src/rooms/writer/server";
import { createWriterDispatch } from "./src/rooms/writer/server";
import { createAttemptReopen, createWriterReassign, recheckPlanFact, registerDispatchExecutors, taskUsage } from "./src/rooms/writer/server";
import { stageHelperSettings } from "./src/rooms/settings/server";
import { createWorkflowEngine } from "./src/rooms/workflow/server";
import { architectStarter, createWorkflowLibrary } from "./src/rooms/workflow/server";
import { createWorkflowTriggersService } from "./src/rooms/workflow/server";
import { createScheduleService, registerAgentRoutineActions, scheduleAgentApi } from "./src/rooms/schedule/server";
import { registerSpecialistActions } from "./src/rooms/critique/server";
import { knownOwnerLocale, relayFor } from "./src/rooms/relay/server";
import { mountLearning } from "./src/rooms/learning";
import { memorySettingsFor } from "./src/rooms/memory/server";
import type { MemorySettings } from "@lane-pilot/memory-core";
import { installThreadSignals } from "@lane-pilot/thread-observe";
import { mountLifecycleEvents } from "./src/rooms/core/server/lifecycle-events";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { ActivationApi, AgentOpsApi } from "./src/rooms/contracts/agent-ops";
import type { MergeIntentsApi } from "./src/rooms/contracts/merge-intents";
import type { VerificationGatePort } from "./src/rooms/contracts/integration-gate";
import type { IsTaskSatisfied } from "./src/rooms/contracts";
import type { DocsNightlyApi } from "./src/rooms/docs/server/docs-nightly";
import type { ProbesApi } from "./src/rooms/stability/server/probes";
import type { ReconcileApi } from "./src/rooms/stability/server/reconcile";
import type { StabilityApi } from "./src/rooms/stability/server/stability";
import type { StageChildrenApi } from "./src/rooms/qa/server/children";
import type { DocsStageApi } from "./src/rooms/docs/server/docs";
import type { MemoryStageApi } from "./src/rooms/memory/server/memory";
import type { NightStagesApi } from "./src/rooms/night/server/night";
import type { ProjectLifeStageApi } from "./src/rooms/project-life/server/project-life";
import type { QaStagesApi } from "./src/rooms/qa/server/qa";
import type { WriterHostApi } from "./src/rooms/writer/server/writer-host";
import type { WriterStateApi } from "./src/rooms/writer/server/state";
import type { WriterSpawnApi } from "./src/rooms/writer/server/spawn";
import type { WriterVerifyApi } from "./src/rooms/writer/server/verify";
import type { WriterFinishApi } from "./src/rooms/writer/server/finish";
import type { WriterStartApi } from "./src/rooms/writer/server/start";
import type { WriterDispatchApi } from "./src/rooms/writer/server/dispatch";
import type { ArchitectApi, AttemptReopenApi, BuildCliInvocation, RecheckPlanFact, RunVerification, SkillSwitchMorningLine, StageHelperSettings, TaskUsage, WallGraphApi, WorkflowEngineApi, WorkflowLibraryApi, WorkflowTriggersApi as WorkflowTriggersPort, WriterDispatchApi as WriterDispatchPort, WriterHostApi as WriterHostPort, WriterReassignApi, WriterStartApi as WriterStartPort, WriterStateApi as WriterStatePort } from "./src/rooms/platform/server";
import type { WorkflowTriggersApi } from "./src/rooms/workflow/server/workflow-triggers-live";
import type { MemoryProbeApi } from "./src/rooms/memory-probe/server/memory-probe";
import type { CouncilApi } from "./src/rooms/council/server";
import type { ErrandsApi } from "./src/rooms/qa/server";
import type { ScheduleService } from "./src/rooms/schedule/server";
import type { RuleScanApi } from "./src/rooms/self-repair/server";
import type { HarnessApi } from "./src/rooms/harness/server";
import type { DeferralApi } from "./src/rooms/deferral/server";
import type { RollbackApi } from "./src/rooms/rollback/server";
import type { BenchApi } from "./src/rooms/bench/server";
import type { BaselineApi, RegressionApi } from "./src/rooms/baseline/server";
import type { RunGoalApi } from "./src/rooms/run-goal/server";
import type { PhaseApi, PhaseIntake } from "./src/rooms/phase/server";
import type { MoneyApi } from "./src/rooms/money";
import type { FrontApi } from "./src/rooms/front";
import type { CapabilitiesApi } from "./src/rooms/capability/server";
import type { BacklogApi } from "./src/rooms/backlog/server";
import type { HypothesesApi } from "./src/rooms/hypotheses/server";
import type { OwnerPresenceApi } from "./src/rooms/owner-presence/server";
import type { WallApi } from "./src/rooms/wall/server";
import type { CheckersApi } from "./src/rooms/checkers/server";
import type { ProfileCheckApi } from "./src/rooms/native-agent/server";
import type { StageReturnApi } from "./src/rooms/stage-return/server";
import type { WorldApi } from "./src/rooms/world/server";
import type { Canary } from "./src/rooms/stability/server";
import type { MemoryConflictsApi } from "./src/rooms/memory/server";
import type { PromotionServiceApi } from "./src/rooms/rule-forms";

/** Every function one server module offers another; filled once all modules exist, read at call time. */
export interface Services {
  council: CouncilApi;
  /** The Pixel World tick service (src/rooms/world). */
  world: WorldApi;
  canary: Canary;
  ruleScan: RuleScanApi;
  promotions: PromotionServiceApi;
  harness: HarnessApi;
  /** The register of deferrals with the owner's terms (src/rooms/deferral). */
  deferrals: DeferralApi;
  /** The record of every attempt's base and change, and reverify / revert of accepted work (src/rooms/rollback). */
  rollback: RollbackApi;
  /** LP-Bench: the fixed task set and its comparisons (src/rooms/bench). */
  bench: BenchApi;
  /** The task's checks on its base before a writer, and what turned red after the merge (src/rooms/baseline). */
  baseline: BaselineApi;
  /** The usage room's token-cursor read (src/rooms/usage); rooms that cannot import usage get it here. */
  tokenCursorRow: TokenCursorReader;
  /** Sends a task back to an earlier stage with a note (src/rooms/stage-return). */
  stageReturn: StageReturnApi;
  /** The regression pass: accepted tasks' checks on current main, bisect of the ones that went red (src/rooms/baseline). */
  regression: RegressionApi;
  /** The wall journal and the night loop: classes of failures, the night's repairs, the wall ladder (src/rooms/wall). */
  wall: WallApi;
  /** The writer's skill-switch morning line, handed to the wall so the wall does not import writer (src/rooms/writer/skill-switch.ts). */
  skillSwitchMorningLine: SkillSwitchMorningLine;
  /** The writer's settings→argv builder, handed to the settings screen's preview (src/rooms/writer/argv-builder.ts). */
  buildCliInvocation: BuildCliInvocation;
  /** Every accepted task's checks together on the final main once a run is done (src/rooms/run-goal). */
  runGoal: RunGoalApi;
  /** Phases on rails: the driver that moves a phase through its stages by gates in code and wakes the PM at each turn (src/rooms/phase). */
  phases: PhaseApi;
  /** Rails by default: the owner's newest message in a PM chat read before the PM acts; a heavy goal goes into a phase (src/rooms/phase/server/intake.ts). */
  phaseIntake: PhaseIntake;
  /** The spend book, the money cap of paid lanes and the subscription windows (src/rooms/money). */
  money: MoneyApi;
  /** The front outside the graphs: first run, own helpers, peers, coordination, the door, the action journal (src/rooms/front). */
  front: FrontApi;
  /** The capability table: each provider's adapter version probed once, a failing one held off by the breaker (src/rooms/capability). */
  capabilities: CapabilitiesApi;
  /** The backlog scanner: ready todos with an estimate issued to the project's PM in queue order (src/rooms/backlog). */
  backlog: BacklogApi;
  /** Ideas checked on the bench set: two arms, the verdict, adoption through the night policy (src/rooms/hypotheses). */
  hypotheses: HypothesesApi;
  /** The owner's presence on a provider in the last minutes: writers keep off it (src/rooms/owner-presence). */
  ownerPresence: OwnerPresenceApi;
  /** Checking the checkers: planted defects in accepted candidates, the checker scorecard and the drill (src/rooms/checkers). */
  checkers: CheckersApi;
  docsVerdict: DocsNightlyApi["docsVerdict"];
  docsPlaces: DocsNightlyApi["docsPlaces"];
  docsPlaceStatus: DocsNightlyApi["docsPlaceStatus"];
  docsLastRead: DocsNightlyApi["docsLastRead"];
  activate: ActivationApi["activate"];
  placeEmployeeOn: AgentOpsApi["placeEmployeeOn"];
  storeNativeSelection: AgentOpsApi["storeNativeSelection"];
  compileEffectiveMainAgent: AgentOpsApi["compileEffectiveMainAgent"];
  detectCompiledMainAgentCapability: AgentOpsApi["detectCompiledMainAgentCapability"];
  pendingSwitch: AgentOpsApi["pendingSwitch"];
  resolveIntegrationGate: VerificationGatePort;
  isTaskSatisfied: IsTaskSatisfied;
  recoverMergeIntents: MergeIntentsApi["recoverMergeIntents"];
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  providerBreaker: WriterStateApi["providerBreaker"];
  providerUsage: WriterStateApi["providerUsage"];
  providerRetry: WriterStateApi["providerRetry"];
  concurrencyLimit: WriterStateApi["concurrencyLimit"];
  runBudgets: WriterStateApi["runBudgets"];
  runBudgetFor: WriterStateApi["runBudgetFor"];
  dispatchWriter: WriterDispatchApi["dispatchWriter"];
  resumeDispatch: WriterDispatchApi["resumeDispatch"];
  registerDocsGraphs: DocsNightlyApi["registerDocsGraphs"];
  enqueueResumedWriter: ReconcileApi["enqueueResumedWriter"];
  finishWriterAttempt: WriterFinishApi["finishWriterAttempt"];
  ingestOpenCodeTelemetry: QaStagesApi["ingestOpenCodeTelemetry"];
  listedAgentProfiles: WriterHostApi["listedAgentProfiles"];
  persistWriterAcceptance: WriterVerifyApi["persistWriterAcceptance"];
  projectLifeTaskSummary: StageChildrenApi["projectLifeTaskSummary"];
  readWriterWorkspaceFile: WriterDispatchApi["readWriterWorkspaceFile"];
  reconcileAttemptThread: ReconcileApi["reconcileAttemptThread"];
  reconcileDocsChild: StageChildrenApi["reconcileDocsChild"];
  reconcileProjectLifeChild: StageChildrenApi["reconcileProjectLifeChild"];
  reconcileStageChild: StageChildrenApi["reconcileStageChild"];
  recoverLostHolderThread: ReconcileApi["recoverLostHolderThread"];
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  resumeOrphans: ReconcileApi["resumeOrphans"];
  runBrowserQa: QaStagesApi["runBrowserQa"];
  resumeBrowserQaThreads: QaStagesApi["resumeBrowserQaThreads"];
  runDocsMaintenance: DocsStageApi["runDocsMaintenance"];
  runMemoryContext: MemoryStageApi["runMemoryContext"];
  runMemoryMaintenance: MemoryStageApi["runMemoryMaintenance"];
  runNightlyDocs: DocsNightlyApi["runNightlyDocs"];
  runProjectLifeMaintenance: ProjectLifeStageApi["runProjectLifeMaintenance"];
  runVerification: WriterVerifyApi["runVerification"];
  runWorkspaceStatus: NightStagesApi["runWorkspaceStatus"];
  runWriterPool: WriterStateApi["runWriterPool"];
  selectionCatalogHost: WriterHostApi["selectionCatalogHost"];
  selectionCatalog: WriterHostApi["selectionCatalog"];
  spawnWriterAttempt: WriterSpawnApi["spawnWriterAttempt"];
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  restoreLiveFolder: WriterSpawnApi["restoreLiveFolder"];
  startAmbiguousProbe: ProbesApi["startAmbiguousProbe"];
  startCancelProbe: ProbesApi["startCancelProbe"];
  startProviderErrorProbe: ProbesApi["startProviderErrorProbe"];
  startHelperProbe: ProbesApi["startHelperProbe"];
  memoryProbe: MemoryProbeApi;
  /** Memory notes that disagree: held out of every brief until a person settles them (src/rooms/memory/server/memory-conflicts.ts). */
  memoryConflicts: MemoryConflictsApi;
  startWriterTask: WriterStartApi["startWriterTask"];
  stability: StabilityApi;
  validateWriterResult: WriterVerifyApi["validateWriterResult"];
  waitWriter: WriterDispatchApi["waitWriter"];
  workspaceDirt: WriterSpawnApi["workspaceDirt"];
  /** The writer's executor registry of `lp.*` steps (reopen/reassign) and helper accounting, wired here for the rooms that call them. */
  architect: ArchitectApi;
  workflowLibrary: WorkflowLibraryApi;
  recheckPlanFact: RecheckPlanFact;
  taskUsage: TaskUsage;
  attemptReopen: AttemptReopenApi;
  writerReassign: WriterReassignApi;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  stageHelperSettings: StageHelperSettings;
  startAfterAcceptance: WorkflowEngineApi["startAfterAcceptance"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
  /** The errand starter of the PM tools (also used by scheduled errands); set in server.ts before the tools mount. */
  errands: ErrandsApi;
  /** Starts a named agent for a scheduled `agent` run and reads its report; set when the tools are mounted. */
  /** The schedule board: scheduler, definitions, previews (src/server/schedule-service.ts). */
  schedules: ScheduleService;
  /** The lead («Штурман»): the road tree, the decision journal, the ticks and the rights (src/rooms/lead/server/service.ts). */
  lead: LeadApi;
  /** The lead's task-word ask/answer, handed to the writer and the queue tool (src/rooms/lead). */
  taskWords: TaskWordPort;
  /** The Lane Pilot project resolve + notice, handed to lead and the workflow rooms (src/rooms/self-repair). */
  laneProject: LaneProjectNotice;
  /** The lead's road writes/reads, handed to workflow and verification (src/rooms/lead). */
  leadRoad: LeadRoadApi;
  /** The self-repair rule/insight writes, handed to learning and memory (src/rooms/self-repair). */
  insights: InsightsApi;
  memorySettings: (settings: Record<string, unknown>) => MemorySettings;
  /** The errand episode recorder and spawn read, handed to the workflow engine (src/rooms/errands). */
  errandEpisodes: ErrandEpisodesApi;
  /** The schedule board's active-agent read, handed to the native-agent registry (src/rooms/schedule). */
  scheduleAgents: ScheduleAgentApi;
  /** The memory evaluation runner, handed to the lead's nightly exam (src/rooms/memory-eval). */
  memoryEval: MemoryEvalRunner;
  /** The PM replay set: harvest, replay runs, the staged A/B decision (src/rooms/pm-replay). Set when it is mounted. */
  pmReplay?: import("./src/rooms/pm-replay").PmReplay;
  /** The daily read-back of role profiles: per role, the helpers with/without a stored required policy (src/rooms/native-agent). */
  profileCheck: ProfileCheckApi;
}

export { experimental_vkLifecycle } from "./src/rooms/native-install";

import { rpcContract } from "./src/rooms/core/server/plugin-contracts";
export { rpcContract };

/** Entry only: storage, the shared core, every module on one services bag, then the registrations. */
export default async function plugin(bb: BbPluginApi) {
  const db = openDatabase(bb, { migrations: lanePilotMigrations, validateSetting: { validateSettingValue, validateSettingsObject, coupledSettingKeys, validateSettingChanges } });
  // BB's thread events wake the watchers of writers and helper threads; without them they poll as before.
  installThreadSignals(bb);
  const ctx = createCore(bb, db);
  bindToolLocale(bb, toolLocale(await knownOwnerLocale(bb)));
  // The register of deferrals: the first entries (skipped tests, old plan decisions) are written once; terms come only from the owner's messages.
  const deferrals = createDeferrals({ db, port: sdkOwnerMessagePort(bb), log: ctx.log });
  // A failing seed must not keep the plugin from starting: the register only adds the morning list.
  try { deferrals.seed(); } catch (cause) { bb.log.warn(`Lane Pilot: deferral seed skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const services = {} as Services;
  Object.assign(services, {
    skillSwitchMorningLine: skillSwitchMorningLine satisfies SkillSwitchMorningLine,
    buildCliInvocation: buildCliInvocation satisfies BuildCliInvocation,
    taskWords: taskWordPort,
    laneProject: lanePilotProjectOrNotice,
    leadRoad: { addRoad, doneRoad, getRoad, listRoad, reopenRoad },
    insights: { acceptRuleProposal, adoptRuleProposal, deleteMemoryRecord, rejectRuleProposal, retireAdoptedRule },
    memorySettings: memorySettingsFor,
    errandEpisodes: { recordErrandEpisode, errandSpawnOf },
    scheduleAgents: scheduleAgentApi(),
    memoryEval: { load: loadEvalData, run: runMemoryEval },
  });
  mountNativeWiring(ctx);
  services.tokenCursorRow = tokenCursorRow;
  Object.assign(
    services,
    createReconcile(ctx, services) satisfies ReconcileApi,
    createActivation(ctx, services) satisfies ActivationApi,
    createMergeIntentRecovery(ctx, services) satisfies MergeIntentsApi,
    {
      resolveIntegrationGate: gateResolverFor(ctx),
      placeEmployeeOn: (agentId: string, sources: Parameters<AgentOpsApi["placeEmployeeOn"]>[1]) => placeEmployeeOn(ctx.bb, agentId, sources),
      storeNativeSelection: (input: { projectId: string; agentId: string; parentRunId?: string }) => storeNativeSelection(ctx, input),
      compileEffectiveMainAgent,
      detectCompiledMainAgentCapability,
      pendingSwitch: (threadId: string) => pendingSwitch(ctx.bb.storage.kv, threadId),
    } satisfies AgentOpsApi & { resolveIntegrationGate: VerificationGatePort },
    { isTaskSatisfied } satisfies { isTaskSatisfied: IsTaskSatisfied },
    createWriterState(ctx) satisfies WriterStatePort,
    createWorkflowEngine(ctx, services) satisfies WorkflowEngineApi,
    createWorkflowTriggersService(ctx, services) satisfies WorkflowTriggersPort,
    createWriterSpawn(ctx, services),
    createWriterVerify(ctx, services) satisfies { runVerification: RunVerification },
    createWriterFinish(ctx, services),
    createWriterStart(ctx, services) satisfies WriterStartPort,
    createWriterDispatch(ctx, services) satisfies WriterDispatchPort,
    createQaStages(ctx),
    createStageChildren(ctx),
    createDocsStage(ctx, services),
    createMemoryStage(ctx, services),
    createProjectLifeStage(ctx, services),
    createNightStages(ctx),
    createDocsNightly(ctx, services),
    createProbes(ctx, services),
    createWriterHost(ctx) satisfies WriterHostPort,
    { council: createCouncil(ctx) },
    { world: createWorldService(ctx, { projectName: (projectId) => bb.sdk.projects.get({ projectId }).then((p) => (typeof p?.name === "string" ? p.name : null), () => null) }) },
    // providerBreaker is another field of this bag: the canary reads it at call time through the thunk.
    { canary: createCanary(ctx, () => services.providerBreaker) },
    { memoryProbe: createMemoryProbe(ctx, services) },
    { ruleScan: createRuleScan(ctx, services, selfRepairDeps()) },
    { promotions: createPromotionService(ctx, services) },
    { harness: createHarness(ctx, services) },
    { deferrals },
    // deferrals is another field of this bag: memoryConflicts reads it at call time through the thunk.
    { memoryConflicts: createMemoryConflicts({ db, deferrals: () => services.deferrals, log: ctx.log }) },
    createRollback(ctx, services),
    createBaselineRoom(ctx, services),
    { architect: architectStarter(ctx, services) satisfies ArchitectApi },
    { workflowLibrary: createWorkflowLibrary(ctx, services) satisfies WorkflowLibraryApi },
    { recheckPlanFact: ((input: { projectId: string; runId: string; taskId: string; hostId: string }) => recheckPlanFact(ctx, input)) satisfies RecheckPlanFact },
    { taskUsage: taskUsage satisfies TaskUsage },
    { stageHelperSettings: stageHelperSettings satisfies StageHelperSettings },
    { attemptReopen: createAttemptReopen(ctx, services) satisfies AttemptReopenApi },
    { writerReassign: createWriterReassign(ctx) satisfies WriterReassignApi },
    createStageReturn(ctx, services),
    createRunGoal(ctx, services),
    createProfileCheck(ctx),
    createPhaseDriver(ctx, services, createPhaseReactions(ctx.db, ctx.bb)),
    createMoney(ctx),
    createFront(ctx),
    createCapabilities(ctx, services),
    createBacklog(ctx),
    createHypotheses(ctx, services),
    createOwnerPresence(ctx),
    { bench: createPluginBench(ctx, services) },
    { wall: createPluginWall(ctx, services) satisfies WallGraphApi },
    { checkers: createPluginCheckers(ctx) },
    createStability(ctx, services),
    createScheduleService(ctx, services),
    { lead: createLeadService(ctx, services, services.memoryEval, lanePilotMigrations) },
  );
  // The writer's `lp.*` executors (the task pipeline and its steps): writer registers them on the shared engine; workflow only mounts the delegates.
  registerDispatchExecutors(services.workflowEngine, ctx.bb);
  // The two code steps of `agent-routine`, the graph a schedule of kind agent runs (registered here: the schedule room imports the workflow room, not the other way).
  registerAgentRoutineActions(services.workflowEngine, ctx, services);
  // The brief step of `specialist`, the graph behind lane_pilot_specialist.
  registerSpecialistActions(services.workflowEngine, ctx);
  // The nightly docs of a unit (lp.docs-night) and the docs upkeep of an accepted task (lp.docs-maintenance) run on the engine; the schedules start them.
  services.registerDocsGraphs(services.workflowEngine);
  // The council is the `council` graph: its steps (open, next, the seats' turns, decide) run on the engine, the PM tools start and stop it.
  mountCouncilGraph(ctx, services, services.council);
  // The night jobs are graphs too: the rules scan, the wall's hunt and the harness editor (their steps wrap the functions of those rooms).
  mountNightGraphs(ctx, services);
  // The PM replay night: harvest corrections into scenarios, replay the set, decide rules on the verdicts.
  const pmReplay = mountPmReplay(ctx, services);
  services.pmReplay = pmReplay;
  mountLifecycleEvents(ctx, { onQueued: (name, entry) => {
    const id = entry && typeof entry === "object" ? Reflect.get(entry, "id") : undefined;
    if (typeof id === "string") return relayFor(ctx).queueEvent(name, id).then(() => undefined);
  } });
  registerRpc(ctx, services, rpcContract);
  // The Pixel World: tick loop, WebSocket route and listeners; the world starts with the service.
  services.world.mount();
  mountCanary(ctx, services.canary);
  // The nightly regression pass over recently accepted tasks (03:25): checks on current main, bisect, a row for the morning list.
  mountRegress(ctx, services.regression);
  // Once a run is done, every accepted task's checks run together on the final main (every 20 minutes, a verdict per run).
  mountRunGoal(ctx, services.runGoal);
  // Once a day: the helper threads of the last 24 h read back for their stored required policies; a loss goes to the owner's list.
  mountProfileCheck(ctx, services.profileCheck);
  // The lead («Штурман»): the code steps of its tick graph go on the engine; its sweep (every 15 min: due tick, stale receipts, ROAD.md) and its nightly exam of the rights (04:40).
  mountLead(ctx, services);
  // Every two minutes: each live phase is moved by its gates, the next wave of its plan is issued, and the PM gets the one thing the stage needs.
  mountPhaseDriver(ctx, services.phases);
  // Rails by default: each turn in a PM chat starts with the owner's newest message read in code; a heavy goal opens its phase.
  mountPhaseIntake(ctx, services.phaseIntake);
  // Each task that ends is posted to the project's webhook (events.webhook_url) with nine fields; the world version grows with every attempt change.
  mountOutbound(ctx);
  // Every hour: a provider whose adapter (BB plugin) version changed is probed once; a failing one is held off by the breaker.
  mountCapabilities(ctx, services.capabilities);
  // Every hour: ready todos with an estimate go to the project's PM in queue order (one a project a day, three a day in all).
  mountBacklog(ctx, services.backlog);
  // Where the owner typed in a BB thread Lane Pilot did not start; writers keep off that provider for ten minutes.
  mountOwnerPresence(ctx, services.ownerPresence);
  // The seeded hypotheses (SMA P2-11 contracts between roles) are on the register from the first start.
  try { services.hypotheses.seed(); } catch (cause) { bb.log.warn(`Lane Pilot: hypotheses seed skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
  // A gap in the heartbeat longer than 5 minutes is an outage on record; then one beat a minute.
  await mountOutage(ctx).catch((cause: unknown) => bb.log.warn(`Lane Pilot: outage record skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  // Every ordinary thread of a project gets the L1 memory showcase (M2); PM and plugin threads are left out inside.
  mountThreadBlock(ctx);
  mountMemoryEmbeddings(ctx);
  registerPhaseTool(ctx, services);
  registerQueueTool(ctx, services.taskWords);
  registerConversationTools(ctx, { spendByModel: (projectId, day) => tokenDailyByModel(ctx.db, projectId, day) });
  mountPermits(ctx);
  mountForge(ctx, services);
  mountFront(ctx, services.front);
  // bench is another field of this bag: each mount below reads it at call time through the thunk.
  // Every Sunday 02:00 UTC the newest bench set runs as this week's arm and is compared with last week's (bench.weekly).
  mountBenchWeekly(ctx, () => services.bench);
  // Every day 01:30 UTC the full set runs on OVH as the night arm (bench.nightly). The deploy gate reads that run.
  mountBenchNightly(ctx, () => services.bench);
  // A series left running past its hour cap is closed on startup and twice an hour.
  mountBenchSweep(ctx, () => services.bench);
  // First of the month, 04:00 UTC: the cheap pin of a service job is benched against its previous model (bench.service_models).
  mountServiceModelRecheck(ctx, () => services.bench);
  // The errand starter the PM tools and the scheduled errands share: a services field like the rest, built here — not inside registerTools.
  services.errands = mountErrands(ctx, services);
  // lane_pilot_learned and the lane_pilot_regression members are family members from other rooms: passed as contributors,
  // the fold mounts them itself, so their call order against registerTools does not matter.
  registerTools(ctx, services, [
    () => mountLearning(ctx, services),
    () => mountRegressionTools(ctx, services),
  ]);
  registerCli(ctx, services, lanePilotMigrations);
  // The pixel world's GLB files (council office people and cars) over HTTP, not inside app.js.
  mountWorldAssets(bb);
  // What Lane Pilot learns about its owner by itself (the daily pass and new messages); inert until the owner switches it on.
  mountAnamnesis(ctx);
  // Writer attempts get BB environments of this provider unless workspace.provider is off; a BB without the API
  // registers nothing and every attempt keeps the old worktree path.
  registerLaneWorktreeProvider(ctx);
  const sweepRuns = (signal?: AbortSignal) => Promise.resolve().then(async () => {
    const closed = await closeAbandonedRuns(bb, db, Date.now(), signal);
    if (closed.length) bb.log.info(`Lane Pilot closed ${closed.length} runs whose PM chat is gone: ${closed.join(", ")}`);
    const stale = await closeStaleRuns(bb, db, Date.now(), signal);
    if (stale.length) bb.log.info(`Lane Pilot closed ${stale.length} runs past their lifetime: ${stale.join(", ")}`);
  }).catch((cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot run sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const snapshotWorktree = async (hostId: string, worktreePath: string, name: string) =>
    await ctx.host.call("gitWorktreeSnapshot", { requestedHostId:hostId, worktreePath, name }, { hostId, timeoutMs:300_000 });
  const sweepEnvironments = (signal?: AbortSignal) => cleanupFinishedAttemptEnvironments(bb, db, snapshotWorktree, Date.now(), signal).then((removed) => {
    if (removed.length) bb.log.info(`Lane Pilot released ${removed.length} worktree(s) of finished attempts`);
  }, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot worktree sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const releasedLaneWorktrees = new Set<string>();
  const removeLaneWorktree = async (hostId:string, basePath:string, worktreePath:string) =>
    (await ctx.host.call("gitRemoveWorktree", { requestedHostId:hostId, basePath, worktreePath, release:true }, { hostId, timeoutMs:300_000 })).removed;
  scheduleIsolated(bb, "attempt-worktree-sweep", "*/10 * * * *", (signal) => Promise.all([sweepEnvironments(signal),
    cleanupStickyLaneWorktrees(db, removeLaneWorktree, releasedLaneWorktrees, Date.now(), signal).then((removed) => {
      if (removed.length) bb.log.info(`Lane Pilot released ${removed.length} area worktree(s) after their sticky window`);
    }, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot area worktree sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`))]).then(() => undefined), { timeoutMs: 20 * 60_000 });
  const taskReconcile = createTaskReconcile(ctx, services);
  // The same ordered pass as at start-up, minus the resume of attempts in flight: a lost retry or a landed merge is found
  // within five minutes, not at the next reload.
  scheduleIsolated(bb, "task-reconcile", "*/5 * * * *", (signal) => taskReconcile.reconcileTasks({ phase: "periodic",
    step: async (name, work) => {
      if (signal?.aborted || ctx.isDisposed()) return;
      try { await work(); } catch (cause) { bb.log.warn(`Lane Pilot ${name} skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
    } }), { timeoutMs: 10 * 60_000 });
  const sweepSilentWriters = (signal?: AbortSignal) => sweepWriterSilence({
    bb, signal, getThread:(threadId) => ctx.getThreadBounded(threadId), isDisposed:ctx.isDisposed, log:(line) => bb.log.info(line),
    waitingForOwner:async (threadId) => await ctx.ownerAsk.pending(threadId) || (await threadPendingInteractions(bb, threadId)) > 0,
    openAttempts:() => listOpenAttempts(db),
    // Only an opencode2 writer's session is read (from the OpenCode service on the host of its project); other writers are nudged as before.
    limitProbe:async (attempt, sessionId, sinceMs) => {
      const hostId = loadPrototypeConfig(db, attempt.project_id)?.hostId;
      if (!hostId || getReasoningTrace(db, attempt.id)?.providerId !== OPENCODE_WRITER_PROVIDER) return null;
      const probe = await ctx.host.call("openCodeLimitProbe", { requestedHostId:hostId, sessionId, sinceMs }, { hostId, timeoutMs:60_000 });
      return probe.status === "limit" ? probe : null;
    },
    silenceMinutes:(projectId, runId) => {
      const minutes = Number(loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId))["writer.silence_nudge_min"]);
      return Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_SILENCE_NUDGE_MIN;
    },
  }).then(() => undefined, (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot writer silence sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  scheduleIsolated(bb, "writer-silence-sweep", "*/5 * * * *", sweepSilentWriters, { timeoutMs: 10 * 60_000 });
  // A writer's question nobody answers within an hour is answered by the machine with the safest default, or the attempt ends (question-timeout.ts).
  const writerQuestions = createWriterQuestionTimeout(ctx, services);
  scheduleIsolated(bb, "writer-question-sweep", "*/5 * * * *", (signal) => writerQuestions.sweepWriterQuestions(Date.now(), signal).then(() => undefined,
    (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot writer question sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`)), { timeoutMs: 10 * 60_000 });
  // The waker of H2: attempts parked `waiting_writer:` are retaken when their earliest provider hold ends.
  scheduleIsolated(bb, "writer-wake", "* * * * *", () => sweepWriterWakes(ctx, services).then(() => undefined,
    (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot writer wake skipped: ${cause instanceof Error ? cause.message : String(cause)}`)), { timeoutMs: 5 * 60_000 });
  // Mondays 05:00: away from the nightly docs (03:00) and rules (03:30) passes.
  // 05:10, not 05:00: BB starts at most 8 isolated runs at once and the hour start already has several.
  scheduleIsolated(bb, "stability-drill", "10 5 * * 1", (signal) => services.stability.drill(Date.now(), signal).then(() => undefined,
    (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot fire drill skipped: ${cause instanceof Error ? cause.message : String(cause)}`)), { timeoutMs: 30 * 60_000 });
  // Recovery reads writer workspaces through the host, which is not callable while the factory registers; a service
  // starts once loading is done. (Run in the factory, a finished writer was failed with «host plugin calls are
  // unavailable during factory registration».)
  bb.background.service("startup-recovery", {
    async start(signal) {
      // The recovery runs beside the service, not inside it: a reload must stop the service at once, and a step that
      // waits on host calls (worktree snapshots, a deploy drain) kept it running past the reload, which left the
      // plugin «degraded: service startup-recovery did not stop» (2026-10-04). Each step checks whether to go on.
      const step = async (name:string, work:() => Promise<unknown> | unknown) => {
        if (signal.aborted || ctx.isDisposed()) return;
        try { await work(); } catch (cause) { bb.log.warn(`Lane Pilot ${name} skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
      };
      void (async () => {
        // VK core: why this instance started and whether the one before it drained (read here, not in the factory,
        // where `afterDrain` is still false). Resuming stages and writers runs in every case. What a clean drain
        // changes is the three periodic scans below: the old instance finished its checkout writes and checks and
        // left nothing half done for them to find, and they run again within 5-15 minutes on their own schedules.
        // «Clean» is the old instance's own snapshot (in flight at its deadline is not clean), not only `afterDrain`.
        const vk = (bb as unknown as { vk?: { startReason?: string; afterDrain?: boolean } }).vk;
        let skipScans = false;
        if (vk?.startReason) {
          bb.log.info(`Lane Pilot startup recovery: ${vk.startReason}${vk.afterDrain ? ", after a clean drain" : ""}`);
          await step("drain snapshot", async () => {
            const snapshot = await readDrainSnapshot(bb.storage.kv);
            if (snapshot) {
              bb.log.info(`Lane Pilot drain before this start: ${snapshot.action ?? "?"}, ${snapshot.clean ? "nothing in flight" : `${snapshot.inFlight?.length ?? 0} call(s) cut`}`);
              skipScans = skipRedundantStartupScans(vk, snapshot);
              await clearDrainSnapshot(bb.storage.kv);
            }
          });
          if (skipScans) bb.log.info("Lane Pilot startup recovery: run, worktree and parked-task scans left to their schedules after a clean drain");
        }
        // A reload drops the loops that watch background helpers; the stages are idempotent and find their child thread
        // again. Started in the factory, their first host call failed with «unavailable during factory registration».
        await step("resume of background helpers", () => {
          // The after-acceptance graph run of a task is keyed by the task: a run the reload cut off is picked up again, one that never existed starts.
          for (const stage of listUnfinishedStages(db, ["memory-maintenance", "project-life"])) {
            services.startAfterAcceptance(stage.projectId, stage.runId, stage.taskId, stage.pmThreadId);
          }
        });
        await step("restore of the breakers", () => services.stability.restoreBreakers());
        // A version's first start is its deploy time: the canary counts the attempts from here.
        await step("canary start", () => services.canary.noteStart());
        await taskReconcile.reconcileTasks({ phase: "startup", step, afterResume: async () => {
          if (!skipScans) await step("run sweep", sweepRuns);
          if (!skipScans) await step("worktree sweep", sweepEnvironments);
        } });
        await step("adoption of waiting rules", () => {
          const adopted = adoptWaitingRules(db);
          if (adopted) bb.log.info(`Lane Pilot put ${adopted} waiting rule(s) on trial`);
        });
        await step("recovery of lost owner questions", () => ctx.ownerAsk.recoverLost());
        await step("browser check recovery", () => {
          const adopted = services.resumeBrowserQaThreads();
          if (adopted) bb.log.info(`Lane Pilot adopted ${adopted} browser check(s) left running by a reload`);
        });
      })();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    },
  });
  // Schedules of workflows follow their files: a workflow unpublished or edited outside the tab loses or changes its automation within the hour.
  scheduleIsolated(bb, "workflow-schedules", "23 * * * *", () => { for (const projectId of services.workflowTriggers.scheduledProjects()) services.workflowTriggers.syncSoon(projectId); }, { timeoutMs: 60_000 });
  scheduleIsolated(bb, "runs-sweep", "2,17,32,47 * * * *", sweepRuns, { timeoutMs: 10 * 60_000 });
  // The schedule board (src/schedule): every minute the due fire times become runs (keyed by schedule and time, so a repeated tick adds
  // nothing) and the runs are started and watched for up to 50 s. Runs live in the database: a reload loses no tick and no run.
  scheduleIsolated(bb, "schedule-board-tick", "* * * * *", (signal) => services.schedules.tick(signal).then(() => undefined,
    (cause) => pluginStopped(cause) ? undefined : bb.log.warn(`Lane Pilot schedule tick skipped: ${cause instanceof Error ? cause.message : String(cause)}`)), { timeoutMs: 2 * 60_000 });
  bb.log.info("Lane Pilot PM-to-writer pipeline loaded");
}
