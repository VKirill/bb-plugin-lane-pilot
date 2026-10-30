import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Judgment } from "./registry";
import { jevModelBase } from "./provider";

/**
 * Calibration of the Jev judgments (audit top-1): a report over `lane_pilot_jev_receipt` — per judgment, its labeled
 * outcomes (the `outcome` column: agree/disagree of the stronger judge) against the confidence the answers carried, and a
 * verdict what the judgment is fit for: `gate` (it may decide), `sort-only` (it may rank, never gate) or `dead` (it does
 * not work or was never asked).
 *
 * A calibration also carries `fingerprint`: a hash of the judgment's id, version and the source of its questions and
 * decide. A saved `jev.calibrated_thresholds` entry is applied only while the fingerprint matches — a judgment that was
 * reworded without a recalibration falls back to the registry defaults, and the repo test on the fixture turns red.
 */
export type CalibrationVerdict = "gate" | "sort-only" | "dead";

export type JudgmentCalibration = {
  judgment: string; version: number; fingerprint: string;
  /** The model id the receipts of this report were answered by (the dominant one); the certified thresholds bind to it, not to an alias. */
  model: string | null;
  calls: number; labeled: number; agree: number; disagree: number;
  /** agree / (agree + disagree); null when nothing is labeled. */
  accuracy: number | null;
  /** Mean of the confidences recorded in answers_json (Choice/Score answers). */
  meanConfidence: number | null;
  /** Labeled outcomes below `minLabeled`: the verdict is provisional. */
  insufficient: boolean;
  verdict: CalibrationVerdict;
  /** The thresholds the calibration certifies (the registry defaults, clamped); a project may override them via jev.thresholds. */
  thresholds: Record<string, number>;
};

export const JEV_CALIBRATED_KEY = "jev.calibrated_thresholds";
/** The day the calibration epoch starts until stats.epoch lands in a neighbor branch. */
export const CALIBRATION_EPOCH_FALLBACK = "2026-10-29";
export const DEFAULT_MIN_LABELED = 10;

