import type Database from "better-sqlite3";
import { forecastReport } from "./report";

export const forecastRpc = (db: Database.Database) => ({
  forecast_report: async (input: { projectId?: string; days?: number }) => forecastReport(db, input),
});
