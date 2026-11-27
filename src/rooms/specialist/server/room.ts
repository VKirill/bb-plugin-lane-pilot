import type { Room } from "../../contracts";
import { specialistSettings } from "../settings";
import { runSpecialistCli, SPECIALIST_USAGE } from "./handlers/sp-cli";
import { specialistOverview } from "./services/sp-overview";

export const room: Room = {
  name: "specialist",
  settings: specialistSettings,
  cli: [
    {
      name: "specialist",
      summary: "Specialist OS autonomy table, grants, and revocations",
      usage: SPECIALIST_USAGE,
      fullHelp: true,
      run: ({ ctx, args, invocation }) => runSpecialistCli(ctx, args, invocation),
    },
  ],
  rpc: (ctx) => ({
    specialist_overview: async ({ projectId }: { projectId?: string }) => specialistOverview(ctx.db, projectId),
  }),
};
