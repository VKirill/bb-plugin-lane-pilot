// The one services bag: every function one server module offers another. server.ts fills it, every composition file reads it.
import type { AutonomousAction, LaneProjectNotice, LeadRoadApi, MemoryEvalRunner, RuleScanSurface, ScheduleAgentApi, TaskWordPort } from "./contracts";
import type { TokenCursorReader } from "./work-graph/server";
import type { MemorySettings } from "@lane-pilot/memory-core";
import type { ActivationApi, AgentOpsApi } from "./contracts/agent-ops";
import type { MergeIntentsApi } from "./contracts/merge-intents";
import type { VerificationGatePort } from "./contracts/integration-gate";
import type { IsTaskSatisfied } from "./contracts";
import type { DocsApi } from "./docs/server";
import type { ReconcileApi } from "./stability/server";
import type { StabilityApi } from "./stability/server";
import type { StageChildrenApi } from "./qa/server";
import type { MemoryStageApi } from "./memory/server";
import type { WorkspaceStatusApi } from "./qa/server";
import type { QaStagesApi } from "./qa/server";
import type { WriterHostApi } from "./writer/server";
import type { WriterStateApi } from "./writer/server";
import type { WriterSpawnApi } from "./writer/server";
import type { WriterVerifyApi } from "./writer/server";
import type { WriterFinishApi } from "./writer/server";
import type { WriterStartApi } from "./writer/server";
import type { WriterDispatchApi } from "./writer/server";
import type { ArchitectApi, AttemptReopenApi, BuildCliInvocation, RecheckPlanFact, StageHelperSettings, TaskUsage, WorkflowEngineApi, WorkflowLibraryApi, WriterReassignApi } from "./platform/server";
import type { WorkflowTriggersApi } from "./workflow/server";
import type { ResolveCanary } from "./workflow/server";
import type { OnAttemptFinished } from "./workflow/server";
import type { MemoryProbeApi } from "./memory-probe/server";
import type { ErrandsApi } from "./errands/server";
import type { ScheduleService } from "./schedule/server";
import type { DeferralApi } from "./deferral/server";
import type { RollbackApi } from "./rollback/server";
import type { BaselineApi } from "./baseline/server";
import type { PhaseIntake } from "./contracts/server";
import type { MoneyApi } from "./money";
import type { FrontApi } from "./front";
import type { BacklogApi } from "./backlog/server";
import type { OwnerPresenceApi } from "./owner-presence/server";
import type { CheckersApi } from "./checkers/server";
import type { StageReturnApi } from "./stage-return/server";
import type { Canary } from "./stability/server";
import type { MemoryConflictsApi } from "./memory/server";

