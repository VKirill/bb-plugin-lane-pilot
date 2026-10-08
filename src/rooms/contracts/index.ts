import { defineRpcContract } from "@get-bb/plugin-sdk";
import { rpcShell } from "./rpc-shell";
import { rpcNative } from "./rpc-native";
import { rpcRuns } from "./rpc-runs";
import { rpcSettings } from "./rpc-settings";
import { rpcOps } from "./rpc-ops";
import { rpcKnowledge } from "./rpc-knowledge";
import { rpcWorkflow } from "./rpc-workflow";

// The RPC contracts of the plugin. The schemas are in schemas.ts, the host methods in host.ts and the methods of the
// screens in the rpc-*.ts parts; this file assembles them and is the only public file of the room.
export { HOST_JOB_KINDS, WORKFLOW_NODE_TONES, installReceiptSchema, modelCatalogSchema, prototypeConfigSchema, secretNameSchema, settingValidationSchema, stepExecutorSchema, taskV2Schema, workflowDraftCheckSchema, workflowDraftPatchResultSchema, workflowDraftPublishResultSchema, workflowDraftSummarySchema, workflowDraftTestResultSchema, workflowStatsSchema, workflowTrialCaseSchema, workflowViewEdgeSchema, workflowViewNodeSchema, workflowViewSchema } from "./schemas";
export type { HostJobKind, PrototypeConfig, TaskV2 } from "./schemas";
export { hostContract } from "./host";

export const rpcContract = defineRpcContract({
  ...rpcShell,
  ...rpcNative,
  ...rpcRuns,
  ...rpcSettings,
  ...rpcOps,
  ...rpcKnowledge,
  ...rpcWorkflow,
});
