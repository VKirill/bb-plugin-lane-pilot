import { CHECKERS, CODE_CHECKERS, DEFECT_CLASSES, EXPECTED_CATCHERS, applies, type CheckerId, type DefectClass, type Outcome } from "./types";

/** One checker's verdict on one planted candidate (or on a clean one: class `control`). */
export type ResultRow = {
  defectId: string; taskId: string; defectClass: DefectClass | "control"; checker: CheckerId; outcome: Outcome; flagged: boolean;
  expected: boolean; detail: string; tokens: number | null; costUsd: number | null;
};

export type Cell = { n: number; hit: number; miss: number; offTarget: number; error: number; skipped: number };
export type CheckerTotals = {
  n: number; hit: number; hitRate: number | null; controls: number; falseAlarms: number; falseAlarmRate: number | null;
  tokens: number; costUsd: number | null; tokensPerHit: number | null;
};

/** The bar to enable the code critic by default (SMA atlas D1-4): it must catch this share of what the code checks miss. */
export const CRITIC_BAR = 0.6;
/** Fewer escaped defects judged than this and the answer is «not enough data», not a yes or a no. */
export const CRITIC_MIN_SAMPLE = 8;
/** A critic that raises a finding on more than this share of clean candidates costs the writer more than it saves. */
export const CRITIC_MAX_FALSE_ALARM = 0.3;

export type CriticDecision = {
  recommendation: "medium" | "off" | "inconclusive";
  bar: number;
  /** Defects no code checker caught, on which the code critic gave a verdict. */
  escapesJudged: number;
  escapesCaught: number;
  escapeCatchRate: number | null;
  controls: number;
  falseAlarmRate: number | null;
  tokensPerCatch: number | null;
  reasons: string[];
};

export type Scorecard = {
  planted: Partial<Record<DefectClass, number>>;
  classes: Partial<Record<DefectClass, Partial<Record<CheckerId, Cell>>>>;
  checkers: Record<CheckerId, CheckerTotals>;
  /** Planted defects that no code checker caught. */
  escapes: { total: number; byClass: Partial<Record<DefectClass, number>> };
  /** A guaranteed code checker (see GUARANTEED_CATCHERS) that is the designed catcher of a class and did not catch a planted defect of it. */
  regressions: Array<{ defectId: string; defectClass: DefectClass; checker: CheckerId }>;
  /** Classes no code checker is designed to catch: the gap the critic is for. */
  gaps: DefectClass[];
  critic: CriticDecision;
};

const emptyCell = (): Cell => ({ n: 0, hit: 0, miss: 0, offTarget: 0, error: 0, skipped: 0 });
const ratio = (part: number, whole: number): number | null => (whole ? Math.round((1000 * part) / whole) / 1000 : null);
const judged = (row: ResultRow) => row.outcome === "hit" || row.outcome === "miss" || row.outcome === "off_target";

/**
 * The code checkers whose catch does not depend on the candidate. A planted off-by-one is caught by `verification` only when the task's tests
 * cover the line, so on real candidates a miss there is a finding (an escape), not a regression; on the drill's fixture, whose tests cover
 * every line, it is (`guaranteed` then names all four).
 */
export const GUARANTEED_CATCHERS: readonly CheckerId[] = ["ownership", "contract_lint", "plan_fact"];

