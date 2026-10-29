import type { BenchResult } from "./store";
import type { NoiseRecord } from "./store";

/**
 * The paired comparison of two arms on one set (SMA plan P0-1, #31448: «три числа: сколько стадий прошло, сколько стоило, сколько заняло»).
 * Everything is arithmetic on the recorded results: no model judges anything.
 *
 * A task is *passed* on an arm when it was accepted in more than half of that arm's repeats. Cost is the list price of the writer's
 * tokens and is compared only on tasks where both arms measured it; a task a provider reports no usage for is listed as not measured,
 * never read as 0. Time is the seconds from the attempt's creation to its end, summed over the task's attempts.
 */
export const COST_TIME_TOLERANCE = 0.1;
/**
 * What a comparison needs before it may say pass or fail. Fewer paired tasks than the floor, or fewer than most of what the arms were asked
 * to run, is too little to judge: two paired tasks of eight, with the cost on one of them, once ruled three night repairs (benchverdict_a86c7f125849 and its two twins).
 * The floor is three because one flip is then at most a third of the evidence, and the share keeps a subset that lost much of its tasks to
 * errors or the budget from standing for the whole set: this verdict accepts or retires a change, and 4 of 8 passed as «not worse» (Astra, 2026-10-27).
 * An arm that ran out of its budget did not run the rest of the set; that is unfinished, not a smaller set. There is no lower floor for a «canary» comparison:
 * no such mode exists. A cost or a time measured on fewer than two pairs compares nothing: a median or a sum of one.
 */
export const MIN_PAIRED_TASKS = 3;
export const MIN_PAIRED_SHARE = 0.8;
export const MIN_MEASURED_PAIRS = 2;

export type TaskStat = {
  taskId: string; repeats: number; accepted: number; passed: boolean;
  /** Mean per repeat. */
  stagesPassed: number; stagesFailed: number;
  costUsd: number | null; costState: "measured" | "partial" | "not_measured"; tokens: number | null; seconds: number | null;
};

/**
 * `selected`: the tasks the arm was asked to run (judged, skipped by the budget and errored alike). `errored`: tasks whose run broke before a writer
 * could be judged (no project, checkout failed, dispatch refused): the arm did not complete, and they are not read as failures of the change.
 * `incomplete`: why the series is not a finished measurement (still running, failed, stopped by its budget).
 */
export type ArmSummary = { arm: string; repeats: number; tasks: Map<string, TaskStat>; selected: number; errored: string[]; incomplete: string[] };

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
export const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** One arm from its repeats: `byRepeat[i]` are the results of the i-th series (skipped-by-budget rows count as not run). */
export function summarizeArm(arm: string, byRepeat: readonly (readonly BenchResult[])[], incomplete: readonly string[] = []): ArmSummary {
  const judged = (row: BenchResult) => row.state !== "skipped_budget" && row.state !== "error";
  const unrun = byRepeat.flatMap((results) => results.filter((row) => row.state === "skipped_budget").map((row) => row.taskId));
  const ids = new Set(byRepeat.flatMap((results) => results.filter(judged).map((row) => row.taskId)));
  const selected = new Set(byRepeat.flatMap((results) => results.map((row) => row.taskId)));
  const errored = [...new Set(byRepeat.flatMap((results) => results.filter((row) => row.state === "error").map((row) => row.taskId)))];
  const tasks = new Map<string, TaskStat>();
  for (const taskId of ids) {
    const rows = byRepeat.flatMap((results) => results.filter((row) => row.taskId === taskId && judged(row)));
    const accepted = rows.filter((row) => row.accepted).length;
    const measured = rows.filter((row) => row.costState === "measured" && row.costUsd !== null);
    const costState = measured.length === rows.length ? "measured" : measured.length ? "partial" : "not_measured";
    const seconds = rows.filter((row) => row.seconds !== null).map((row) => row.seconds as number);
    tasks.set(taskId, {
      taskId, repeats: rows.length, accepted, passed: accepted * 2 > rows.length,
      stagesPassed: mean(rows.map((row) => row.stagesPassed)), stagesFailed: mean(rows.map((row) => row.stagesFailed)),
      costUsd: costState === "measured" ? mean(measured.map((row) => row.costUsd as number)) : null, costState,
      tokens: costState === "measured" ? mean(measured.map((row) => row.tokens ?? 0)) : null,
      seconds: seconds.length ? mean(seconds) : null,
    });
  }
  // Tasks the budget kept the arm from running are not a smaller set: the arm is unfinished (the hard half is often the half that never ran).
  const budget = unrun.length ? [`${unrun.length} task run(s) not run: the arm's budget ran out (${[...new Set(unrun)].slice(0, 5).join(", ")})`] : [];
  return { arm, repeats: byRepeat.length, tasks, selected: selected.size, errored, incomplete: [...incomplete, ...budget] };
}

