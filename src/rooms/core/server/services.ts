import type { CouncilApi } from "../../council/server";
import type { ErrandsApi } from "../../qa/server";
import type { ScheduleService } from "../../schedule/server";
import type { RuleScanApi } from "../../self-repair/server";
import type { HarnessApi } from "../../harness/server";
import type { DeferralApi } from "../../deferral/server";
import type { RollbackApi } from "../../rollback/server";
import type { BenchApi } from "../../bench/server";
import type { BaselineApi, RegressionApi } from "../../baseline/server";
import type { RunGoalApi } from "../../run-goal/server";
import type { PhaseApi } from "../../phase/server";
import type { MoneyApi } from "../../money";
import type { CapabilitiesApi } from "../../capability/server";
import type { BacklogApi } from "../../backlog/server";
import type { HypothesesApi } from "../../hypotheses/server";
import type { OwnerPresenceApi } from "../../owner-presence/server";
import type { WallApi } from "../../wall/server";
import type { CheckersApi } from "../../checkers/server";
import type { StageReturnApi } from "../../stage-return/server";
import type { WorldApi } from "../../world/server";
import type { Canary } from "../../stability/server";
import type { createActivation } from "../../native-agent/server";
import type { createDocsNightly } from "../../docs/server";
import type { createProbes } from "../../stability/server";
import type { createMemoryProbe } from "../../memory-probe/server";
import type { MemoryConflictsApi } from "../../memory/server";
import type { createReconcile } from "../../stability/server";
import type { createStability } from "../../stability/server";
import type { createStageChildren } from "../../qa/server";
import type { createDocsStage } from "../../docs/server";
import type { createMemoryStage } from "../../memory/server";
import type { createNightStages } from "../../night/server";
import type { createOnboardingStage } from "../../project-life/server";
import type { createProjectLifeStage } from "../../project-life/server";
import type { createQaStages } from "../../qa/server";
import type { createWriterHost } from "../../writer/server";
import type { createWriterState } from "../../writer/server";
import type { createWriterSpawn } from "../../writer/server";
import type { createWriterVerify } from "../../writer/server";
import type { createWriterFinish } from "../../writer/server";
import type { createWriterStart } from "../../writer/server";
import type { createWriterDispatch } from "../../writer/server";
import type { createWorkflowEngine } from "../../workflow/server";
import type { createWorkflowTriggersService } from "../../workflow/server";

type ActivationApi = ReturnType<typeof createActivation>;
type DocsNightlyApi = ReturnType<typeof createDocsNightly>;
type ProbesApi = ReturnType<typeof createProbes>;
type ReconcileApi = ReturnType<typeof createReconcile>;
type StageChildrenApi = ReturnType<typeof createStageChildren>;
type DocsStageApi = ReturnType<typeof createDocsStage>;
type MemoryStageApi = ReturnType<typeof createMemoryStage>;
type NightStagesApi = ReturnType<typeof createNightStages>;
type OnboardingStageApi = ReturnType<typeof createOnboardingStage>;
type ProjectLifeStageApi = ReturnType<typeof createProjectLifeStage>;
type QaStagesApi = ReturnType<typeof createQaStages>;
type WriterHostApi = ReturnType<typeof createWriterHost>;
type WriterStateApi = ReturnType<typeof createWriterState>;
type WriterSpawnApi = ReturnType<typeof createWriterSpawn>;
type WriterVerifyApi = ReturnType<typeof createWriterVerify>;
type WriterFinishApi = ReturnType<typeof createWriterFinish>;
type WriterStartApi = ReturnType<typeof createWriterStart>;
type WriterDispatchApi = ReturnType<typeof createWriterDispatch>;
type WorkflowEngineApi = ReturnType<typeof createWorkflowEngine>;
type WorkflowTriggersApi = ReturnType<typeof createWorkflowTriggersService>;

