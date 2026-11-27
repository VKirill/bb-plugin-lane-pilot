import { EVOLVE_THRESHOLDS, median } from "@lane-pilot/contracts";
import type { ArmAttempt } from "./types";
import { TERMINAL_ATTEMPT_STATES } from "../../contracts";
import { COST_TIME_TOLERANCE } from "./compare";

/**
 * The probe. Harness² probes a candidate by rolling the same task k times; a code task costs too much for that, so the
 * candidate is tried on the area's next tasks in alternation with the tree it replaces, and the two arms are compared
 * on what the pipeline already records. A trial ends only on evidence; in doubt the old tree stays (KEEP_BASE).
 */
export type TrialConfig = {
  /** Attempts each arm needs before the trial may decide. */
  minPerArm: number;
  /** After this long a trial decides on what it has, with at least `minPerArmLate` per arm; fewer retires it as unused. */
  maxDays: number;
  minPerArmLate: number;
  /** Acceptance may drop by this much and still count as "not worse" (noise on small samples). */
  acceptanceSlack: number;
  /** Days a trial may stay open without a bench verdict before it retires as not proven (J-001: freeze the queue, an open trial gets this long). */
  proveDays: number;
  /** Open trials per project at which new candidates are frozen. */
  maxOpen: number;
};

export const TRIAL_DEFAULTS: TrialConfig = { minPerArm: 6, maxDays: 14, minPerArmLate: 3, acceptanceSlack: 0.05, proveDays: 7, maxOpen: 1 };

export type ArmMetrics = { attempts: number; tasks: number; accepted: number; acceptanceRate: number; retries: number; retriesPerTask: number; blockingFindings: number; blockingPerAttempt: number };

export type TrialDecision =
  | { action: "wait"; reason: string; arms: { new: ArmMetrics; old: ArmMetrics } }
  | { action: "adopt" | "retire"; reason: string; arms: { new: ArmMetrics; old: ArmMetrics } };

/** The candidate tree's declared prediction (C3): which class it fixes and which measured metrics must not move. */
export type TrialPrediction = { fixes_class: string | null; must_not_move: string[] };

/** Whether the arms' metrics honor the prediction: fixes_class held when the new arm's blocking findings dropped. */
export function predictionHeldTrial(prediction: TrialPrediction, arms: { new: ArmMetrics; old: ArmMetrics }): { held: boolean; notes: string[] } {
  const notes: string[] = [];
  let held = true;
  if (prediction.fixes_class && arms.new.blockingPerAttempt >= arms.old.blockingPerAttempt) {
    held = false; notes.push(`fixes_class ${prediction.fixes_class}: blocking findings did not drop (${arms.new.blockingPerAttempt.toFixed(2)} vs ${arms.old.blockingPerAttempt.toFixed(2)})`);
  }
  for (const name of prediction.must_not_move) {
    const n = name.toLowerCase();
    if (n === "acceptance" && arms.new.acceptanceRate < arms.old.acceptanceRate) { held = false; notes.push(`must_not_move acceptance moved ${arms.old.acceptanceRate.toFixed(2)}→${arms.new.acceptanceRate.toFixed(2)}`); }
    if (n === "retries" && arms.new.retriesPerTask > arms.old.retriesPerTask) { held = false; notes.push(`must_not_move retries moved ${arms.old.retriesPerTask.toFixed(2)}→${arms.new.retriesPerTask.toFixed(2)}`); }
    if ((n === "blocking" || n === "blocking_findings") && arms.new.blockingPerAttempt > arms.old.blockingPerAttempt) { held = false; notes.push(`must_not_move blocking moved ${arms.old.blockingPerAttempt.toFixed(2)}→${arms.new.blockingPerAttempt.toFixed(2)}`); }
  }
  return { held, notes };
}

const FINISHED = new Set<string>([...TERMINAL_ATTEMPT_STATES, "validation_failed", "empty_output", "provider_error"]);

