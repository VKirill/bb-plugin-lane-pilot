import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { createBrakesService, type BrakesDeps } from "../services/brakes-service";
import type { createManualModeService } from "../services/manual-mode-service";

/** Console RPC handlers for global brakes (`brakes_get`, `brakes_set`, `stop_all`). */
export function brakesRpc(ctx: ServerCore, deps: BrakesDeps) {
  const log = deps.log ?? {
    info: (message: string) => ctx.bb.log.info(message),
    warn: (message: string) => ctx.log(message),
  };
  const service = createBrakesService({ ...deps, log });
  return {
    brakes_get: async () => service.get(),
    brakes_set: async (input) => service.set(input),
    stop_all: async (input) => service.stopAll(input),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "brakes_get" | "brakes_set" | "stop_all">;
}

/** Console RPC handlers for «Ручной режим» (`manual_mode_get`, `manual_mode_set`). */
export function manualModeRpc(service: ReturnType<typeof createManualModeService>) {
  return {
    manual_mode_get: async () => service.get(),
    manual_mode_set: async (input) => service.set(input),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "manual_mode_get" | "manual_mode_set">;
}