/** Every function one server module offers another; filled once all modules exist, read at call time. */
export interface Services {
  council: CouncilApi;
  /** The Pixel World tick service (src/rooms/world). */
  world: WorldApi;
  canary: Canary;
  ruleScan: RuleScanApi;
  harness: HarnessApi;
  /** The register of deferrals with the owner's terms (src/rooms/deferral). */
  deferrals: DeferralApi;
  /** The record of every attempt's base and change, and reverify / revert of accepted work (src/rooms/rollback). */
  rollback: RollbackApi;
  /** LP-Bench: the fixed task set and its comparisons (src/rooms/bench). */
  bench: BenchApi;
  /** The task's checks on its base before a writer, and what turned red after the merge (src/rooms/baseline). */
  baseline: BaselineApi;
  /** Sends a task back to an earlier stage with a note (src/rooms/stage-return). */
  stageReturn: StageReturnApi;
  /** The regression pass: accepted tasks' checks on current main, bisect of the ones that went red (src/rooms/baseline). */
  regression: RegressionApi;
  /** The wall journal and the night loop: classes of failures, the night's repairs, the wall ladder (src/rooms/wall). */
  wall: WallApi;
  /** Every accepted task's checks together on the final main once a run is done (src/rooms/run-goal). */
  runGoal: RunGoalApi;
  /** Phases on rails: the driver that moves a phase through its stages by gates in code and wakes the PM at each turn (src/rooms/phase). */
  phases: PhaseApi;
  /** The spend book, the money cap of paid lanes and the subscription windows (src/rooms/money). */
  money: MoneyApi;
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
  DOCS_NIGHT_ATTEMPTS: DocsNightlyApi["DOCS_NIGHT_ATTEMPTS"];
  DOCS_OPEN_KEY: DocsNightlyApi["DOCS_OPEN_KEY"];
  DOCS_TOOLING: DocsNightlyApi["DOCS_TOOLING"];
  DOCS_UNITS_OPEN_KEY: DocsNightlyApi["DOCS_UNITS_OPEN_KEY"];
  DOCS_UNIT_CONCURRENCY: DocsNightlyApi["DOCS_UNIT_CONCURRENCY"];
  WORKSPACE_DOCS_MIN_FILES: DocsNightlyApi["WORKSPACE_DOCS_MIN_FILES"];
  docsVerdict: DocsNightlyApi["docsVerdict"];
  docsPlaces: DocsNightlyApi["docsPlaces"];
  docsPlaceStatus: DocsNightlyApi["docsPlaceStatus"];
  docsLastRead: DocsNightlyApi["docsLastRead"];
  activate: ActivationApi["activate"];
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  providerBreaker: WriterStateApi["providerBreaker"];
  providerUsage: WriterStateApi["providerUsage"];
  providerRetry: WriterStateApi["providerRetry"];
  concurrencyLimit: WriterStateApi["concurrencyLimit"];
  runBudgets: WriterStateApi["runBudgets"];
  runBudgetFor: WriterStateApi["runBudgetFor"];
  applyOnboardingPreview: OnboardingStageApi["applyOnboardingPreview"];
  assertComposerEnvironment: ActivationApi["assertComposerEnvironment"];
  dispatchCli: WriterDispatchApi["dispatchCli"];
  dispatchWriter: WriterDispatchApi["dispatchWriter"];
  resumeDispatch: WriterDispatchApi["resumeDispatch"];
  docsPassesRunning: DocsNightlyApi["docsPassesRunning"];
  docsSpawnGate: DocsNightlyApi["docsSpawnGate"];
  docsUnitRecordKey: DocsNightlyApi["docsUnitRecordKey"];
  docsUnitsFinishing: DocsNightlyApi["docsUnitsFinishing"];
  docsUnitsIndexChain: DocsNightlyApi["docsUnitsIndexChain"];
  dropDocsUnitRecord: DocsNightlyApi["dropDocsUnitRecord"];
  enqueueResumedWriter: ReconcileApi["enqueueResumedWriter"];
  finishDocsUnit: DocsNightlyApi["finishDocsUnit"];
  finishWriterAttempt: WriterFinishApi["finishWriterAttempt"];
  ingestOpenCodeTelemetry: QaStagesApi["ingestOpenCodeTelemetry"];
  listedAgentProfiles: WriterHostApi["listedAgentProfiles"];
  maintainMemoryAfterAcceptance: MemoryStageApi["maintainMemoryAfterAcceptance"];
  maintainProjectLifeAfterAcceptance: ProjectLifeStageApi["maintainProjectLifeAfterAcceptance"];
  maybeFinishResumedAttempt: ReconcileApi["maybeFinishResumedAttempt"];
  persistWriterAcceptance: WriterVerifyApi["persistWriterAcceptance"];
  pluginStopped: DocsNightlyApi["pluginStopped"];
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
  runDocsCatchUps: DocsNightlyApi["runDocsCatchUps"];
  runDocsMaintenance: DocsStageApi["runDocsMaintenance"];
  runDocsUnit: DocsNightlyApi["runDocsUnit"];
  runGateTriage: NightStagesApi["runGateTriage"];
  runMemoryContext: MemoryStageApi["runMemoryContext"];
  runMemoryMaintenance: MemoryStageApi["runMemoryMaintenance"];
  runNightFix: NightStagesApi["runNightFix"];
  runNightReview: NightStagesApi["runNightReview"];
  runNightlyDocs: DocsNightlyApi["runNightlyDocs"];
  runOnboardingPreview: OnboardingStageApi["runOnboardingPreview"];
  runProjectLifeMaintenance: ProjectLifeStageApi["runProjectLifeMaintenance"];
  runScheduledDocsMaintenance: DocsNightlyApi["runScheduledDocsMaintenance"];
  runVerification: WriterVerifyApi["runVerification"];
  runWorkspaceStatus: NightStagesApi["runWorkspaceStatus"];
  runWriterPool: WriterStateApi["runWriterPool"];
  saveDocsUnitRecord: DocsNightlyApi["saveDocsUnitRecord"];
  selectionCatalogHost: WriterHostApi["selectionCatalogHost"];
  spawnDocsThread: DocsNightlyApi["spawnDocsThread"];
  spawnWriterAttempt: WriterSpawnApi["spawnWriterAttempt"];
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  restoreLiveFolder: WriterSpawnApi["restoreLiveFolder"];
  startAmbiguousProbe: ProbesApi["startAmbiguousProbe"];
  startCancelProbe: ProbesApi["startCancelProbe"];
  startProviderErrorProbe: ProbesApi["startProviderErrorProbe"];
  startHelperProbe: ProbesApi["startHelperProbe"];
  memoryProbe: ReturnType<typeof createMemoryProbe>;
  /** Memory notes that disagree: held out of every brief until a person settles them (src/rooms/memory/server/memory-conflicts.ts). */
  memoryConflicts: MemoryConflictsApi;
  startWriterTask: WriterStartApi["startWriterTask"];
  stability: ReturnType<typeof createStability>["stability"];
  threadReconcilePort: ReconcileApi["threadReconcilePort"];
  unitWritable: DocsNightlyApi["unitWritable"];
  updateDocsUnitsIndex: DocsNightlyApi["updateDocsUnitsIndex"];
  validateWriterResult: WriterVerifyApi["validateWriterResult"];
  waitWriter: WriterDispatchApi["waitWriter"];
  workspaceDirt: WriterSpawnApi["workspaceDirt"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowAgents: WorkflowEngineApi["workflowAgents"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
  /** The errand starter of the PM tools (also used by scheduled errands); set when the tools are mounted. */
  errands: ErrandsApi;
  /** The schedule board: scheduler, definitions, previews (src/server/schedule-service.ts). */
  schedules: ScheduleService;
}