export function armMetrics(rows: readonly ArmAttempt[]): ArmMetrics {
  const finished = rows.filter((row) => FINISHED.has(row.state) && row.state !== "canceled");
  const tasks = new Set(finished.map((row) => row.taskId));
  const accepted = finished.filter((row) => row.state === "accepted").length;
  const retries = finished.filter((row) => row.attemptNo > 1).length;
  const blocking = finished.reduce((sum, row) => sum + row.blockingFindings, 0);
  return {
    attempts: finished.length, tasks: tasks.size, accepted,
    acceptanceRate: finished.length ? accepted / finished.length : 0,
    retries, retriesPerTask: tasks.size ? retries / tasks.size : 0,
    blockingFindings: blocking, blockingPerAttempt: finished.length ? blocking / finished.length : 0,
  };
}

/**
 * Who adopts a tree (`harness.adopt_by`, SMA plan P0-1): `bench` (default) adopts only after a bench comparison passed (src/rooms/bench:
 * the same fixed tasks on both trees, paired); the live alternation below stays as an observation and can still retire a tree that is
 * worse or unused. `live` is the old rule: the alternation alone decides.
 */
export type AdoptBy = "bench" | "live";
export type BenchVerdictInput = { passed: boolean; summary: string };

/** The live alternation's decision, then the bench's word over it when `adoptBy` is `bench`. Without the third argument it is the live rule only. */
export function decideTrial(rows: readonly ArmAttempt[], startedAt: number, now: number, config: TrialConfig = TRIAL_DEFAULTS, bench?: { adoptBy: AdoptBy; verdict: BenchVerdictInput | null }, prediction?: TrialPrediction | null): TrialDecision {
  const live = decideLive(rows, startedAt, now, config);
  const predicted = prediction ? predictionHeldTrial(prediction, live.arms) : null;
  if (predicted && !predicted.held) return { action: "retire", reason: `prediction unmet: ${predicted.notes.join("; ")}`, arms: live.arms };
  const withPrediction = (decision: TrialDecision): TrialDecision => predicted ? { ...decision, reason: `${decision.reason}; prediction held` } : decision;
  if (bench === undefined) return withPrediction(live);
  if (!bench || bench.adoptBy === "live") return withPrediction(live);
  // A bench comparison decides by itself: passed adopts, failed retires, whatever the live arms have collected.
  if (bench.verdict) {
    return withPrediction({ action: bench.verdict.passed ? "adopt" : "retire", reason: `bench ${bench.verdict.passed ? "passed" : "failed"}: ${bench.verdict.summary}; live observation: ${live.reason}`, arms: live.arms });
  }
  const ageDays = (now - startedAt) / 86_400_000;
  // No comparison yet: the live alternation can still retire a tree that is worse or unused, but it cannot adopt.
  if (live.action === "retire") return live;
  // J-001: a trial that stayed open `proveDays` without a bench verdict is not proven and retires, whatever the live arms say.
  if (ageDays >= config.proveDays) {
    return { action: "retire", reason: `not proven: ${Math.floor(ageDays)} days without a bench verdict (the proof window is ${config.proveDays})`, arms: live.arms };
  }
  // Past the deadline a missing bench is not a reason to wait: the collected live arms close the trial.
  if (ageDays >= config.maxDays && live.action === "adopt") {
    return withPrediction({ action: "retire", reason: `insufficient data: the ${config.maxDays}-day deadline passed without a bench comparison, so it is not adopted. Live observation: ${live.reason}`, arms: live.arms });
  }
  if (live.action === "adopt") return withPrediction({ action: "wait", reason: `live alternation favours it (${live.reason}) but adoption waits for a passed bench comparison: bb lane-pilot bench run/compare with --harness <tree id>`, arms: live.arms });
  return withPrediction(live);
}

