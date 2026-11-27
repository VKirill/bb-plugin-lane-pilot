import type { WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { Room } from "../../contracts";
import { memorySettings } from "../settings";
import { registerCardActions } from "./handlers/cards-action";
import { CARD_USAGE, runCardsCli } from "./handlers/cards-cli";
import { mountCardTool } from "./handlers/cards-tool";

export const room: Room<{ workflowEngine?: WorkflowEngine }> = {
  name: "memory",
  settings: memorySettings,
  cli: [
    {
      name: "card",
      summary: "Typed knowledge cards in hub memory (niche, brand, contact, platform): set, get, list, verify",
      usage: CARD_USAGE,
      fullHelp: true,
      run: ({ ctx, args, invocation }) => runCardsCli(ctx, args, invocation),
    },
  ],
  tools: (ctx) => {
    mountCardTool(ctx);
  },
  startup: (ctx, services) => {
    if (services?.workflowEngine) registerCardActions(services.workflowEngine, ctx);
  },
};