export type Flip = { taskId: string; from: "pass" | "fail"; to: "pass" | "fail"; a: string; b: string; unstable: boolean };
/** `ok: null`: the check could not be made (no measurement); it is neither a pass nor a fail. */
export type Check = { name: string; ok: boolean | null; detail: string };
export type Comparison = {
  armA: string; armB: string; pairedTasks: number; onlyA: string[]; onlyB: string[];
  passed: { a: number; b: number };
  stages: { a: number; b: number };
  cost: { a: number | null; b: number | null; pairedTasks: number; notMeasured: string[] };
  seconds: { a: number | null; b: number | null };
  flips: Flip[];
  tolerance: { cost: number; time: number; stages: number; calibratedOn: string | null };
  checks: Check[];
  /** `inconclusive`: too little was measured to say better or worse; it is never read as a pass or as a fail. */
  verdict: "pass" | "fail" | "inconclusive";
  /** Tasks that failed on A and pass on B (not counting unstable ones). A `pass` with none of them is «not worse», never «better». */
  improvements: string[];
};

/** Noise from two identical arms: which tasks flipped between them, and how far apart their cost, time and stage counts were. */
export function computeNoise(one: ArmSummary, two: ArmSummary): NoiseRecord["noise"] {
  const shared = [...one.tasks.keys()].filter((id) => two.tasks.has(id));
  const unstable = shared.filter((id) => one.tasks.get(id)!.passed !== two.tasks.get(id)!.passed);
  const rel = (x: number, y: number): number => (x + y === 0 ? 0 : Math.abs(x - y) / ((x + y) / 2));
  const bothCost = shared.filter((id) => one.tasks.get(id)!.costUsd !== null && two.tasks.get(id)!.costUsd !== null);
  const sumOf = (arm: ArmSummary, ids: string[], pick: (stat: TaskStat) => number | null) => ids.reduce((sum, id) => sum + (pick(arm.tasks.get(id)!) ?? 0), 0);
  const timed = shared.filter((id) => one.tasks.get(id)!.seconds !== null && two.tasks.get(id)!.seconds !== null);
  const stages = (arm: ArmSummary) => sumOf(arm, shared, (stat) => stat.stagesPassed);
  return {
    unstableTasks: unstable, flipShare: shared.length ? unstable.length / shared.length : 0,
    costRel: bothCost.length ? rel(sumOf(one, bothCost, (s) => s.costUsd), sumOf(two, bothCost, (s) => s.costUsd)) : null,
    secondsRel: timed.length ? rel(median(timed.map((id) => one.tasks.get(id)!.seconds as number)) ?? 0, median(timed.map((id) => two.tasks.get(id)!.seconds as number)) ?? 0) : null,
    stagesSlack: Math.abs(stages(one) - stages(two)), tasks: shared.length,
  };
}

const usd = (value: number | null) => (value === null ? "not measured" : `$${value.toFixed(value < 1 ? 3 : 2)}`);
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/**
 * The acceptance rule for a change (arm B against the baseline A): stages not worse; cost and time not worse by more than the
 * tolerance (10%, or the noise of two identical runs when that is larger); no task that passed on A fails on B. Tasks that flipped
 * between the two identical runs are unstable: they are reported but cannot fail the rule. When too little was measured (see MIN_PAIRED_TASKS)
 * the verdict is `inconclusive`: no answer, and no pass or fail for anyone to act on.
 */
