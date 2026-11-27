import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { outageMigrations } from "../migrations";
import { listRecentOutages } from "./services/outage-service";

export const room: Room<unknown> = {
  name: "outage",
  migrations: outageMigrations,
  rpc: (ctx: ServerCore) => ({
    outages_list: async ({ days }: { days: number }) => ({
      outages: listRecentOutages(ctx.db, days),
    }),
  }),
};
