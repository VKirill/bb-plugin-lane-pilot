import { describe, expect, it } from "vitest";
import { decideCanary, type CanaryRow } from "../../src/rooms/evolve";

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function simulateCanaryRows(
  pOld: number,
  pNew: number,
  pairs: number,
  seed: number,
  opts: { oldCost?: number | null; newCost?: number | null; oldSec?: number | null; newSec?: number | null } = {},
): CanaryRow[] {
  const next = seededRng(seed);
  const oldCost = opts.oldCost === undefined ? 1000 : opts.oldCost;
  const newCost = opts.newCost === undefined ? 500 : opts.newCost;
  const oldSec = opts.oldSec === undefined ? 20 : opts.oldSec;
  const newSec = opts.newSec === undefined ? 20 : opts.newSec;
  const rows: CanaryRow[] = [];
  for (let i = 0; i < pairs; i += 1) {
    rows.push({ arm: "old", accepted: next() < pOld, costMicroUsd: oldCost, seconds: oldSec });
    rows.push({ arm: "new", accepted: next() < pNew, costMicroUsd: newCost, seconds: newSec });
  }
  return rows;
}

describe("Task 29: anytime-valid canary monitor", () => {
  it("promotes a new arm equal to old with lower cost within 60 runs in a seeded simulation", () => {
    const rows = simulateCanaryRows(0.7, 0.7, 30, 62, { oldCost: 1000, newCost: 500 });
    let promotedAt = -1;
    for (let k = 1; k <= rows.length; k += 1) {
      const decision = decideCanary(rows.slice(0, k));
      if (decision.action === "promote") {
        promotedAt = k;
        expect(decision.e).toBeGreaterThanOrEqual(20);
        break;
      }
    }
    expect(promotedAt).toBeGreaterThan(0);
    expect(promotedAt).toBeLessThanOrEqual(60);

    // Without cost or time gain, the exact same acceptance sequence does not promote.
    const noGainRows = simulateCanaryRows(0.7, 0.7, 30, 62, { oldCost: null, newCost: null, oldSec: 20, newSec: 20 });
    const noGainDecision = decideCanary(noGainRows);
    expect(noGainDecision.action).toBe("retire");
    expect(noGainDecision.notes.join(" ")).toContain("inconclusive");

    // Higher cost per accepted run also blocks promotion when seconds are equal.
    const pricierRows = simulateCanaryRows(0.7, 0.7, 30, 62, { oldCost: 500, newCost: 2000, oldSec: 20, newSec: 20 });
    const pricierDecision = decideCanary(pricierRows);
    expect(pricierDecision.action).toBe("retire");
    expect(pricierDecision.notes.join(" ")).toContain("inconclusive");
  });

  it("promotes when median latency improves and cost is unmeasured", () => {
    const rows = simulateCanaryRows(0.7, 0.7, 30, 158, {
      oldCost: null,
      newCost: null,
      oldSec: 20,
      newSec: 12,
    });
    const decision = decideCanary(rows);
    expect(decision.action).toBe("promote");
  });

  it("retires a clearly worse arm before maxRuns", () => {
    const rows = simulateCanaryRows(0.85, 0.15, 30, 7);
    const decision = decideCanary(rows);
    expect(decision.action).toBe("retire");
    expect(decision.eFail).toBeGreaterThanOrEqual(20);
    expect(decision.notes.join(" ")).not.toContain("inconclusive");
  });

  it("never flips from retire back to continue on growing prefixes", () => {
    // Worse arm retires via eFail mid-stream, then gets lucky trailing successes.
    const worseThenLucky: CanaryRow[] = [
      ...simulateCanaryRows(0.9, 0.1, 15, 11),
      ...simulateCanaryRows(0.0, 1.0, 15, 12),
    ];
    let seenRetire = false;
    for (let k = 1; k <= worseThenLucky.length; k += 1) {
      const decision = decideCanary(worseThenLucky.slice(0, k));
      if (seenRetire) {
        expect(decision.action).toBe("retire");
      }
      if (decision.action === "retire") seenRetire = true;
    }
    expect(seenRetire).toBe(true);

    // Inconclusive sequence reaching maxRuns stays retired on longer prefixes too.
    const flatRows = simulateCanaryRows(0.8, 0.8, 35, 3, { oldCost: 1000, newCost: 1000 });
    let retiredAtMax = false;
    for (let k = 1; k <= flatRows.length; k += 1) {
      const decision = decideCanary(flatRows.slice(0, k));
      if (retiredAtMax) expect(decision.action).toBe("retire");
      if (decision.action === "retire") retiredAtMax = true;
    }
    expect(retiredAtMax).toBe(true);
  });

  it("triggers immediate rollback on a new-arm hardRed and ignores old-arm hardRed", () => {
    const oldHardRed: CanaryRow[] = [
      { arm: "old", accepted: false, costMicroUsd: 1000, seconds: 20, hardRed: true },
      { arm: "new", accepted: true, costMicroUsd: 500, seconds: 15 },
    ];
    expect(decideCanary(oldHardRed).action).toBe("continue");

    const newHardRed: CanaryRow[] = [
      { arm: "old", accepted: true, costMicroUsd: 1000, seconds: 20 },
      { arm: "new", accepted: false, costMicroUsd: 500, seconds: 15, hardRed: true },
    ];
    const rb = decideCanary(newHardRed);
    expect(rb.action).toBe("rollback");
  });

  it("keeps type-I promotion rate at or below 5% when peeking every run on 1,000 worse-by-15-points sequences", () => {
    const sequences = 1000;
    let falsePromotions = 0;
    for (let seed = 1; seed <= sequences; seed += 1) {
      const rows = simulateCanaryRows(0.85, 0.7, 30, seed, { oldCost: 1000, newCost: 500 });
      let promoted = false;
      for (let k = 1; k <= rows.length; k += 1) {
        const decision = decideCanary(rows.slice(0, k));
        if (decision.action === "promote") {
          promoted = true;
          break;
        }
        if (decision.action === "retire" || decision.action === "rollback") {
          break;
        }
      }
      if (promoted) falsePromotions += 1;
    }
    expect(falsePromotions / sequences).toBeLessThanOrEqual(0.05);
  });
});
