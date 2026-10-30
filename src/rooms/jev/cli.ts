import type Database from "better-sqlite3";
import { autoresearchThresholds, calibrateReceipts, calibrationRecord, jevWatch, judgmentFingerprint, listJudgments, renderCalibration, renderWatch, AUTORESEARCH_MIN_LABELED, CALIBRATION_EPOCH_FALLBACK, JEV_CALIBRATED_KEY } from "@lane-pilot/jev";
import "./judgments";
import { failureClassReport } from "../runs";

/**
 * `bb lane-pilot jev calibrate [project] [--since <iso-date>] [--save] [--json]`: the calibration report over the receipts
 * — per judgment, its accuracy against the labeled outcomes and what it is fit for (gate / sort-only / dead). The labels
 * come from the receipts' `outcome` column and the task outcomes written next to them; the window starts at the project's
 * stats.epoch setting (until that lands, 2026-10-29). With --save the certified thresholds are written to the project's
 * `jev.calibrated_thresholds`, where resolveThresholds picks them up only while the judgment's fingerprint still matches.
 */
export const JEV_USAGE = "bb lane-pilot jev calibrate [project] [--since <date>] [--min-labeled N] [--json] [--save]   (accuracy by judgment over the receipts, with the gate/sort-only/dead verdict; --save writes the certified thresholds to the project's jev.calibrated_thresholds)\n"
  + "bb lane-pilot jev planfact [--json]   (where the shadow Jev read of the acceptance items disagrees with the code's plan-fact check; decided_by=jev only)\n"
  + "bb lane-pilot jev watch [--since <date>|--hours N] [--days N] [--json]   (jaggedness: per judgment+project slices of the window against the same slices' baseline; drift findings, read-only)\n"
  + "bb lane-pilot jev failure [--json]   (failure.class: labeled outcomes, the shadow\u2192live gate, and why it is or is not live)";

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
  if (sub === "autoresearch") {
    const flags = new Map<string, string | true>(), pos: string[] = [];
    for (let i = 1; i < rest.length; i++) {
      const arg = rest[i]!;
      if (!arg.startsWith("--")) { pos.push(arg); continue; }
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      flags.set(name, inline ?? (["since", "min-labeled"].includes(name) ? rest[++i] ?? true : true));
    }
    const sinceArg = flags.get("since");
    const sinceMs = typeof sinceArg === "string" ? Date.parse(`${sinceArg}T00:00:00Z`) : Date.now() - 30 * 86_400_000;
    const report = autoresearchThresholds(deps.db, { sinceMs, minLabeled: Number(flags.get("min-labeled")) || AUTORESEARCH_MIN_LABELED });
    if (flags.has("json")) return { exitCode: 0, stdout: JSON.stringify(report, null, 2) };
    const lines = report.map((r) => `${r.judgment}: ${r.labeled} labeled, ${r.ready ? `suggested p>=${r.suggested_p} (acc ${r.accuracy} vs ${r.baseline})` : "not enough data"}`);
    return { exitCode: 0, stdout: lines.join("\n") || "no labeled receipts yet" };
  }
  if (sub === "planfact") {
    // Jev's blind read is measured only where it decided itself; shadow/fallback receipts say nothing about accuracy.
    const rows = deps.db.prepare(`SELECT r.id, r.run_id, r.subject, r.decision, s.state, s.result_json FROM lane_pilot_jev_receipt r
      JOIN lane_pilot_stage_receipt s ON s.run_id = r.run_id AND s.task_id = r.subject AND s.stage_id = 'plan-fact'
      WHERE r.judgment = 'plan.fact' AND r.status = 'ok' AND r.decided_by = 'jev'`).all() as Array<{ id: number; run_id: string; subject: string; decision: string | null; state: string; result_json: string | null }>;
    const items: Array<{ runId: string; taskId: string; jev: Record<string, string>; code: Record<string, string>; state: string }> = [];
    for (const row of rows) {
      let result: { items?: Array<{ item: number; verdict: string }>; jev?: Record<string, string> } | null = null;
      try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { /* unreadable */ }
      if (!result?.jev) continue;
      const code = Object.fromEntries((result.items ?? []).map((item) => [String(item.item), item.verdict === "proven" ? "done" : "not_done"]));
      const diffs: Record<string, string> = {}, codeDiffs: Record<string, string> = {};
      for (const [item, verdict] of Object.entries(result.jev)) {
        if (verdict !== "unseen" && code[item] && code[item] !== verdict) { diffs[item] = verdict; codeDiffs[item] = code[item]!; }
      }
      if (Object.keys(diffs).length) items.push({ runId: row.run_id, taskId: row.subject, jev: diffs, code: codeDiffs, state: row.state });
    }
    return { exitCode: 0, stdout: JSON.stringify(items, null, args.includes("--json") ? 2 : 2) };
  }
  if (sub === "failure") {
    // failure.class: the shadow->live gate and what it still needs (wave-8 batch 2). Read-only.
    const report = failureClassReport(deps.db);
    if (rest.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(report, null, 2) };
    const acc = report.accuracy === null ? "n/a" : `${Math.round(report.accuracy * 100)}%`;
    return { exitCode: 0, stdout: `failure.class: ${report.calls} calls, ${report.labeled} labeled (${report.agree} agree / ${report.disagree} disagree), accuracy ${acc}\n${report.live ? "LIVE" : "shadow"}: ${report.reason}` };
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
