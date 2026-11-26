import type { ServerCore } from "../../../contracts/server";
import { listRecentOutages } from "../services/outage-service";

export const OUTAGE_USAGE = "bb lane-pilot outages [--days 7]   (the gaps of more than 5 minutes when Lane Pilot was not running)";

export function runOutageCli(ctx: Pick<ServerCore, "db">, argv: readonly string[], now = Date.now()): { exitCode: number; stdout?: string; stderr?: string } {
  const days = argv[0] === "--days" && argv[1] ? Number(argv[1]) : argv.length ? NaN : 7;
  if (!Number.isInteger(days) || days < 1 || days > 365) return { exitCode: 1, stderr: OUTAGE_USAGE };
  return { exitCode: 0, stdout: JSON.stringify(listRecentOutages(ctx.db, days, now), null, 2) };
}
