import { describe, expect, it } from "vitest";
import { shouldStopCycle } from "../../src/rooms/policy/cycle";

describe("shouldStopCycle: stop when the bench shows no improvement two cycles in a row", () => {
  it("keeps going while it improves", () => {
    expect(shouldStopCycle([0.5, 0.6, 0.7, 0.8])).toBe(false);
  });

  it("one cycle without improvement is not enough", () => {
    expect(shouldStopCycle([0.5, 0.6, 0.6])).toBe(false);
    expect(shouldStopCycle([0.5, 0.6, 0.55])).toBe(false);
  });

  it("two in a row stop it, whether flat or worse", () => {
    expect(shouldStopCycle([0.5, 0.6, 0.6, 0.6])).toBe(true);
    expect(shouldStopCycle([0.5, 0.6, 0.55, 0.5])).toBe(true);
    expect(shouldStopCycle([0.5, 0.5, 0.5])).toBe(true);
  });

  it("an improvement between two stale cycles resets the count", () => {
    expect(shouldStopCycle([0.5, 0.6, 0.6, 0.7, 0.7])).toBe(false);
    expect(shouldStopCycle([0.5, 0.6, 0.6, 0.7, 0.7, 0.7])).toBe(true);
  });

  it("improvement is measured against the best so far, not the previous cycle", () => {
    // 0.7 is higher than the cycle before it (0.5) but not than the best (0.8)
    expect(shouldStopCycle([0.4, 0.8, 0.5, 0.7])).toBe(true);
  });

  it("too short a history never stops: the starting point plus two cycles are needed", () => {
    expect(shouldStopCycle([])).toBe(false);
    expect(shouldStopCycle([0.5])).toBe(false);
    expect(shouldStopCycle([0.5, 0.5])).toBe(false);
  });

  it("accepts {score} entries, an epsilon and another patience", () => {
    expect(shouldStopCycle([{ score: 0.5 }, { score: 0.6 }, { score: 0.6 }, { score: 0.6 }])).toBe(true);
    expect(shouldStopCycle([0.5, 0.505, 0.51], { epsilon: 0.02 })).toBe(true);
    expect(shouldStopCycle([0.5, 0.6, 0.6, 0.6], { patience: 3 })).toBe(false);
  });

  it("refuses a score that is not a number", () => {
    expect(() => shouldStopCycle([0.5, Number.NaN, 0.6])).toThrow(/finite/);
  });
});
