import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { WallApi } from "../service";

/** The night loop over RPC: the same reads and the same night run as `bb lane-pilot wall`. */
export function wallRpc(wall: WallApi) {
  return {
    wall_status: async () => wall.status(),
    wall_show: async ({ key }) => wall.show(key),
    wall_night: async ({ dryRun }) => await wall.runNight({ dryRun }),
    wall_config: async (patch) => (Object.keys(patch).length ? await wall.setConfig(patch) : await wall.config()),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "wall_status" | "wall_show" | "wall_night" | "wall_config">;
}
