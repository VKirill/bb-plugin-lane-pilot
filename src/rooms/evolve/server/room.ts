import type { WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { Room } from "../../contracts";
import { evolveMigrations } from "../migrations";
import { evolveSettings } from "../settings";
import { EVOLVE_USAGE, runEvolveCli, type EvolveCliServices } from "./handlers/evolve-cli";
import { registerEvolveActions, type EvolveWorkflowDeps } from "./handlers/evolve-workflows";

export type EvolveRoomServices = EvolveCliServices & EvolveWorkflowDeps & {
  workflowEngine?: WorkflowEngine;
  evolveWorkflowDeps?: EvolveWorkflowDeps;
};

export const room: Room<EvolveRoomServices> = {
  name: "evolve",
  migrations: evolveMigrations,
  settings: evolveSettings,
  startup: (ctx, services) => {
    if (services.workflowEngine) {
      registerEvolveActions(services.workflowEngine, ctx, {
        ...services,
        ...services.evolveWorkflowDeps,
      });
    }
  },
  cli: [
    {
      name: "evolve",
      summary: "Per-graph evolution case sets and hypothesis decisions (cases, rotate, approve, reject)",
      usage: EVOLVE_USAGE,
      fullHelp: true,
      run: ({ ctx, services, args }) => runEvolveCli(ctx, args, services),
    },
  ],
};