/** Builds the scorecard from the rows of a run. Pure: the same rows always give the same card. */
export function buildScorecard(rows: readonly ResultRow[], options: { guaranteed?: readonly CheckerId[] } = {}): Scorecard {
  const guaranteed = options.guaranteed ?? GUARANTEED_CATCHERS;
  const planted: Scorecard["planted"] = {}, classes: Scorecard["classes"] = {};
  const totals = Object.fromEntries(CHECKERS.map((checker) => [checker, { n: 0, hit: 0, controls: 0, falseAlarms: 0, tokens: 0, costUsd: 0, costKnown: true }])) as Record<CheckerId, { n: number; hit: number; controls: number; falseAlarms: number; tokens: number; costUsd: number; costKnown: boolean }>;
  const byDefect = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const total = totals[row.checker];
    total.tokens += row.tokens ?? 0;
    if (row.costUsd === null && (row.tokens ?? 0) > 0) total.costKnown = false; else total.costUsd += row.costUsd ?? 0;
    if (row.defectClass === "control") {
      if (judged(row)) { total.controls++; if (row.flagged) total.falseAlarms++; }
      continue;
    }
    const list = byDefect.get(row.defectId) ?? [];
    list.push(row); byDefect.set(row.defectId, list);
    const cell = ((classes[row.defectClass] ??= {})[row.checker] ??= emptyCell());
    if (row.outcome === "n/a") continue;
    if (row.outcome === "error") { cell.error++; continue; }
    if (row.outcome === "skipped_budget") { cell.skipped++; continue; }
    cell.n++; total.n++;
    if (row.outcome === "hit") { cell.hit++; total.hit++; } else if (row.outcome === "miss") cell.miss++; else cell.offTarget++;
  }
  const regressions: Scorecard["regressions"] = [], escapedBy: Partial<Record<DefectClass, number>> = {};
  let escapedTotal = 0, escapesJudged = 0, escapesCaught = 0, criticTokens = 0;
  for (const [id, list] of byDefect) {
    const defectClass = list[0]!.defectClass as DefectClass;
    planted[defectClass] = (planted[defectClass] ?? 0) + 1;
    const code = list.filter((row) => (CODE_CHECKERS as readonly string[]).includes(row.checker) && judged(row));
    for (const row of code) if (guaranteed.includes(row.checker) && EXPECTED_CATCHERS[defectClass].includes(row.checker) && row.outcome !== "hit") regressions.push({ defectId: id, defectClass, checker: row.checker });
    if (code.some((row) => row.outcome === "hit")) continue;
    escapedTotal++; escapedBy[defectClass] = (escapedBy[defectClass] ?? 0) + 1;
    const critic = list.find((row) => row.checker === "code_critic" && judged(row));
    if (critic) { escapesJudged++; criticTokens += critic.tokens ?? 0; if (critic.outcome === "hit") escapesCaught++; }
  }
  const checkers = Object.fromEntries(CHECKERS.map((checker): [CheckerId, CheckerTotals] => {
    const t = totals[checker];
    return [checker, { n: t.n, hit: t.hit, hitRate: ratio(t.hit, t.n), controls: t.controls, falseAlarms: t.falseAlarms, falseAlarmRate: ratio(t.falseAlarms, t.controls),
      tokens: t.tokens, costUsd: t.costKnown ? Math.round(t.costUsd * 10_000) / 10_000 : null, tokensPerHit: t.hit ? Math.round(t.tokens / t.hit) : null }];
  })) as Record<CheckerId, CheckerTotals>;
  const gaps = DEFECT_CLASSES.filter((defectClass) => !EXPECTED_CATCHERS[defectClass].some((checker) => (CODE_CHECKERS as readonly string[]).includes(checker)));
  return { planted, classes, checkers, escapes: { total: escapedTotal, byClass: escapedBy }, regressions, gaps, critic: decideCodeCritic({ escapesJudged, escapesCaught, controls: checkers.code_critic.controls, falseAlarms: checkers.code_critic.falseAlarms, tokens: criticTokens }) };
}

/**
 * Is the code critic worth enabling by default for risk medium and up (`critic.code.default_for_risk=medium`)? By the numbers: its catch rate on
 * defects the code checks missed (the only defects it would be the last line against), its false-alarm rate on clean candidates, and its cost per catch.
 */