function decideLive(rows: readonly ArmAttempt[], startedAt: number, now: number, config: TrialConfig): TrialDecision {
  const arms = { new: armMetrics(rows.filter((row) => row.arm === "new")), old: armMetrics(rows.filter((row) => row.arm === "old")) };
  const ageDays = (now - startedAt) / 86_400_000;
  const late = ageDays >= config.maxDays;
  const enough = arms.new.attempts >= config.minPerArm && arms.old.attempts >= config.minPerArm;
  const enoughLate = late && arms.new.attempts >= config.minPerArmLate && arms.old.attempts >= config.minPerArmLate;
  if (!enough && !enoughLate) {
    if (late) return { action: "retire", reason: `unused: after ${Math.floor(ageDays)} days the arms have ${arms.new.attempts} and ${arms.old.attempts} attempts`, arms };
    return { action: "wait", reason: `${arms.new.attempts}/${config.minPerArm} new, ${arms.old.attempts}/${config.minPerArm} old`, arms };
  }
  const notWorseAcceptance = arms.new.acceptanceRate >= arms.old.acceptanceRate - config.acceptanceSlack;
  const notWorseCritic = arms.new.blockingPerAttempt <= arms.old.blockingPerAttempt + 1e-9;
  const notWorseRetries = arms.new.retriesPerTask <= arms.old.retriesPerTask + 1e-9;
  const better = arms.new.acceptanceRate > arms.old.acceptanceRate + 1e-9 || arms.new.blockingPerAttempt < arms.old.blockingPerAttempt - 1e-9 || arms.new.retriesPerTask < arms.old.retriesPerTask - 1e-9;
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const summary = `acceptance ${pct(arms.new.acceptanceRate)} vs ${pct(arms.old.acceptanceRate)}, blocking findings/attempt ${arms.new.blockingPerAttempt.toFixed(2)} vs ${arms.old.blockingPerAttempt.toFixed(2)}, retries/task ${arms.new.retriesPerTask.toFixed(2)} vs ${arms.old.retriesPerTask.toFixed(2)} (new vs old, ${arms.new.attempts}/${arms.old.attempts} attempts)`;
  if (notWorseAcceptance && notWorseCritic && notWorseRetries && better) return { action: "adopt", reason: summary, arms };
  if (notWorseAcceptance && notWorseCritic && notWorseRetries) return { action: "retire", reason: `no measurable gain, the old tree stays: ${summary}`, arms };
  return { action: "retire", reason: `worse: ${summary}`, arms };
}

export type CanaryRow = {
  arm: "old" | "new";
  accepted: boolean;
  costMicroUsd: number | null;
  seconds: number | null;
  hardRed?: boolean;
};

export type CanaryConfig = {
  alpha: number;
  margin: number;
  minPerArm: number;
  maxRuns: number;
};

export const CANARY_DEFAULTS: CanaryConfig = {
  alpha: 0.05,
  margin: EVOLVE_THRESHOLDS.nonInferiority,
  minPerArm: 6,
  maxRuns: 60,
};

export type CanaryDecision = {
  action: "continue" | "promote" | "retire" | "rollback";
  e: number;
  eFail: number;
  notes: string[];
};

const CANARY_LAMBDA = 0.5;
const MIN_BET_FACTOR = 1e-6;

function canaryCostPerAccepted(rows: readonly CanaryRow[]): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  let accepted = 0;
  for (const row of rows) {
    if (row.costMicroUsd === null || !Number.isFinite(row.costMicroUsd)) return null;
    total += row.costMicroUsd;
    if (row.accepted) accepted += 1;
  }
  return accepted > 0 ? total / accepted : null;
}

function canaryGainDetail(oldRows: readonly CanaryRow[], newRows: readonly CanaryRow[]): string | null {
  const oldCpa = canaryCostPerAccepted(oldRows);
  const newCpa = canaryCostPerAccepted(newRows);
  const oldMedSec = median(oldRows.map((r) => r.seconds).filter((s): s is number => s !== null && Number.isFinite(s)));
  const newMedSec = median(newRows.map((r) => r.seconds).filter((s): s is number => s !== null && Number.isFinite(s)));
  const costDrops = oldCpa !== null && newCpa !== null && newCpa < oldCpa - 1e-9;
  const timeDrops = oldMedSec !== null && newMedSec !== null && newMedSec < oldMedSec - 1e-9;
  const costNotWorse = oldCpa === null || newCpa === null || newCpa <= oldCpa * (1 + COST_TIME_TOLERANCE) + 1e-9;
  const timeNotWorse = oldMedSec === null || newMedSec === null || newMedSec <= oldMedSec * (1 + COST_TIME_TOLERANCE) + 1e-9;
  if (costDrops && timeNotWorse) return `cost/accepted ${Math.round(newCpa)} < ${Math.round(oldCpa)} microUSD`;
  if (timeDrops && costNotWorse) return `median seconds ${newMedSec.toFixed(1)}s < ${oldMedSec.toFixed(1)}s`;
  return null;
}

