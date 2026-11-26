import type { Room } from "../../contracts";
import { workGraphRpc } from "./handlers/rpc";

type WorkGraphServices = Parameters<typeof workGraphRpc>[1];

export const room: Room<WorkGraphServices> = {
  name: "work-graph",
  rpc: (ctx, services) => workGraphRpc(ctx, services),
};