/** What a saved calibration names one judgment: the threshold set certified for exactly this wording. */
export function judgmentFingerprint(judgment: Pick<Judgment<unknown, unknown>, "id" | "version" | "questions" | "decide">): string {
  const text = `${judgment.id}@${judgment.version}\n${judgment.questions.toString()}\n${judgment.decide.toString()}`;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The certified thresholds a settings value holds for one judgment, or null when none match this wording — or when the model
 * that will answer is not the version the calibration ran on: a model change silently resets the certified thresholds to the
 * registry defaults until a new calibration (`model` is the actual id the API answered or will be asked with, not an alias).
 */
export function calibratedThresholds(judgment: Pick<Judgment<unknown, unknown>, "id" | "version" | "questions" | "decide" | "thresholds">, settings: Record<string, unknown> | undefined, model: string | null | undefined): Record<string, number> | null {
  const raw = settings?.[JEV_CALIBRATED_KEY];
  let map: Record<string, { fingerprint?: unknown; thresholds?: unknown }> = {};
  if (typeof raw === "string" && raw.trim()) { try { map = JSON.parse(raw) as typeof map; } catch { return null; } }
  else if (raw && typeof raw === "object") map = raw as typeof map;
  else return null;
  const entry = map[judgment.id] as { fingerprint?: unknown; thresholds?: unknown; model?: unknown } | undefined;
  if (!entry || entry.fingerprint !== judgmentFingerprint(judgment)) return null;
  if (typeof entry.model !== "string" || !entry.model || typeof model !== "string" || !model || jevModelBase(entry.model) !== jevModelBase(model)) return null;
  const out: Record<string, number> = {};
  for (const [name, spec] of Object.entries(judgment.thresholds)) {
    const value = Number((entry.thresholds as Record<string, unknown> | undefined)?.[name]);
    out[name] = Number.isFinite(value) ? Math.min(spec.max, Math.max(spec.min, value)) : spec.default;
  }
  return out;
}

type Row = { judgment: string; version: number; model: string | null; status: string; outcome: string | null; answers_json: string | null };

/**
 * The calibration report over the receipts since `sinceMs`, one row per known judgment that was asked at least once
 * (plus an entry per unknown judgment name found in the receipts, so retired ids still show).
 */
export function calibrateReceipts(db: Database.Database, input: { sinceMs: number; judgments: ReadonlyArray<Pick<Judgment<unknown, unknown>, "id" | "version" | "questions" | "decide" | "thresholds">>; minLabeled?: number }): JudgmentCalibration[] {
  const minLabeled = input.minLabeled ?? DEFAULT_MIN_LABELED;
  const rows = db.prepare(`SELECT judgment, version, model, status, outcome, answers_json FROM lane_pilot_jev_receipt WHERE at >= ?`).all(input.sinceMs) as Row[];
  const byJudgment = new Map<string, Row[]>();
  for (const row of rows) byJudgment.set(row.judgment, [...(byJudgment.get(row.judgment) ?? []), row]);
  const out: JudgmentCalibration[] = [];
  const known = new Map(input.judgments.map((judgment) => [judgment.id, judgment]));
  for (const [id, list] of [...byJudgment.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const judgment = known.get(id);
    const calls = list.filter((row) => row.status === "ok").length;
    const agree = list.filter((row) => (row.outcome ?? "").startsWith("agree")).length;
    const disagree = list.filter((row) => (row.outcome ?? "").startsWith("disagree")).length;
    const labeled = agree + disagree;
    let confidences = 0, confN = 0;
    for (const row of list) {
      if (!row.answers_json) continue;
      try {
        for (const summary of Object.values(JSON.parse(row.answers_json) as Record<string, { confidence?: number }>)) {
          if (typeof summary.confidence === "number") { confidences += summary.confidence; confN += 1; }
        }
      } catch { /* a broken row is not a label */ }
    }
    // The version that actually answered, not the alias that was asked: most frequent model id over the successful calls.
    const models = new Map<string, number>();
    for (const row of list) if (row.status === "ok" && row.model) models.set(jevModelBase(row.model), (models.get(jevModelBase(row.model)) ?? 0) + 1);
    const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const accuracy = labeled ? agree / labeled : null;
    const insufficient = labeled < minLabeled;
    const verdict: CalibrationVerdict =
      calls === 0 ? "dead"
      : labeled > 0 && accuracy !== null && accuracy < 0.5 ? "dead"
      : !insufficient && accuracy !== null && accuracy >= 0.75 ? "gate"
      : "sort-only";
    out.push({
      judgment: id, version: judgment?.version ?? Math.max(...list.map((row) => row.version)), fingerprint: judgment ? judgmentFingerprint(judgment) : "", model,
      calls, labeled, agree, disagree, accuracy, meanConfidence: confN ? Math.round((confidences / confN) * 1000) / 1000 : null,
      insufficient, verdict,
      thresholds: judgment ? Object.fromEntries(Object.entries(judgment.thresholds).map(([name, spec]) => [name, spec.default])) : {},
    });
  }
  return out;
}

/** The calibration record `--save` writes: per judgment its fingerprint and certified thresholds. */
export function calibrationRecord(report: readonly JudgmentCalibration[]): Record<string, { fingerprint: string; model: string | null; thresholds: Record<string, number> }> {
  return Object.fromEntries(report.filter((row) => row.fingerprint).map((row) => [row.judgment, { fingerprint: row.fingerprint, model: row.model, thresholds: row.thresholds }]));
}

const clip = (value: string, width: number) => value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
const pct = (value: number | null) => (value === null ? "  —  " : `${Math.round(value * 100)}%`.padStart(5));

/** The report as a fixed-width table the CLI prints. */
export function renderCalibration(report: readonly JudgmentCalibration[], since: string): string {
  const lines = [`Jev calibration since ${since}:`, `  ${"judgment".padEnd(28)} ${"ver".padStart(3)} ${"calls".padStart(5)} ${"labeled".padStart(7)} ${"acc".padStart(5)} ${"conf".padStart(5)}  verdict`];
  for (const row of report) {
    lines.push(`  ${clip(row.judgment, 28)} ${(row.model ?? "-").padEnd(11)} ${String(row.version).padStart(3)} ${String(row.calls).padStart(5)} ${String(row.labeled).padStart(7)} ${pct(row.accuracy)} ${pct(row.meanConfidence)}  ${row.verdict}${row.insufficient ? " (little data)" : ""}`);
  }
  if (!report.length) lines.push("  no receipts in the window");
  return lines.join("\n");
}
