import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { secretsSettings } from "../settings";
import { secretsRpc } from "./handlers/secrets-rpc";

export const room: Room<unknown> = {
  name: "secrets",
  settings: secretsSettings,
  rpc: (ctx: ServerCore) => secretsRpc(ctx),
};
