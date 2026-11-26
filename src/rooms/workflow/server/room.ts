import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { workflowSettings } from "../settings";
import { architectStartRpc } from "./handlers/architect-start";
import { workflowExportRpc } from "./handlers/rpc/workflow-export";
import { workflowOpsRpc } from "./handlers/rpc/workflow-ops";
import { workflowsRpc } from "./handlers/rpc/workflows";
import { createWorkflowArchitect } from "./services/workflow-architect";

type WorkflowRpcServices = Parameters<typeof workflowsRpc>[1]
  & Parameters<typeof workflowExportRpc>[1]
  & Parameters<typeof workflowOpsRpc>[1]
  & Parameters<typeof architectStartRpc>[1];

export const room: Room<WorkflowRpcServices> = {
  name: "workflow",
  settings: workflowSettings,
  rpc: (ctx: ServerCore, services: WorkflowRpcServices) => ({
    ...workflowsRpc(ctx, services),
    ...workflowExportRpc(ctx, services),
    ...workflowOpsRpc(ctx, services),
    ...architectStartRpc(ctx, services),
    ...createWorkflowArchitect(ctx, services).rpc,
  }),
};
