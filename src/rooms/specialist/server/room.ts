import type { Room } from "../../contracts";
import { specialistSettings } from "../settings";
import { specialistOverview } from "./services/sp-overview";

export const room: Room = {
  name: "specialist",
  settings: specialistSettings,
  rpc: (ctx) => ({
    specialist_overview: async ({ projectId }: { projectId?: string }) => specialistOverview(ctx.db, projectId),
  }),
};
