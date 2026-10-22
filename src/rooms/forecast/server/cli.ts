import type Database from "better-sqlite3";
import { forecastReport } from "./report";

export const FORECAST_USAGE = "bb lane-pilot forecast [--project P] [--days 30] [--json]   (the PM's forecasts against the facts, per area)";

type Result = { exitCode: number; stdout?: string; stderr?: string };

export function runForecastCli(db: Database.Database, argv: readonly string[], now = Date.now()): Result {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const hit = /^--(project|days|json)(?:=(.*))?$/.exec(argv[i]!);
    if (!hit) return { exitCode: 1, stderr: `unknown argument ${argv[i]}\n${FORECAST_USAGE}` };
    flags[hit[1]!] = hit[1] === "json" ? "true" : hit[2] ?? argv[++i] ?? "";
  }
  const days = flags.days ? Number(flags.days) : undefined;
  if (days !== undefined && !(Number.isInteger(days) && days > 0 && days <= 365)) return { exitCode: 1, stderr: `--days is 1..365\n${FORECAST_USAGE}` };
  const report = forecastReport(db, { projectId: flags.project, days, now });
  if (flags.json) return { exitCode: 0, stdout: JSON.stringify(report, null, 2) };
  const { overall, byArea } = report.calibration;
  if (!overall) return { exitCode: 0, stdout: `No forecast scored in ${report.days} days (${report.waiting} waiting for acceptance).` };
  const line = (row: typeof overall) => `${row.area}: ${row.tasks} tasks, files off by ${row.filesMae} (bias ${row.filesBias}), first try right ${Math.round(row.firstTryHit * 100)}%, tokens ×${row.tokensRatio ?? "—"}, minutes ×${row.minutesRatio ?? "—"}`;
  return { exitCode: 0, stdout: [line(overall), ...byArea.map((row) => `  ${line(row)}`), `${report.waiting} waiting for acceptance.`].join("\n") };
}
