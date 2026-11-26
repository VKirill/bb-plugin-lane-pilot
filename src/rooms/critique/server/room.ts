import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { critiqueSettings } from "../settings";
import { critiqueRpc } from "./handlers/rpc";

export const room: Room<unknown> = {
  name: "critique",
  settings: critiqueSettings,
  rpc: (ctx: ServerCore) => critiqueRpc(ctx),
};
