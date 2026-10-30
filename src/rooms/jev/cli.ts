import type Database from "better-sqlite3";
import { calibrateReceipts, calibrationRecord, jevWatch, judgmentFingerprint, listJudgments, renderCalibration, renderWatch, CALIBRATION_EPOCH_FALLBACK, JEV_CALIBRATED_KEY } from "@lane-pilot/jev";
import "./judgments";

/**
 * `bb lane-pilot jev calibrate [project] [--since <iso-date>] [--save] [--json]`: the calibration report over the receipts
 * — per judgment, its accuracy against the labeled outcomes and what it is fit for (gate / sort-only / dead). The labels
 * come from the receipts' `outcome` column and the task outcomes written next to them; the window starts at the project's
 * stats.epoch setting (until that lands, 2026-10-29). With --save the certified thresholds are written to the project's
 * `jev.calibrated_thresholds`, where resolveThresholds picks them up only while the judgment's fingerprint still matches.
 */
export const JEV_USAGE = "bb lane-pilot jev calibrate [project] [--since <date>] [--min-labeled N] [--json] [--save]   (accuracy by judgment over the receipts, with the gate/sort-only/dead verdict; --save writes the certified thresholds to the project's jev.calibrated_thresholds)\n"
  + "bb lane-pilot jev watch [--since <date>|--hours N] [--days N] [--json]   (jaggedness: per judgment+project slices of the window against the same slices' baseline; drift findings, read-only)";

const DAY = 86_400_000;

export function runJevCli(deps: { db: Database.Database; saveProjectSetting?: (projectId: string, key: string, value: unknown) => void; settings?: (projectId: string) => Promise<Record<string, unknown>> }, args: string[]): { exitCode: number; stdout?: string; stderr?: string } | Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const [sub, ...rest] = args;
  if (sub === "watch") {
    const flags = new Map<string, string | true>();
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (!arg.startsWith("--")) continue;
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      flags.set(name, inline ?? (["since", "hours", "days"].includes(name) ? rest[++i] ?? true : true));
    }
    const sinceArg = flags.get("since"), hours = Number(flags.get("hours")) || 24;
    const sinceMs = typeof sinceArg === "string" && sinceArg !== "true" ? Date.parse(`${sinceArg}T00:00:00Z`) : Date.now() - hours * 3_600_000;
    if (!Number.isFinite(sinceMs)) return { exitCode: 1, stderr: `--since wants a date (2026-10-29), got "${sinceArg}"` };
    const report = jevWatch(deps.db, { sinceMs, baselineDays: Number(flags.get("days")) || 30 });
    if (flags.has("json")) return { exitCode: 0, stdout: JSON.stringify(report, null, 2) };
    return { exitCode: 0, stdout: renderWatch(report) };
  }
  if (sub !== "calibrate") return { exitCode: 1, stderr: `usage: ${JEV_USAGE}` };
  const flags = new Map<string, string | true>(), positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    flags.set(name, inline ?? (["since", "min-labeled"].includes(name) ? rest[++i] ?? true : true));
  }
  const projectId = positional[0];
  const minLabeled = Number(flags.get("min-labeled")) || 10;
  const sinceArg = flags.get("since");
  const finish = (sinceMs: number, sinceLabel: string) => {
    const report = calibrateReceipts(deps.db, { sinceMs, judgments: listJudgments(), minLabeled });
    if (flags.has("json")) return { exitCode: 0, stdout: JSON.stringify({ since: sinceLabel, minLabeled, judgments: report }, null, 2) };
    if (flags.has("save")) {
      if (!projectId || !deps.saveProjectSetting) return { exitCode: 1, stderr: "--save needs a project id" };
      deps.saveProjectSetting(projectId, JEV_CALIBRATED_KEY, JSON.stringify(calibrationRecord(report)));
      return { exitCode: 0, stdout: `${renderCalibration(report, sinceLabel)}\nsaved ${report.length} judgments to ${projectId} ${JEV_CALIBRATED_KEY}` };
    }
    return { exitCode: 0, stdout: renderCalibration(report, sinceLabel) };
  };
  if (typeof sinceArg === "string" && sinceArg !== "true") {
    const at = Date.parse(`${sinceArg}T00:00:00Z`);
    if (!Number.isFinite(at)) return { exitCode: 1, stderr: `--since wants a date (2026-10-29), got "${sinceArg}"` };
    return finish(at, sinceArg);
  }
  if (projectId && deps.settings) {
    return deps.settings(projectId).then((settings) => {
      const epoch = Date.parse(`${settings["stats.epoch"] ?? CALIBRATION_EPOCH_FALLBACK}T00:00:00Z`);
      const since = Number.isFinite(epoch) ? epoch : Date.parse(`${CALIBRATION_EPOCH_FALLBACK}T00:00:00Z`);
      return finish(since, new Date(since).toISOString().slice(0, 10));
    }, () => finish(Date.now() - 30 * DAY, "last 30 days"));
  }
  const epoch = Date.parse(`${CALIBRATION_EPOCH_FALLBACK}T00:00:00Z`);
  return finish(epoch, CALIBRATION_EPOCH_FALLBACK);
}

/** For tests and the settings UI: whether a saved calibrated_thresholds entry still certifies this wording. */
export { judgmentFingerprint };
