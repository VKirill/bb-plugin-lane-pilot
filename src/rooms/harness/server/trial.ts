import type { ArmAttempt } from "./store";

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
};

export const TRIAL_DEFAULTS: TrialConfig = { minPerArm: 6, maxDays: 14, minPerArmLate: 3, acceptanceSlack: 0.05 };

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

const FINISHED = new Set(["accepted", "blocked", "validation_failed", "empty_output", "provider_error", "canceled"]);

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
