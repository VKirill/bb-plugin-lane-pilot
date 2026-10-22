import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { rpcContract } from "../../contracts";
import { forecastReport } from "./report";

/** The estimate-versus-fact report over RPC, the same read as `bb lane-pilot forecast`. */
export function forecastRpc(db: Database.Database) {
  return {
    forecast_report: async ({ projectId, days }) => forecastReport(db, { projectId, days }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "forecast_report">;
}
