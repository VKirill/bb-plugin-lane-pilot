import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { critiqueMigrations } from "../migrations";
import { critiqueSettings } from "../settings";
import { critiqueRpc } from "./handlers/rpc";

export const room: Room<unknown> = {
  name: "critique",
  migrations: critiqueMigrations,
  settings: critiqueSettings,
  rpc: (ctx: ServerCore) => critiqueRpc(ctx),
};
