import type { WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { Room } from "../../contracts";
import { reportsSettings } from "../settings";
import { DESK_USAGE, runDeskCli } from "./handlers/desk-cli";

export type ReportsRoomServices = {
  workflowEngine?: WorkflowEngine;
};

export const room: Room<ReportsRoomServices> = {
  name: "reports",
  settings: reportsSettings,
  cli: [
    {
      name: "desk",
      summary: "Weekly owner review desk (show, answer, accept-defaults)",
      usage: DESK_USAGE,
      fullHelp: true,
      run: ({ ctx, services, args, invocation }) => runDeskCli(ctx, services as never, args, invocation),
    },
  ],
};
