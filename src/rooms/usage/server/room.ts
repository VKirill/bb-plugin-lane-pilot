import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { usageSettings } from "../settings";
import { tokenUsageRpc } from "./handlers/rpc/token-usage";

export const room: Room<unknown> = {
  name: "usage",
  settings: usageSettings,
  rpc: (ctx: ServerCore) => tokenUsageRpc(ctx),
};