export function compareArms(a: ArmSummary, b: ArmSummary, noise?: NoiseRecord | null): Comparison {
  const idsA = [...a.tasks.keys()], idsB = [...b.tasks.keys()];
  const paired = idsA.filter((id) => b.tasks.has(id));
  const unstable = new Set(noise?.noise.unstableTasks ?? []);
  const costTol = Math.max(COST_TIME_TOLERANCE, noise?.noise.costRel ?? 0), timeTol = Math.max(COST_TIME_TOLERANCE, noise?.noise.secondsRel ?? 0);
  const stagesTol = noise?.noise.stagesSlack ?? 0;
  const sum = (arm: ArmSummary, ids: string[], pick: (stat: TaskStat) => number) => ids.reduce((total, id) => total + pick(arm.tasks.get(id)!), 0);
  const stagesA = sum(a, paired, (s) => s.stagesPassed), stagesB = sum(b, paired, (s) => s.stagesPassed);
  const bothCost = paired.filter((id) => a.tasks.get(id)!.costUsd !== null && b.tasks.get(id)!.costUsd !== null);
  const notMeasured = paired.filter((id) => !bothCost.includes(id));
  const costA = bothCost.length ? sum(a, bothCost, (s) => s.costUsd ?? 0) : null, costB = bothCost.length ? sum(b, bothCost, (s) => s.costUsd ?? 0) : null;
  const timed = paired.filter((id) => a.tasks.get(id)!.seconds !== null && b.tasks.get(id)!.seconds !== null);
  const secondsA = median(timed.map((id) => a.tasks.get(id)!.seconds as number)), secondsB = median(timed.map((id) => b.tasks.get(id)!.seconds as number));
  const flips: Flip[] = [];
  for (const id of paired) {
    const x = a.tasks.get(id)!, y = b.tasks.get(id)!;
    if (x.passed === y.passed) continue;
    flips.push({ taskId: id, from: x.passed ? "pass" : "fail", to: y.passed ? "pass" : "fail", a: `${x.accepted}/${x.repeats}`, b: `${y.accepted}/${y.repeats}`, unstable: unstable.has(id) });
  }
  const regressions = flips.filter((flip) => flip.from === "pass" && flip.to === "fail" && !flip.unstable);
  const improvements = flips.filter((flip) => flip.from === "fail" && flip.to === "pass" && !flip.unstable).map((flip) => flip.taskId);
  const asked = Math.max(a.selected, b.selected);
  const needed = Math.max(MIN_PAIRED_TASKS, Math.ceil(asked * MIN_PAIRED_SHARE));
  const unfinished = [...a.incomplete.map((why) => `${a.arm}: ${why}`), ...b.incomplete.map((why) => `${b.arm}: ${why}`),
    ...(a.errored.length ? [`${a.arm}: ${a.errored.length} task(s) errored before they could be judged (${a.errored.slice(0, 5).join(", ")})`] : []),
    ...(b.errored.length ? [`${b.arm}: ${b.errored.length} task(s) errored before they could be judged (${b.errored.slice(0, 5).join(", ")})`] : [])];
  const enough = paired.length >= needed && unfinished.length === 0;
  const checks: Check[] = [
    { name: "coverage", ok: enough ? true : null,
      detail: `${paired.length} paired tasks of ${asked} asked (at least ${needed} needed)${unfinished.length ? `; unfinished: ${unfinished.join("; ")}` : ""}` },
    { name: "stages", ok: stagesB + stagesTol + 1e-9 >= stagesA, detail: `stages passed ${stagesB.toFixed(1)} vs ${stagesA.toFixed(1)} (B vs A), slack ${stagesTol.toFixed(1)} from noise` },
    costA === null || costB === null || bothCost.length < MIN_MEASURED_PAIRS
      ? { name: "cost", ok: null, detail: `cost not measured on both arms for ${paired.length - bothCost.length} of ${paired.length} paired tasks (${MIN_MEASURED_PAIRS} measured pairs needed, ${bothCost.length} found): not compared` }
      : { name: "cost", ok: costB <= costA * (1 + costTol) + 1e-12, detail: `${usd(costB)} vs ${usd(costA)} on ${bothCost.length} tasks measured on both arms (${notMeasured.length} not measured); tolerance ${pct(costTol)}` },
    secondsA === null || secondsB === null || timed.length < MIN_MEASURED_PAIRS
      ? { name: "time", ok: null, detail: `time not recorded on both arms for ${paired.length - timed.length} of ${paired.length} paired tasks (${MIN_MEASURED_PAIRS} recorded pairs needed, ${timed.length} found): not compared` }
      : { name: "time", ok: secondsB <= secondsA * (1 + timeTol) + 1e-9, detail: `median ${Math.round(secondsB)}s vs ${Math.round(secondsA)}s over ${timed.length} tasks; tolerance ${pct(timeTol)}` },
    { name: "no_regression", ok: regressions.length === 0, detail: regressions.length ? `passed on A and not on B: ${regressions.map((flip) => flip.taskId).join(", ")}` : `no task that passed on A fails on B${flips.some((flip) => flip.unstable) ? " (unstable tasks excluded)" : ""}` },
  ];
  // Without the coverage nothing below it is evidence, even a regression: it stands on a few tasks. A real regression with enough coverage fails
  // whatever else is unmeasured; a check that could not be made keeps the rest from passing.
  const verdict: Comparison["verdict"] = !enough ? "inconclusive" : checks.some((check) => check.ok === false) ? "fail" : checks.some((check) => check.ok === null) ? "inconclusive" : "pass";
  return {
    armA: a.arm, armB: b.arm, pairedTasks: paired.length, onlyA: idsA.filter((id) => !b.tasks.has(id)), onlyB: idsB.filter((id) => !a.tasks.has(id)),
    passed: { a: paired.filter((id) => a.tasks.get(id)!.passed).length, b: paired.filter((id) => b.tasks.get(id)!.passed).length },
    stages: { a: stagesA, b: stagesB }, cost: { a: costA, b: costB, pairedTasks: bothCost.length, notMeasured },
    seconds: { a: secondsA, b: secondsB }, flips,
    tolerance: { cost: costTol, time: timeTol, stages: stagesTol, calibratedOn: noise ? `${noise.armA} vs ${noise.armB}` : null },
    checks, verdict, improvements,
  };
}