/** Every function one server module offers another; filled once all modules exist, read at call time. */
export interface Services {
  canary: Canary;
  ruleScan: RuleScanSurface;
  /** The register of deferrals with the owner's terms (src/rooms/deferral). */
  deferrals: DeferralApi;
  /** The record of every attempt's base and change, and reverify / revert of accepted work (src/rooms/rollback). */
  rollback: RollbackApi;
  /** The task's checks on its base before a writer, and what turned red after the merge (src/rooms/baseline). */
  baseline: BaselineApi;
  /** The usage room's token-cursor read (src/rooms/usage); rooms that cannot import usage get it here. */
  tokenCursorRow: TokenCursorReader;
  /** Sends a task back to an earlier stage with a note (src/rooms/stage-return). */
  stageReturn: StageReturnApi;
  /** The writer's settings→argv builder, handed to the settings screen's preview (src/rooms/writer/argv-builder.ts). */
  buildCliInvocation: BuildCliInvocation;
  /** Rails by default: the owner's newest message in a PM chat read before the PM acts (src/rooms/workflow/server/intake.ts). */
  phaseIntake: PhaseIntake;
  /** The spend book, the money cap of paid lanes and the subscription windows (src/rooms/money). */
  money: MoneyApi;
  /** First-run onboarding interview RPC handlers (src/rooms/front). */
  front: FrontApi;
  /** The backlog scanner: ready todos with an estimate issued to the project's PM in queue order (src/rooms/backlog). */
  backlog: BacklogApi;
  /** The owner's presence on a provider in the last minutes: writers keep off it (src/rooms/owner-presence). */
  ownerPresence: OwnerPresenceApi;
  /** Checking the checkers: planted defects in accepted candidates, the checker scorecard and the drill (src/rooms/checkers). */
  checkers: CheckersApi;
  docsVerdict: DocsApi["docsVerdict"];
  docsPlaces: DocsApi["docsPlaces"];
  docsPlaceStatus: DocsApi["docsPlaceStatus"];
  docsLastRead: DocsApi["docsLastRead"];
  activate: ActivationApi["activate"];
  placeEmployeeOn: AgentOpsApi["placeEmployeeOn"];
  storeNativeSelection: AgentOpsApi["storeNativeSelection"];
  compileEffectiveMainAgent: AgentOpsApi["compileEffectiveMainAgent"];
  detectCompiledMainAgentCapability: AgentOpsApi["detectCompiledMainAgentCapability"];
  pendingSwitch: AgentOpsApi["pendingSwitch"];
  resolveIntegrationGate: VerificationGatePort;
  isTaskSatisfied: IsTaskSatisfied;
  recoverMergeIntents: MergeIntentsApi["recoverMergeIntents"];
  recoverRevertIntents: RollbackApi["recoverRevertIntents"];
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  providerBreaker: WriterStateApi["providerBreaker"];
  providerUsage: WriterStateApi["providerUsage"];
  providerRetry: WriterStateApi["providerRetry"];
  concurrencyLimit: WriterStateApi["concurrencyLimit"];
  runBudgets: WriterStateApi["runBudgets"];
  runBudgetFor: WriterStateApi["runBudgetFor"];
  dispatchWriter: WriterDispatchApi["dispatchWriter"];
  resumeDispatch: WriterDispatchApi["resumeDispatch"];
  enqueueResumedWriter: ReconcileApi["enqueueResumedWriter"];
  finishWriterAttempt: WriterFinishApi["finishWriterAttempt"];
  ingestOpenCodeTelemetry: QaStagesApi["ingestOpenCodeTelemetry"];
  listedAgentProfiles: WriterHostApi["listedAgentProfiles"];
  persistWriterAcceptance: WriterVerifyApi["persistWriterAcceptance"];
  readWriterWorkspaceFile: WriterDispatchApi["readWriterWorkspaceFile"];
  reconcileAttemptThread: ReconcileApi["reconcileAttemptThread"];
  reconcileStageChild: StageChildrenApi["reconcileStageChild"];
  recoverLostHolderThread: ReconcileApi["recoverLostHolderThread"];
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  resumeOrphans: ReconcileApi["resumeOrphans"];
  recheckCancels: ReconcileApi["recheckCancels"];
  runBrowserQa: QaStagesApi["runBrowserQa"];
  resumeBrowserQaThreads: QaStagesApi["resumeBrowserQaThreads"];
  runMemoryContext: MemoryStageApi["runMemoryContext"];
  runMemoryMaintenance: MemoryStageApi["runMemoryMaintenance"];
  runVerification: WriterVerifyApi["runVerification"];
  runWorkspaceStatus: WorkspaceStatusApi["runWorkspaceStatus"];
  runWriterPool: WriterStateApi["runWriterPool"];
  selectionCatalogHost: WriterHostApi["selectionCatalogHost"];
  selectionCatalog: WriterHostApi["selectionCatalog"];
  spawnWriterAttempt: WriterSpawnApi["spawnWriterAttempt"];
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  restoreLiveFolder: WriterSpawnApi["restoreLiveFolder"];
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
  onAttemptFinished: OnAttemptFinished;
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
  /** The errand starter of the PM tools (also used by scheduled errands); set in server.ts before the tools mount. */
  errands: ErrandsApi;
  /** Starts a named agent for a scheduled `agent` run and reads its report; set when the tools are mounted. */
  /** The schedule board: scheduler, definitions, previews (src/server/schedule-service.ts). */
  schedules: ScheduleService;
  /** The lead's task-word ask/answer, handed to the writer and the queue tool (src/rooms/lead). */
  taskWords: TaskWordPort;
  /** The Lane Pilot project resolve + notice, handed to lead and the workflow rooms (src/rooms/platform). */
  laneProject: LaneProjectNotice;
  /** The lead's road writes/reads, handed to workflow and verification (src/rooms/lead). */
  leadRoad: LeadRoadApi;
  memorySettings: (settings: Record<string, unknown>) => MemorySettings;
  /** The schedule board's active-agent read, handed to the native-agent registry (src/rooms/schedule). */
  scheduleAgents: ScheduleAgentApi;
  /** The memory evaluation runner (src/rooms/memory-eval). */
  memoryEval: MemoryEvalRunner;
  /** Structural dedup threshold (0.5-1.0) from lead settings, passed into the workflow room. */
  dedupeThreshold?: number | (() => number);
  /** Resolves an open canary trial and candidate draft definition for a workflow (src/rooms/evolve). */
  resolveCanary?: ResolveCanary;
  /** Publishes an approved or canary-winning evolution workflow draft through the publish authority. */
  evolvePublishDraft?: (input: { draftId: string; ownerGrant?: boolean; threadId?: string }) => Promise<{ ok: boolean; projectId?: string; message: string; version?: number }>;
  /** Rolls back a promoted evolution workflow draft to its prior snapshot or factory built-in. */
  evolveRollbackDraft?: (input: { draftId: string; threadId?: string }) => Promise<{ ok: boolean; projectId?: string; message: string }>;
  /** Ports wired in server.ts for the event-driven `lp.evolve` handlers (avoiding room import cycles). */
  evolveWorkflowDeps?: import("./evolve/server").EvolveWorkflowDeps;
  /** Workflow-owned settled effects read for `actions_log` (wired in server.ts to avoid room cycles). */
  autonomousEffects?: (db: import("./storage").LanePilotDatabase, since?: number, limit?: number, projectId?: string) => AutonomousAction[];
  /** Lead-owned autonomous decisions read for `actions_log` (wired in server.ts to avoid room cycles). */
  leadDecisions?: (db: import("./storage").LanePilotDatabase, since?: number, limit?: number, projectId?: string) => AutonomousAction[];
  /** Reports-owned loop health read for `specialist_detail` (wired in server.ts to avoid room cycles). */
  loopHealth?: (db: import("./storage").LanePilotDatabase, options?: { now?: number; projectId?: string | null; domain?: string }) => import("@lane-pilot/contracts").LoopHealthEntry[];
  /** Workflow-owned run metadata read for `specialist_detail` (wired in server.ts to avoid room cycles). */
  wfRunMeta?: (db: import("./storage").LanePilotDatabase, runIds: readonly string[]) => Map<string, import("@lane-pilot/workflow-engine").WfRunMetaRow>;
}
