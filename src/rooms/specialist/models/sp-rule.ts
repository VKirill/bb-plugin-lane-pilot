import type { OutcomeVerdict, RuleScope, RuleState } from "@lane-pilot/contracts";
import type { IntentOutcomeRow } from "../server/repositories/sp-outcomes";

const DAY_MS = 86_400_000;

export interface SpRuleLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface SpRuleRow {
  id: string;
  domain: string;
  project_id: string | null;
  scope: RuleScope;
  text: string;
  evidence_json: string;
  window_json: string;
  uncertainty: string;
  state: RuleState;
  created_at: number;
  decided_at: number | null;
}

export interface RuleWindow {
  comparison: "pre/post" | "holdout";
  measurement_days: number;
  source_rules?: Array<{ id: string; project_id: string | null }>;
}

export interface RuleEvidenceEntry {
  intent_id: string;
  hypothesis_id: string | null;
  project_id?: string;
  rule_id?: string;
  metric: string;
  unit: string;
  verdict: OutcomeVerdict;
  baseline: number | null;
  expected_lo: number;
  expected_point: number;
  expected_hi: number;
  measured: number | null;
  measured_at: number | null;
  source: string | null;
  contradicts?: boolean;
}

export interface RuleSnapshotEntry {
  id: string;
  scope: RuleScope;
  domain: string;
  project_id: string | null;
  text: string;
  uncertainty: string;
  window: RuleWindow;
  evidence: RuleEvidenceEntry[];
  created_at: number;
}

export type RuleActionResult =
  | { ok: true; rule: SpRuleRow; id: string; scope: RuleScope; state: RuleState }
  | { ok: false; reason: string; contradictions?: number };

export interface OutcomeWithOrderRow extends IntentOutcomeRow {
  intent_order_json: string | null;
  intent_created_at: number | null;
}

export function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (typeof val !== "string" || !val.trim()) return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

/** Normalizes rule text so cross-business rules with minor casing/whitespace/punctuation differences match. */
export function normalizeRuleText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

export function isMeasuredOutcome(
  row: Pick<IntentOutcomeRow, "verdict" | "measured">,
): row is Pick<IntentOutcomeRow, "verdict" | "measured"> & { measured: number } {
  return row.verdict !== "pending" && row.verdict !== "inconclusive" && row.measured !== null && Number.isFinite(row.measured);
}

export function parseEvidenceEntries(evidenceJson: string): RuleEvidenceEntry[] {
  const raw = parseJsonSafe<unknown>(evidenceJson, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is RuleEvidenceEntry => Boolean(e && typeof e === "object" && typeof (e as RuleEvidenceEntry).intent_id === "string"));
}

export function toEvidenceEntry(row: IntentOutcomeRow, extra?: Partial<RuleEvidenceEntry>): RuleEvidenceEntry {
  return {
    intent_id: row.intent_id,
    hypothesis_id: row.hypothesis_id,
    metric: row.metric,
    unit: row.unit,
    verdict: row.verdict,
    baseline: row.baseline,
    expected_lo: row.expected_lo,
    expected_point: row.expected_point,
    expected_hi: row.expected_hi,
    measured: row.measured,
    measured_at: row.measured_at,
    source: row.source,
    ...extra,
  };
}

export function resolveWindowFromOutcomes(
  rows: readonly OutcomeWithOrderRow[],
  hypCreatedAt: number,
  explicitComparison?: "pre/post" | "holdout",
): RuleWindow {
  let comparison: "pre/post" | "holdout" = explicitComparison ?? "pre/post";
  let measurementDays = 0;

  for (const row of rows) {
    const orderObj = parseJsonSafe<Record<string, unknown>>(row.intent_order_json ?? "", {});
    const forecastObj = orderObj.forecast && typeof orderObj.forecast === "object" ? (orderObj.forecast as Record<string, unknown>) : null;
    const specObj = orderObj.spec && typeof orderObj.spec === "object" ? (orderObj.spec as Record<string, unknown>) : null;

    if (!explicitComparison) {
      const cmp = orderObj.comparison ?? forecastObj?.comparison ?? specObj?.comparison;
      if (cmp === "holdout") comparison = "holdout";
    }

    const horizon = forecastObj?.horizon_days;
    if (typeof horizon === "number" && Number.isFinite(horizon) && horizon > 0) {
      measurementDays = Math.max(measurementDays, Math.round(horizon));
    } else {
      const startMs = row.intent_created_at ?? hypCreatedAt;
      const endMs = row.measured_at ?? row.check_at;
      const days = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
      measurementDays = Math.max(measurementDays, days);
    }
  }

  return {
    comparison,
    measurement_days: measurementDays > 0 ? measurementDays : 14,
  };
}

export function formatUncertainty(
  outcomes: ReadonlyArray<Pick<IntentOutcomeRow, "metric" | "unit" | "expected_lo" | "expected_point" | "expected_hi" | "measured">>,
): string {
  return outcomes
    .map(
      (o) =>
        `${o.metric}: expected [${o.expected_lo}, ${o.expected_point}, ${o.expected_hi}] ${o.unit}, measured ${o.measured} ${o.unit}`,
    )
    .join("; ");
}
