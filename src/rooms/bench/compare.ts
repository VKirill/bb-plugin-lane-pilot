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

export type TaskStat = {
  taskId: string; repeats: number; accepted: number; passed: boolean;
  /** Mean per repeat. */
  stagesPassed: number; stagesFailed: number;
  costUsd: number | null; costState: "measured" | "partial" | "not_measured"; tokens: number | null; seconds: number | null;
};

export type ArmSummary = { arm: string; repeats: number; tasks: Map<string, TaskStat> };

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
export const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** One arm from its repeats: `byRepeat[i]` are the results of the i-th series (skipped-by-budget rows count as not run). */
export function summarizeArm(arm: string, byRepeat: readonly (readonly BenchResult[])[]): ArmSummary {
  const ids = new Set(byRepeat.flatMap((results) => results.filter((row) => row.state !== "skipped_budget").map((row) => row.taskId)));
  const tasks = new Map<string, TaskStat>();
  for (const taskId of ids) {
    const rows = byRepeat.flatMap((results) => results.filter((row) => row.taskId === taskId && row.state !== "skipped_budget"));
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
  return { arm, repeats: byRepeat.length, tasks };
}

export type Flip = { taskId: string; from: "pass" | "fail"; to: "pass" | "fail"; a: string; b: string; unstable: boolean };
export type Check = { name: string; ok: boolean; detail: string };
export type Comparison = {
  armA: string; armB: string; pairedTasks: number; onlyA: string[]; onlyB: string[];
  passed: { a: number; b: number };
  stages: { a: number; b: number };
  cost: { a: number | null; b: number | null; pairedTasks: number; notMeasured: string[] };
  seconds: { a: number | null; b: number | null };
  flips: Flip[];
  tolerance: { cost: number; time: number; stages: number; calibratedOn: string | null };
  checks: Check[];
  verdict: "pass" | "fail";
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
 * between the two identical runs are unstable: they are reported but cannot fail the rule.
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
  const checks: Check[] = [
    { name: "stages", ok: stagesB + stagesTol + 1e-9 >= stagesA, detail: `stages passed ${stagesB.toFixed(1)} vs ${stagesA.toFixed(1)} (B vs A), slack ${stagesTol.toFixed(1)} from noise` },
    costA === null || costB === null
      ? { name: "cost", ok: true, detail: `cost not measured for ${notMeasured.length} of ${paired.length} paired tasks on at least one arm: not compared` }
      : { name: "cost", ok: costB <= costA * (1 + costTol) + 1e-12, detail: `${usd(costB)} vs ${usd(costA)} on ${bothCost.length} tasks measured on both arms (${notMeasured.length} not measured); tolerance ${pct(costTol)}` },
    secondsA === null || secondsB === null
      ? { name: "time", ok: true, detail: "no recorded time to compare" }
      : { name: "time", ok: secondsB <= secondsA * (1 + timeTol) + 1e-9, detail: `median ${Math.round(secondsB)}s vs ${Math.round(secondsA)}s over ${timed.length} tasks; tolerance ${pct(timeTol)}` },
    { name: "no_regression", ok: regressions.length === 0, detail: regressions.length ? `passed on A and not on B: ${regressions.map((flip) => flip.taskId).join(", ")}` : `no task that passed on A fails on B${flips.some((flip) => flip.unstable) ? " (unstable tasks excluded)" : ""}` },
  ];
  return {
    armA: a.arm, armB: b.arm, pairedTasks: paired.length, onlyA: idsA.filter((id) => !b.tasks.has(id)), onlyB: idsB.filter((id) => !a.tasks.has(id)),
    passed: { a: paired.filter((id) => a.tasks.get(id)!.passed).length, b: paired.filter((id) => b.tasks.get(id)!.passed).length },
    stages: { a: stagesA, b: stagesB }, cost: { a: costA, b: costB, pairedTasks: bothCost.length, notMeasured },
    seconds: { a: secondsA, b: secondsB }, flips,
    tolerance: { cost: costTol, time: timeTol, stages: stagesTol, calibratedOn: noise ? `${noise.armA} vs ${noise.armB}` : null },
    checks, verdict: checks.every((check) => check.ok) ? "pass" : "fail",
  };
}

export function renderComparison(c: Comparison): string {
  const lines = [
    `Bench comparison ${c.armA} (A, baseline) vs ${c.armB} (B): ${c.pairedTasks} paired tasks${c.onlyA.length || c.onlyB.length ? `, ${c.onlyA.length} only on A, ${c.onlyB.length} only on B (not compared)` : ""}.`,
    `Tolerance: cost ${pct(c.tolerance.cost)}, time ${pct(c.tolerance.time)}, stages slack ${c.tolerance.stages.toFixed(1)}; ${c.tolerance.calibratedOn ? `calibrated on the noise of ${c.tolerance.calibratedOn}` : "NOT calibrated on a noise baseline (run `bench noise` on two identical arms)"}.`,
    `Tasks passed: A ${c.passed.a}, B ${c.passed.b}. Stages passed: A ${c.stages.a.toFixed(1)}, B ${c.stages.b.toFixed(1)}. Cost: A ${usd(c.cost.a)}, B ${usd(c.cost.b)} (${c.cost.pairedTasks} tasks measured on both). Median time: A ${c.seconds.a === null ? "-" : `${Math.round(c.seconds.a)}s`}, B ${c.seconds.b === null ? "-" : `${Math.round(c.seconds.b)}s`}.`,
    c.cost.notMeasured.length ? `Cost not measured on at least one arm for: ${c.cost.notMeasured.join(", ")}.` : "",
    `Flips: ${c.flips.length ? c.flips.map((flip) => `${flip.taskId} ${flip.from}->${flip.to} (${flip.a} vs ${flip.b})${flip.unstable ? " [unstable in noise]" : ""}`).join("; ") : "none"}.`,
    ...c.checks.map((check) => `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`),
    `Verdict: ${c.verdict.toUpperCase()}.`,
  ];
  return lines.filter(Boolean).join("\n");
}
