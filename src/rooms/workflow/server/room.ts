import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { workflowRoomMigrations } from "../migrations";
import { workflowSettings } from "../settings";
import { architectStartRpc } from "./handlers/architect-start";
import { workflowExportRpc } from "./handlers/rpc/workflow-export";
import { workflowOpsRpc } from "./handlers/rpc/workflow-ops";
import { workflowsRpc } from "./handlers/rpc/workflows";
import { RUN_VERDICT_USAGE, mountRunVerdictTool, runVerdictCli } from "./handlers/run-verdict-tool";
import { PATH_SAVE_USAGE, mountPathSaveTool, pathSaveCli } from "./handlers/path-save-tool";
import { WORKFLOW_PUBLISH_USAGE, workflowPublishCli } from "./handlers/workflow-publish-cli";
import { GRAPHS_CLI_USAGE, graphsCli } from "./handlers/graphs-cli";
import { createWorkflowArchitect } from "./services/workflow-architect";
import { WORKFLOW_PROVE_USAGE, workflowCli } from "./services/workflow-prove";

const WORKFLOW_CLI_USAGE = `${WORKFLOW_PROVE_USAGE} | ${WORKFLOW_PUBLISH_USAGE}`;

type WorkflowRpcServices = Parameters<typeof workflowsRpc>[1]
  & Parameters<typeof workflowExportRpc>[1]
  & Parameters<typeof workflowOpsRpc>[1]
  & Parameters<typeof architectStartRpc>[1]
  & Partial<Parameters<typeof createWorkflowArchitect>[1]>
  & { dedupeThreshold?: number | (() => number) };

export function createWorkflowRoom(options: { dedupeThreshold?: number | (() => number) } = {}): Room<WorkflowRpcServices> {
  return {
    name: "workflow",
    migrations: workflowRoomMigrations,
    settings: workflowSettings,
    rpc: (ctx: ServerCore, services: WorkflowRpcServices) => ({
      ...workflowsRpc(ctx, services),
      ...workflowExportRpc(ctx, services),
      ...workflowOpsRpc(ctx, services),
      ...architectStartRpc(ctx, services),
      ...createWorkflowArchitect(ctx, options.dedupeThreshold !== undefined ? { ...services, dedupeThreshold: options.dedupeThreshold } : services as Parameters<typeof createWorkflowArchitect>[1]).rpc,
    }),
    tools: (ctx, services) => {
      mountRunVerdictTool(ctx);
      mountPathSaveTool(ctx, options.dedupeThreshold !== undefined ? { ...services, dedupeThreshold: options.dedupeThreshold } : services);
    },
    cli: [
      {
        name: "run-verdict",
        summary: "Record the owner's verdict (accept or reject) on a finished workflow run",
        usage: RUN_VERDICT_USAGE,
        run: ({ ctx, args }) => runVerdictCli(ctx, args),
      },
      {
        name: "path",
        summary: "Save a finished workflow or errand run as a workflow draft",
        usage: PATH_SAVE_USAGE,
        run: ({ ctx, services, args, invocation }) => pathSaveCli(ctx, options.dedupeThreshold !== undefined ? { ...services, dedupeThreshold: options.dedupeThreshold } : services, args, invocation),
      },
      {
        name: "workflow",
        summary: "Prove a workflow graph on another provider/model or publish a tested draft with owner grant",
        usage: WORKFLOW_CLI_USAGE,
        run: ({ ctx, services, args, invocation }) =>
          args[0] === "publish"
            ? workflowPublishCli(ctx, services, args.slice(1), invocation)
            : workflowCli(ctx, services, args),
      },
      {
        name: "graphs",
        summary: "Record hub graph git export timestamp and check hub-to-git graph drift",
        usage: GRAPHS_CLI_USAGE,
        run: ({ ctx, args }) => graphsCli(ctx, args),
      },
    ],
  };
}

export const room: Room<WorkflowRpcServices> = createWorkflowRoom();