/**
 * Anytime-valid sequential canary monitor (§5.4).
 * Evaluates rows in arrival order and stops at the first terminal boundary so growing prefixes never revert.
 */
export function decideCanary(rows: readonly CanaryRow[], config: Partial<CanaryConfig> = CANARY_DEFAULTS): CanaryDecision {
  const alpha = config.alpha ?? CANARY_DEFAULTS.alpha;
  const margin = config.margin ?? CANARY_DEFAULTS.margin;
  const minPerArm = config.minPerArm ?? CANARY_DEFAULTS.minPerArm;
  const maxRuns = config.maxRuns ?? CANARY_DEFAULTS.maxRuns;
  if (!(alpha > 0 && alpha < 1) || !Number.isFinite(alpha)) {
    throw new Error(`decideCanary alpha must be in (0, 1), got ${alpha}`);
  }
  if (!Number.isFinite(margin)) {
    throw new Error(`decideCanary margin must be finite, got ${margin}`);
  }
  if (!Number.isInteger(minPerArm) || minPerArm < 0) {
    throw new Error(`decideCanary minPerArm must be a non-negative integer, got ${minPerArm}`);
  }
  if (!Number.isInteger(maxRuns) || maxRuns < 1) {
    throw new Error(`decideCanary maxRuns must be a positive integer, got ${maxRuns}`);
  }

  const threshold = 1 / alpha;
  const oldRows: CanaryRow[] = [];
  const newRows: CanaryRow[] = [];
  let paired = 0;
  let e = 1;
  let eFail = 1;
  let gainMissingNoted = false;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.arm === "new" && row.hardRed) {
      return {
        action: "rollback",
        e,
        eFail,
        notes: [`hardRed flagged on new arm at run ${i + 1}`],
      };
    }

    if (row.arm === "old") oldRows.push(row);
    else newRows.push(row);

    while (paired < oldRows.length && paired < newRows.length) {
      const d = (newRows[paired]!.accepted ? 1 : 0) - (oldRows[paired]!.accepted ? 1 : 0);
      e *= Math.max(MIN_BET_FACTOR, 1 + CANARY_LAMBDA * (d - margin));
      eFail *= Math.max(MIN_BET_FACTOR, 1 + CANARY_LAMBDA * (margin - d));
      paired += 1;
    }

    if (oldRows.length >= minPerArm && newRows.length >= minPerArm) {
      if (eFail >= threshold) {
        return {
          action: "retire",
          e,
          eFail,
          notes: [`inferiority bound reached: eFail=${eFail.toFixed(2)} >= ${threshold.toFixed(2)} over ${paired} pairs`],
        };
      }
      if (e >= threshold) {
        const gain = canaryGainDetail(oldRows, newRows);
        if (gain) {
          return {
            action: "promote",
            e,
            eFail,
            notes: [`non-inferiority bound reached: e=${e.toFixed(2)} >= ${threshold.toFixed(2)} over ${paired} pairs`, `gain: ${gain}`],
          };
        }
        gainMissingNoted = true;
      }
    }

    if (i + 1 >= maxRuns) {
      return {
        action: "retire",
        e,
        eFail,
        notes: [
          `inconclusive: maxRuns (${maxRuns}) reached (e=${e.toFixed(2)}, eFail=${eFail.toFixed(2)}, pairs=${paired})`,
          ...(gainMissingNoted ? ["e reached threshold without measured cost or time gain"] : []),
        ],
      };
    }
  }

  return {
    action: "continue",
    e,
    eFail,
    notes: [
      `${paired} paired runs (old ${oldRows.length}, new ${newRows.length}, minPerArm ${minPerArm}); e=${e.toFixed(2)}, eFail=${eFail.toFixed(2)}`,
      ...(gainMissingNoted ? ["e reached threshold; waiting for measured cost or time gain"] : []),
    ],
  };
}
