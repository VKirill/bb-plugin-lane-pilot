import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { Services } from "./services";

/** `bb plugin rpc call lane-pilot memory_probe`: the memory probe (src/rooms/memory-probe/server/memory-probe.ts) for callers that have no CLI. */
export function memoryProbeRpc(services: Services) {
  return {
    memory_probe: async ({ projectId, paths, keep, force, action }) => action === "clean" ? { removed: services.memoryProbe.clean(projectId) }
      : action === "report" ? services.memoryProbe.report(projectId) : await services.memoryProbe.run({ projectId, paths, keep, force }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "memory_probe">;
}
