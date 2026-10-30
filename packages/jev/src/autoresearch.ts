import type Database from "better-sqlite3";

/**
 * Nightly self-tuning of judgments (B10; the autoresearch_feature_discovery cookbook): once a judgment has enough
 * labeled receipts (`outcome` agree/disagree from the stronger judge), sweep a threshold grid over the recorded answer
 * confidences and propose the value that maximizes agreement. Output is a *proposal* — nothing is applied on its own;
 * a saved suggestion lands in `jev.calibrated_thresholds` only through `jev calibrate --save` and only while the
 * judgment's fingerprint matches.
 */
export const AUTORESEARCH_MIN_LABELED = 30;
export const THRESHOLD_GRID = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;

export type ThresholdProposal = {
  judgment: string;
  labeled: number;
  /** Top-answer probability above which the recorded outcome was usually `agree`. */
  suggested_p: number;
  /** Agreement achieved at the suggested cut vs at 0 (always act). */
  accuracy: number;
  baseline: number;
  ready: boolean;
};

type Row = { judgment: string; outcome: string | null; answers_json: string | null };

/** The deciding confidence of a receipt: max of the per-question top probabilities (noul answers carry theirs in value). */
function receiptConfidence(answersJson: string | null): number | null {
  if (!answersJson) return null;
  try {
    const answers = Object.values(JSON.parse(answersJson) as Record<string, { top?: Array<[string, number]>; value?: number; kind?: string }>);
    const ps = answers.flatMap((a) => a.kind === "noul" && typeof a.value === "number" ? [Math.max(a.value, 1 - a.value)] : (a.top?.[0]?.[1] ?? []));
    const nums = ps.filter((v): v is number => typeof v === "number");
    return nums.length ? Math.max(...nums) : null;
  } catch { return null; }
}

export function autoresearchThresholds(db: Database.Database, input: { sinceMs: number; minLabeled?: number }): ThresholdProposal[] {
  const minLabeled = input.minLabeled ?? AUTORESEARCH_MIN_LABELED;
  const rows = db.prepare(`SELECT judgment, outcome, answers_json FROM lane_pilot_jev_receipt WHERE at >= ? AND outcome IS NOT NULL`).all(input.sinceMs) as Row[];
  const byJudgment = new Map<string, Array<{ p: number; agree: boolean }>>();
  for (const row of rows) {
    const agree = (row.outcome ?? "").startsWith("agree"), disagree = (row.outcome ?? "").startsWith("disagree");
    if (!agree && !disagree) continue;
    const p = receiptConfidence(row.answers_json);
    if (p === null) continue;
    byJudgment.set(row.judgment, [...(byJudgment.get(row.judgment) ?? []), { p, agree }]);
  }
  const out: ThresholdProposal[] = [];
  for (const [judgment, list] of [...byJudgment.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const labeled = list.length;
    const baseline = list.filter((r) => r.agree).length / labeled;
    let best = { p: 0, acc: baseline };
    for (const cut of THRESHOLD_GRID) {
      const decided = list.filter((r) => r.p >= cut);
      if (!decided.length) continue;
      const acc = decided.filter((r) => r.agree).length / decided.length;
      if (acc > best.acc) best = { p: cut, acc };
    }
    out.push({ judgment, labeled, suggested_p: best.p, accuracy: Math.round(best.acc * 1000) / 1000, baseline: Math.round(baseline * 1000) / 1000, ready: labeled >= minLabeled });
  }
  return out;
}
