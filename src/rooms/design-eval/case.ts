import { createHash } from "node:crypto";
import type { Measurement } from "./logic";

/**
 * A design evaluation case (SMA k_lib_dcase): the writer pins the id and the suite version into the file, the reader
 * takes it back only when its bytes still hash the same and the rubric balance holds — both widths measured, every
 * field a criterion scores present.
 */
export const DESIGN_SUITE_VERSION = "design-eval-1";

export type DesignCase = { id: string; suiteVersion: string; sha256: string; measurements: Measurement[] };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Key order fixed so the same measurements always hash the same. */
const canonicalMeasurements = (measurements: readonly Measurement[]): string =>
  JSON.stringify(measurements.map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))));

/** The fields scoreMeasurement reads: a case missing one is not scoreable by the whole rubric. */
const SCOREABLE: readonly (keyof Measurement)[] = ["width", "overflowPx", "textElements", "lowContrast", "targets", "smallTargets", "tinyText", "h1", "spacingValues"];

/** A case file's text: id, suite version and the sha256 of the canonical measurement JSON, pinned. */
export function writeDesignCase(input: { id: string; measurements: Measurement[] }): string {
  return JSON.stringify({
    id: input.id,
    suiteVersion: DESIGN_SUITE_VERSION,
    sha256: sha(canonicalMeasurements(input.measurements)),
    measurements: input.measurements,
  }, null, 2) + "\n";
}

export type ReadDesignCase = { ok: true; case: DesignCase } | { ok: false; reason: string };

/** Reads a case back only if its bytes and rubric balance check out; the refusal names why. */
export function readDesignCase(text: string): ReadDesignCase {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: "design_case_not_json" }; }
  const row = parsed as Partial<DesignCase> | null;
  if (!row || typeof row.id !== "string" || !row.id) return { ok: false, reason: "design_case_id_missing" };
  if (row.suiteVersion !== DESIGN_SUITE_VERSION) return { ok: false, reason: `design_case_suite_mismatch:${String(row.suiteVersion)}` };
  const measurements = Array.isArray(row.measurements) ? (row.measurements as Measurement[]) : null;
  if (!measurements?.length || sha(canonicalMeasurements(measurements)) !== row.sha256) return { ok: false, reason: "design_case_bytes_differ" };
  for (const width of [375, 1280]) {
    if (!measurements.some((m) => m.width === width)) return { ok: false, reason: `design_case_width_missing:${width}` };
  }
  const fields = new Set(measurements.flatMap((m) => Object.keys(m)));
  if (!SCOREABLE.every((key) => fields.has(key))) return { ok: false, reason: "design_case_measurement_incomplete" };
  return { ok: true, case: { id: row.id, suiteVersion: DESIGN_SUITE_VERSION, sha256: row.sha256 as string, measurements } };
}