export function decideCodeCritic(input: { escapesJudged: number; escapesCaught: number; controls: number; falseAlarms: number; tokens: number }): CriticDecision {
  const rate = ratio(input.escapesCaught, input.escapesJudged), falseRate = ratio(input.falseAlarms, input.controls);
  const reasons: string[] = [];
  const perCatch = input.escapesCaught ? Math.round(input.tokens / input.escapesCaught) : null;
  let recommendation: CriticDecision["recommendation"];
  if (input.escapesJudged < CRITIC_MIN_SAMPLE) {
    recommendation = "inconclusive";
    reasons.push(`only ${input.escapesJudged} escaped defects were judged, ${CRITIC_MIN_SAMPLE} are the least that settle it`);
  } else if ((rate ?? 0) < CRITIC_BAR) {
    recommendation = "off";
    reasons.push(`it caught ${input.escapesCaught} of ${input.escapesJudged} escaped defects (${Math.round(100 * (rate ?? 0))}%), the bar is ${Math.round(100 * CRITIC_BAR)}%`);
  } else if (falseRate !== null && falseRate > CRITIC_MAX_FALSE_ALARM) {
    recommendation = "off";
    reasons.push(`it caught ${Math.round(100 * (rate ?? 0))}% of the escapes but raised a finding on ${Math.round(100 * falseRate)}% of clean candidates (the limit is ${Math.round(100 * CRITIC_MAX_FALSE_ALARM)}%)`);
  } else {
    recommendation = "medium";
    reasons.push(`it caught ${input.escapesCaught} of ${input.escapesJudged} escaped defects (${Math.round(100 * (rate ?? 0))}%, bar ${Math.round(100 * CRITIC_BAR)}%)${falseRate === null ? "; false alarms on clean candidates were not measured" : ` with ${Math.round(100 * falseRate)}% false alarms`}`);
  }
  if (input.controls < 3 && input.escapesJudged >= CRITIC_MIN_SAMPLE) reasons.push(`false alarms rest on ${input.controls} clean candidates`);
  return { recommendation, bar: CRITIC_BAR, escapesJudged: input.escapesJudged, escapesCaught: input.escapesCaught, escapeCatchRate: rate, controls: input.controls, falseAlarmRate: falseRate, tokensPerCatch: perCatch, reasons };
}

const pad = (text: string, width: number) => text.padEnd(width);

/** The scorecard as a table: one row per defect class, one column per checker, «hit/judged» in each cell. */
export function renderScorecard(card: Scorecard): string {
  const shown = CHECKERS.filter((checker) => DEFECT_CLASSES.some((defectClass) => card.classes[defectClass]?.[checker]));
  const lines = [`${pad("defect class", 24)}${pad("planted", 9)}${shown.map((checker) => pad(checker, 14)).join("")}designed catcher`];
  for (const defectClass of DEFECT_CLASSES) {
    const count = card.planted[defectClass] ?? 0;
    if (!count) { lines.push(`${pad(defectClass, 24)}${pad("0", 9)}(not plantable in these candidates)`); continue; }
    const cells = shown.map((checker) => {
      if (!applies(checker, defectClass)) return pad("-", 14);
      const cell = card.classes[defectClass]?.[checker];
      if (!cell) return pad("-", 14);
      const text = cell.n ? `${cell.hit}/${cell.n}` : cell.error ? `err ${cell.error}` : cell.skipped ? "no budget" : "-";
      return pad(text + (cell.offTarget ? ` (+${cell.offTarget} off)` : ""), 14);
    });
    lines.push(`${pad(defectClass, 24)}${pad(String(count), 9)}${cells.join("")}${EXPECTED_CATCHERS[defectClass].join(", ")}`);
  }
  lines.push("");
  for (const checker of CHECKERS) {
    const t = card.checkers[checker];
    if (!t.n && !t.controls) continue;
    lines.push(`${pad(checker, 14)} caught ${t.hit}/${t.n}${t.hitRate === null ? "" : ` (${Math.round(100 * t.hitRate)}%)`}; false alarms ${t.falseAlarms}/${t.controls}${t.tokens ? `; ${t.tokens} tokens${t.costUsd === null ? "" : `, $${t.costUsd}`}` : ""}`);
  }
  lines.push("", `escaped every code checker: ${card.escapes.total} (${Object.entries(card.escapes.byClass).map(([name, n]) => `${name} ${n}`).join(", ") || "none"})`);
  if (card.regressions.length) lines.push(`RED: ${card.regressions.map((row) => `${row.checker} missed ${row.defectId}`).join("; ")}`);
  if (card.gaps.length) lines.push(`no code checker is designed to catch: ${card.gaps.join(", ")}`);
  const c = card.critic;
  lines.push(`code critic for risk >= medium: ${c.recommendation.toUpperCase()} - ${c.reasons.join("; ")}`);
  return lines.join("\n");
}
