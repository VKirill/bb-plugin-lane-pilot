import type { z } from "zod";
import { stepExecutorSchema } from "@lane-pilot/contracts";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { rpcShell } from "./rpc-shell";
import { rpcNative } from "./rpc-native";
import { rpcRuns } from "./rpc-runs";
import { rpcSettings } from "./rpc-settings";
import { rpcOps } from "./rpc-ops";
import { rpcKnowledge } from "./rpc-knowledge";
import { rpcWorkflow } from "./rpc-workflow";
import { rpcWorkflowExport } from "./rpc-workflow-export";
import { rpcWorkflowMap } from "./rpc-workflow-map";
import { rpcConsole } from "./rpc-console";

// The RPC contracts of the plugin. The schemas are in schemas.ts, the host methods in host.ts and the methods of the
// screens in the rpc-*.ts parts; this file assembles them and is the only public file of the room.
export { HOST_JOB_KINDS, LP_EVENTS, WORKFLOW_NODE_TONES, installReceiptSchema, modelCatalogSchema, prototypeConfigSchema, secretNameSchema, settingValidationSchema, stepExecutorSchema, TASK_KINDS, TASK_V2_OPTIONAL, taskV2Schema, workflowDraftCheckSchema, workflowDraftPatchResultSchema, workflowDraftPublishResultSchema, workflowDraftSummarySchema, workflowDraftTestResultSchema, workflowStatsSchema, workflowTrialCaseSchema, workflowViewEdgeSchema, workflowViewNodeSchema, workflowViewSchema } from "@lane-pilot/contracts";
export type { HostJobKind, LpEventName, PrototypeConfig, TaskV2 } from "@lane-pilot/contracts";
export type StepExecutor = z.infer<typeof stepExecutorSchema>;
export { hostContract, hostMethods } from "./host";
export { QA_DEFAULT_PORTS } from "./host/desktop";
export { BIRTH_KINDS, BIRTH_GATES, birthGates, isCodeCriticDefault } from "./task-enums"
export { CODE_CRITIC_DEFAULTS } from "./task-enums";
export type { BirthKind, CodeCriticDefault } from "./task-enums";
export type { AcceptanceCard } from "./rpc-runs";
export { FREE_CLASSES, failureClass } from "./failure-class";
export { FAILED_ATTEMPT_STATES } from "./state-machine";

export const rpcMethods = {
  ...rpcShell,
  ...rpcNative,
  ...rpcRuns,
  ...rpcSettings,
  ...rpcOps,
  ...rpcKnowledge,
  ...rpcWorkflow,
  ...rpcWorkflowExport,
  ...rpcWorkflowMap,
  ...rpcConsole,
};

export const rpcContract = defineRpcContract(rpcMethods);
export * from "./gate-vocabulary";
export * from "./workflow-ids";
export * from "./service-models";
export * from "./skill-sequence";
export * from "./brief-mode";
export { default as bundledAgents } from "./bundled-agents.json";
export { LEAD_ID, LEAD_NAME, LEAD_SESSION, LEAD_SUMMARY, LEAD_TICK, LEAD_TOOLS } from "./lead-agent";
export { taskWordItemPrefix, type TaskWordDb, type TaskWordPort, type WordTask } from "./task-word";
export type { LaneProjectNotice } from "./lane-project";
export type { AnalyzerSelection, RuleScanSurface } from "./insights";
export type { ErrandOutcome, ErrandVerifiedOutcome } from "./errand-episodes";
export { SANDBOX_OWN_ENV } from "./sandbox-own-env";
export { NO_RED_KINDS } from "./baseline-vocabulary";
export { parseExecutionLineWindows, type LineWindow, type PathWindows } from "./execution-line-windows";
export { type EvalData, type MemoryEvalReport, type MemoryEvalRunner, type RawNote, type RawQuestion, type RawTask } from "./memory-eval";
export type { AgentScheduleRef, ScheduleAgentApi } from "./schedule-agents";
export type { ErrandRunStart, ErrandsApi } from "./errands-api";
export type { LeadRoadApi, RoadDb, RoadEvidence, RoadKind, RoadRow, RoadSource, RoadState } from "./lead-road";
export type { SqlDb } from "./sql-db";
export { asJsonText } from "./as-json-text";
export * from "./state-machine";
export * from "./hub-deny";
export * from "./owner-only-rpc";
export * from "./failure-class";
export * from "./helper-context";
export * from "./codex-lean";
export * from "./helper-placement";
export * from "./agent-display";
export * from "./native-agent-id";
export * from "./employee-manifest";
export * from "./project-scope";
export * from "./quality-mode";
export * from "./composer-selection";
export * from "./thread-rule";
export * from "./ownership";
export * from "./check-commands";
export * from "./machine-pressure";
export * from "./review-vocabulary";
export * from "./agent-picker";
export * from "./native-selection";
export * from "./integration-gate";
export * from "./stability-api";
export * from "./docs-nightly-api";
export * from "./stage-children-api";
export * from "./merge-intents";
export * from "./agent-ops";
export * from "./planning-root";
export { NO_WAY_OUT, WAY_OUT, wayOut } from "./way-out";
export { spawnClaimed } from "./spawn-claim";
export type { IsTaskSatisfied } from "./runs-api";
export * from "./worktrees";
export { NATIVE_HOOK_SOURCES } from "./native-hook-sources";
export * from "./service-notice";
export { INTAKE_KINDS, SERVICE_KINDS, isMachineMessage } from "./intake";
export type { HandOverResult, HandOverStarted, IntakeKind, IntakeRecord, PhaseIntake, ServiceKind } from "./intake";

export type { NativeSelection } from "./native-selection";
export type { Room, RoomCliCall, RoomCliVerb } from "./room";
export * from "./owner-turn";
export * from "./owner-messages";
export { BRAKE_IDS } from "./rpc-console";
export type {
  ActionsLogOutput,
  ActiveItem,
  AgentLoadoutOutput,
  AutonomousAction,
  BrakeId,
  BrakeState,
  BrakesOutput,
  ConsoleOverviewOutput,
  DrillSummaryRow,
  DrillsListOutput,
  GoalLine,
  LoadoutRole,
  MemoryCardsListOutput,
  OutageRow,
  OutagesListOutput,
  RepoTrustOutput,
  ReviewDeskItem,
  ReviewDeskView,
  SpecialistAutonomyRow,
  SpecialistDetailOutput,
  StopAllOutput,
  TaskHistoryOutput,
  TaskHistoryRow,
  ThreadScope,
} from "./rpc-console";
