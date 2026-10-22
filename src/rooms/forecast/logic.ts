import type { TaskV2 } from "@lane-pilot/contracts";

/**
 * Plan prediction and calibration (SMA atlas D2-1: «Plan prediction engine», «Estimate-versus-fact report», rule 6 «a date only from the
 * register and the calibration»). Before dispatch the PM writes a forecast in the contract (`forecast`: files, whether every check passes on
 * the first attempt, optionally tokens and minutes); after acceptance the code compares it with the fact. Pure functions: the server reads
 * the facts, these score them and sum them up per area.
 */
export type Forecast = NonNullable<TaskV2["forecast"]>;
/** What happened: files the accepted attempt changed, whether it was the first attempt, its tokens and minutes (null: not measured). */
export type ForecastFact = { files: number; firstTry: boolean; tokens: number | null; minutes: number | null };

export type ForecastScore = {
  files: { forecast: number; fact: number; error: number };
  firstTry: { forecast: boolean; fact: boolean; hit: boolean };
  /** fact / forecast; null when either side is missing or not measured. */
  tokensRatio: number | null;
  minutesRatio: number | null;
};

const ratio = (fact: number | null, forecast: number | undefined): number | null =>
  fact === null || forecast === undefined || forecast <= 0 ? null : Math.round((fact / forecast) * 100) / 100;

export function scoreForecast(forecast: Forecast, fact: ForecastFact): ForecastScore {
  return {
    files: { forecast: forecast.files, fact: fact.files, error: fact.files - forecast.files },
    firstTry: { forecast: forecast.checks_pass_first_try, fact: fact.firstTry, hit: forecast.checks_pass_first_try === fact.firstTry },
    tokensRatio: ratio(fact.tokens, forecast.tokens),
    minutesRatio: ratio(fact.minutes, forecast.minutes),
  };
}

export type Calibration = {
  area: string; tasks: number;
  /** Mean absolute error in files, and the mean signed error (positive: the PM forecasts too few). */
  filesMae: number; filesBias: number;
  /** Share of tasks whose «first try» forecast came true. */
  firstTryHit: number;
  /** Median of fact/forecast; above 1 the PM is optimistic. Null with no measured pair. */
  tokensRatio: number | null; minutesRatio: number | null;
};

const round = (value: number) => Math.round(value * 100) / 100;
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

function summarize(area: string, scores: readonly ForecastScore[]): Calibration {
  const n = scores.length;
  return {
    area, tasks: n,
    filesMae: round(scores.reduce((sum, row) => sum + Math.abs(row.files.error), 0) / n),
    filesBias: round(scores.reduce((sum, row) => sum + row.files.error, 0) / n),
    firstTryHit: round(scores.filter((row) => row.firstTry.hit).length / n),
    tokensRatio: median(scores.flatMap((row) => row.tokensRatio === null ? [] : [row.tokensRatio])),
    minutesRatio: median(scores.flatMap((row) => row.minutesRatio === null ? [] : [row.minutesRatio])),
  };
}

/** The calibration over all scored tasks and per area (a task without an area counts under «—»); null overall when nothing is scored. */
export function calibrate(rows: ReadonlyArray<{ area: string | null; score: ForecastScore }>): { overall: Calibration | null; byArea: Calibration[] } {
  if (!rows.length) return { overall: null, byArea: [] };
  const groups = new Map<string, ForecastScore[]>();
  for (const row of rows) groups.set(row.area ?? "—", [...(groups.get(row.area ?? "—") ?? []), row.score]);
  return { overall: summarize("all", rows.map((row) => row.score)), byArea: [...groups].map(([area, scores]) => summarize(area, scores)).sort((a, b) => b.tasks - a.tasks || a.area.localeCompare(b.area)) };
}

/** One line for a PM before it promises a date: how its forecasts in the area held so far. Null under three scored tasks. */
export function calibrationLine(calibration: Calibration | undefined): string | null {
  if (!calibration || calibration.tasks < 3) return null;
  const factor = calibration.minutesRatio ?? calibration.tokensRatio;
  return `Your forecasts in ${calibration.area} (${calibration.tasks} tasks): files off by ${calibration.filesMae} on average (bias ${calibration.filesBias > 0 ? "+" : ""}${calibration.filesBias}), first-try right ${Math.round(calibration.firstTryHit * 100)}%${factor !== null ? `, real effort ×${factor} the forecast` : ""}.`;
}
