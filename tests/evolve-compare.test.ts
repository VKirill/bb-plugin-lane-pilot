import { describe, expect, it } from "vitest";
import {
  compareArms,
  pairedBootstrapInterval,
  renderComparison,
  summarizeArm,
  wilsonInterval,
  type BenchResult,
} from "../src/rooms/evolve";

const row = (taskId: string, accepted: boolean): BenchResult => ({
  taskId,
  state: accepted ? "accepted" : "not_accepted",
  accepted,
  stagesPassed: accepted ? 2 : 1,
  stagesFailed: accepted ? 0 : 1,
  tokens: 10,
  costUsd: 0.1,
  costState: "measured",
  seconds: 10,
});

const arm = (name: string, flags: boolean[]) => summarizeArm(name, [flags.map((accepted, index) => row(`t${index}`, accepted))]);

describe("evolve comparison confidence interval", () => {
  it("puts a 95% interval on each arm and on the paired difference", () => {
    const none = wilsonInterval(0, 20);
    const all = wilsonInterval(20, 20);
    expect(none.low).toBe(0);
    expect(none.high).toBeLessThan(0.2);
    expect(all.low).toBeGreaterThan(0.8);
    const separated = compareArms(arm("A", Array(20).fill(false)), arm("B", Array(20).fill(true)));
    expect(separated.passCi.level).toBe(0.95);
    expect(separated.passCi.diff.low).toBeGreaterThan(0);
    const tied = compareArms(arm("A", Array(20).fill(true)), arm("B", Array(20).fill(true)));
    expect(tied.passCi.diff.low).toBeLessThanOrEqual(0);
    expect(tied.passCi.diff.high).toBeGreaterThanOrEqual(0);
    expect(renderComparison(separated)).toMatch(/95% CI/);
    expect(renderComparison(tied)).toMatch(/inside the noise/);
  });

  it("computes deterministic paired bootstrap intervals on matched inputs", () => {
    const empty = pairedBootstrapInterval([], []);
    expect(empty).toEqual({ mean: 0, low: 0, high: 0, level: 0.95, pairs: 0 });

    // Every input shifts by +0.1 despite large between-input spread: pairing collapses variance.
    const a = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const b = a.map((v) => v + 0.1);
    const shifted = pairedBootstrapInterval(a, b);
    expect(shifted.pairs).toBe(8);
    expect(shifted.mean).toBeCloseTo(0.1, 10);
    expect(shifted.low).toBeCloseTo(0.1, 10);
    expect(shifted.high).toBeCloseTo(0.1, 10);

    // Mixed paired differences span 0 while consistent gains stay strictly positive and reproducible.
    const mixedA = [1, 0, 1, 0, 1, 0, 1, 0];
    const mixedB = [0, 1, 0, 1, 1, 0, 1, 0];
    const mixed = pairedBootstrapInterval(mixedA, mixedB);
    expect(mixed.mean).toBe(0);
    expect(mixed.low).toBeLessThanOrEqual(0);
    expect(mixed.high).toBeGreaterThanOrEqual(0);
    expect(pairedBootstrapInterval(mixedA, mixedB)).toEqual(mixed);

    const winA = Array(20).fill(false);
    const winB = [...Array(16).fill(true), ...Array(4).fill(false)];
    const gain = pairedBootstrapInterval(winA, winB);
    expect(gain.mean).toBeCloseTo(0.8, 10);
    expect(gain.low).toBeGreaterThan(0.5);
    expect(gain.high).toBeLessThanOrEqual(1);
  });

  it("rejects mismatched paired lengths or invalid bootstrap options", () => {
    expect(() => pairedBootstrapInterval([1], [1, 2])).toThrow(/equal-length/);
    expect(() => pairedBootstrapInterval([1], [1], { level: 1 })).toThrow(/level/);
    expect(() => pairedBootstrapInterval([1], [1], { resamples: 0 })).toThrow(/resamples/);
  });
});
