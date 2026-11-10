import type { TaskV2 } from "@lane-pilot/contracts";

/**
 * Plan prediction and calibration (SMA atlas D2-1: «Plan prediction engine», «Estimate-versus-fact report», rule 6 «a date only from the
 * register and the calibration»). Before dispatch the PM writes a forecast in the contract (`forecast`: files, whether every check passes on
 * the first attempt, optionally tokens and minutes); after acceptance the code compares it with the fact. Pure functions: the server reads
 * the facts, these score them and sum them up per area.
 */
export type Forecast = NonNullable<TaskV2["forecast"]>;
/** What happened: files the accepted attempt changed, whether it was the first attempt, its tokens and minutes (null: not measured).
 *  The declared-footprint fields (SMA k_lib_footprint): changed lines and the paths, and the package names the merge added. */
export type ForecastFact = { files: number; firstTry: boolean; tokens: number | null; minutes: number | null; lines?: number | null; dependencies?: string[]; changedPaths?: string[] };

export type ForecastScore = {
  files: { forecast: number; fact: number; error: number };
  firstTry: { forecast: boolean; fact: boolean; hit: boolean };
  /** fact / forecast; null when either side is missing or not measured. */
  tokensRatio: number | null;
  minutesRatio: number | null;
  /** Declared vs measured diff lines; null when the plan forecast none or the merge measured none. */
  lines: { forecast: number; fact: number; error: number } | null;
  /** Packages the merge added that the plan did not declare, and declared ones it did not add. */
  dependencies: { undeclared: string[]; notAdded: string[] } | null;
  /** contract.files against the merge's changed paths: changed files the plan did not name, and named files left untouched. */
  paths: { unplanned: string[]; untouched: string[] } | null;
};

/** Server-set at dispatch: the forecast belongs to this model, whatever the PM sent (SMA k_lib_modelver). */
export function stampForecastModel<T extends { forecast?: Forecast | null }>(task: T, model: string | null): T {
  if (!task.forecast || !model) return task;
  return { ...task, forecast: { ...task.forecast, model } };
}

const ratio = (fact: number | null, forecast: number | undefined): number | null =>
  fact === null || forecast === undefined || forecast <= 0 ? null : Math.round((fact / forecast) * 100) / 100;

export function scoreForecast(forecast: Forecast, fact: ForecastFact, plannedPaths?: readonly string[]): ForecastScore {
  const declared = forecast.dependencies ?? [], added = fact.dependencies ?? [];
  const diff = <T extends string>(have: readonly T[], other: readonly T[]) => have.filter((item) => !other.includes(item));
  const planned = plannedPaths ?? [], changed = fact.changedPaths ?? [];
  return {
    files: { forecast: forecast.files, fact: fact.files, error: fact.files - forecast.files },
    firstTry: { forecast: forecast.checks_pass_first_try, fact: fact.firstTry, hit: forecast.checks_pass_first_try === fact.firstTry },
    tokensRatio: ratio(fact.tokens, forecast.tokens),
    minutesRatio: ratio(fact.minutes, forecast.minutes),
    lines: forecast.lines === undefined || fact.lines === null || fact.lines === undefined ? null
      : { forecast: forecast.lines, fact: fact.lines, error: fact.lines - forecast.lines },
    dependencies: declared.length || added.length ? { undeclared: diff(added, declared), notAdded: diff(declared, added) } : null,
    paths: planned.length || changed.length ? { unplanned: diff(changed, planned), untouched: diff(planned, changed) } : null,
  };
}

/** The package names a merge's diff adds inside dependency manifests (SMA k_lib_footprint): package.json entries,
 *  requirements*.txt rows and pyproject.toml dependency strings; pure, over the `git diff` text. */
export function dependenciesAddedInDiff(diff: string): string[] {
  const names = new Set<string>();
  let file = "";
  // package.json keys are read only inside a dependencies{} block: «private» or «version» are not packages.
  let depIndent: number | null = null;
  for (const line of diff.split("\n")) {
    const head = line.match(/^\+\+\+ b\/(.+)$/);
    if (head) { file = head[1]!; depIndent = null; continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const raw = line.slice(1);
    const indent = raw.match(/^\s*/)![0].length;
    const body = raw.trim();
    const base = file.split("/").pop() ?? "";
    if (base === "package.json") {
      // ponytail: a package.json entry counts as a dependency only when its value reads as a version spec
      // (or inside a dependencies block). Known ceiling: an added "version" field still counts — a rename would fix it.
      if (depIndent !== null && indent <= depIndent) depIndent = null;
      if (/^"(?:dev|peer|optional|bundled)?[Dd]ependencies"\s*:\s*\{/.test(body)) { depIndent = indent; continue; }
      const dep = body.match(/^"([^"\s]+)"\s*:\s*"([^"]*)"/);
      if (dep && (depIndent !== null || /^([~^<>=*v\d]|workspace:|link:|file:|npm:|git\+)/.test(dep[2]!))) names.add(dep[1]!);
    } else if (/^requirements.*\.txt$/.test(base)) {
      const dep = body.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
      if (dep) names.add(dep[1]!);
    } else if (base === "pyproject.toml") {
      const dep = body.match(/^"?([A-Za-z0-9][A-Za-z0-9._-]*)\s*[<>=!~[]/) ?? body.match(/^['"]([A-Za-z0-9][A-Za-z0-9._-]*)['"]\s*,?\s*$/);
      if (dep) names.add(dep[1]!);
    }
  }
  return [...names];
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

/** The calibration over all scored tasks and per area (a task without an area counts under «—»); null overall when nothing is scored.
 *  With `model` only the forecasts that model stamped count (SMA k_lib_modelver): a fresh model starts with no history of its own. */
export function calibrate(rows: ReadonlyArray<{ area: string | null; score: ForecastScore; model?: string | null }>, model?: string | null): { overall: Calibration | null; byArea: Calibration[] } {
  const kept = model ? rows.filter((row) => row.model === model) : [...rows];
  if (!kept.length) return { overall: null, byArea: [] };
  const groups = new Map<string, ForecastScore[]>();
  for (const row of kept) groups.set(row.area ?? "—", [...(groups.get(row.area ?? "—") ?? []), row.score]);
  return { overall: summarize("all", kept.map((row) => row.score)), byArea: [...groups].map(([area, scores]) => summarize(area, scores)).sort((a, b) => b.tasks - a.tasks || a.area.localeCompare(b.area)) };
}

/** The trust badge of a calibration (SMA k_v_passport): unrated under three scored tasks, calibrated when forecasts hold, miscalibrated otherwise. */
export type CalibrationBadge = "unrated" | "calibrated" | "miscalibrated";
export function calibrationBadge(calibration: Calibration | null | undefined): CalibrationBadge {
  if (!calibration || calibration.tasks < 3) return "unrated";
  return calibration.filesMae <= 2 && calibration.firstTryHit >= 0.7 ? "calibrated" : "miscalibrated";
}

/** One line for a PM before it promises a date: how its forecasts in the area held so far. Null under three scored tasks. */
export function calibrationLine(calibration: Calibration | undefined): string | null {
  if (!calibration || calibration.tasks < 3) return null;
  const factor = calibration.minutesRatio ?? calibration.tokensRatio;
  return `Your forecasts in ${calibration.area} (${calibration.tasks} tasks): files off by ${calibration.filesMae} on average (bias ${calibration.filesBias > 0 ? "+" : ""}${calibration.filesBias}), first-try right ${Math.round(calibration.firstTryHit * 100)}%${factor !== null ? `, real effort ×${factor} the forecast` : ""}.`;
}
