import type { Room } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { stabilitySettings } from "../settings";
import { canaryRpc } from "./handlers/canary";
import { stabilityRpc } from "./handlers/rpc";
import type { Canary } from "./services/canary";

type StabilityRpcServices = {
  canary: Canary;
};

export const room: Room<StabilityRpcServices> = {
  name: "stability",
  settings: stabilitySettings,
  rpc: (ctx: ServerCore, services: StabilityRpcServices) => ({
    ...canaryRpc(services.canary),
    ...stabilityRpc(ctx),
  }),
};
