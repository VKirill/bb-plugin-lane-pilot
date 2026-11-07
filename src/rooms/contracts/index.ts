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
import { rpcWorld } from "./rpc-world";

// The RPC contracts of the plugin. The schemas are in schemas.ts, the host methods in host.ts and the methods of the
// screens in the rpc-*.ts parts; this file assembles them and is the only public file of the room.
export { HOST_JOB_KINDS, WORKFLOW_NODE_TONES, installReceiptSchema, modelCatalogSchema, prototypeConfigSchema, secretNameSchema, settingValidationSchema, stepExecutorSchema, TASK_KINDS, TASK_V2_OPTIONAL, taskV2Schema, workflowDraftCheckSchema, workflowDraftPatchResultSchema, workflowDraftPublishResultSchema, workflowDraftSummarySchema, workflowDraftTestResultSchema, workflowStatsSchema, workflowTrialCaseSchema, workflowViewEdgeSchema, workflowViewNodeSchema, workflowViewSchema } from "@lane-pilot/contracts";
export type { HostJobKind, PrototypeConfig, TaskV2 } from "@lane-pilot/contracts";
export { hostContract, hostMethods } from "./host";
export { BIRTH_KINDS, CODE_CRITIC_DEFAULTS, isCodeCriticDefault } from "./task-enums";
export type { BirthKind, CodeCriticDefault } from "./task-enums";
export type { AcceptanceCard } from "./rpc-runs";

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
  ...rpcWorld,
};

export const rpcContract = defineRpcContract(rpcMethods);
export * from "./gate-vocabulary";
export * from "./workflow-ids";
export { default as bundledAgents } from "./bundled-agents.json";
export { LEAD_ID, LEAD_LAUNCH, LEAD_NAME, LEAD_SESSION, LEAD_SUMMARY, LEAD_TICK, LEAD_TOOLS } from "./lead-agent";
export { taskWordItemPrefix, type TaskWordDb, type TaskWordPort, type WordTask } from "./task-word";
export type { LaneProjectNotice } from "./lane-project";
export type { InsightsApi, AnalyzerSelection, RuleScanSurface } from "./insights";
export type { ErrandEpisodesApi, ErrandOutcome, ErrandVerifiedOutcome } from "./errand-episodes";
export type { WallConfigStatus } from "./wall-api";
export { SANDBOX_OWN_ENV } from "./sandbox-own-env";
export { NO_RED_KINDS } from "./baseline-vocabulary";
export { parseExecutionLineWindows, type LineWindow, type PathWindows } from "./execution-line-windows";
export { type EvalData, type MemoryEvalReport, type MemoryEvalRunner, type RawNote, type RawQuestion, type RawTask } from "./memory-eval";
export type { AgentScheduleRef, ScheduleAgentApi } from "./schedule-agents";
export type { ErrandRunStart, ErrandsApi } from "./errands-api";
export type { LeadRoadApi, RoadDb, RoadEvidence, RoadKind, RoadRow, RoadSource, RoadState } from "./lead-road";
export type { SqlDb } from "./sql-db";