export type PassReport = { tasks: number; repeats: number; passAt1: number; passPow: number };

/**
 * The same set run N times. pass@1 is the share accepted at least once; pass^k is the share accepted on every repeat.
 * A task missing a judged row on any repeat is left out.
 */
export function passReport(byRepeat: readonly (readonly BenchResult[])[]): PassReport {
  const judged = (row: BenchResult) => row.state === "accepted" || row.state === "not_accepted";
  const ids = [...new Set(byRepeat.flatMap((rows) => rows.map((row) => row.taskId)))];
  let once = 0, every = 0, counted = 0;
  for (const id of ids) {
    const rows = byRepeat.map((results) => results.find((row) => row.taskId === id)).filter((row): row is BenchResult => !!row && judged(row));
    if (rows.length !== byRepeat.length) continue;
    counted++;
    if (rows.some((row) => row.accepted)) once++;
    if (rows.every((row) => row.accepted)) every++;
  }
  return { tasks: counted, repeats: byRepeat.length, passAt1: counted ? once / counted : 0, passPow: counted ? every / counted : 0 };
}

/** Noise of one arm against itself: the first repeat and the last. Null when there is only one. */
export function noiseOfRepeats(arm: string, byRepeat: readonly (readonly BenchResult[])[]): NoiseRecord["noise"] | null {
  if (byRepeat.length < 2) return null;
  return computeNoise(summarizeArm(`${arm}#1`, [byRepeat[0]!]), summarizeArm(`${arm}#${byRepeat.length}`, [byRepeat[byRepeat.length - 1]!]));
}

export function renderComparison(c: Comparison): string {
  const lines = [
    `Bench comparison ${c.armA} (A, baseline) vs ${c.armB} (B): ${c.pairedTasks} paired tasks${c.onlyA.length || c.onlyB.length ? `, ${c.onlyA.length} only on A, ${c.onlyB.length} only on B (not compared)` : ""}.`,
    `Tolerance: cost ${pct(c.tolerance.cost)}, time ${pct(c.tolerance.time)}, stages slack ${c.tolerance.stages.toFixed(1)}; ${c.tolerance.calibratedOn ? `calibrated on the noise of ${c.tolerance.calibratedOn}` : "NOT calibrated on a noise baseline (run `bench noise` on two identical arms)"}.`,
    `Tasks passed: A ${c.passed.a}, B ${c.passed.b}. Stages passed: A ${c.stages.a.toFixed(1)}, B ${c.stages.b.toFixed(1)}. Cost: A ${usd(c.cost.a)}, B ${usd(c.cost.b)} (${c.cost.pairedTasks} tasks measured on both). Median time: A ${c.seconds.a === null ? "-" : `${Math.round(c.seconds.a)}s`}, B ${c.seconds.b === null ? "-" : `${Math.round(c.seconds.b)}s`}.`,
    c.cost.notMeasured.length ? `Cost not measured on at least one arm for: ${c.cost.notMeasured.join(", ")}.` : "",
    `Flips: ${c.flips.length ? c.flips.map((flip) => `${flip.taskId} ${flip.from}->${flip.to} (${flip.a} vs ${flip.b})${flip.unstable ? " [unstable in noise]" : ""}`).join("; ") : "none"}.`,
    ...c.checks.map((check) => `${check.ok === null ? "n/a " : check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`),
    `Verdict: ${c.verdict.toUpperCase()}${c.verdict === "inconclusive" ? " (too little was measured to call it better or worse)"
      : c.verdict === "pass" ? (c.improvements.length ? ` (not worse on every criterion, and better on ${c.improvements.join(", ")})` : " (not worse on every criterion measured; no improvement shown, equality is not an improvement)") : ""}.`,
  ];
  return lines.filter(Boolean).join("\n");
}
