import { describe, expect, it } from "vitest";
import { compareDesigns, designScore, mergeFrames, scoreMeasurement, type Measurement } from "../../src/rooms/design-eval";

const clean: Measurement = { width: 375, overflowPx: 0, textElements: 40, lowContrast: 0, targets: 10, smallTargets: 0, tinyText: 0, h1: 1, spacingValues: 8 };

describe("the design rubric", () => {
  it("a clean page scores 100 at both widths; each fault lowers its own criterion", () => {
    expect(designScore([clean, { ...clean, width: 1280 }]).score).toBe(100);
    const faulty = scoreMeasurement({ ...clean, overflowPx: 40, lowContrast: 4, smallTargets: 5, tinyText: 3, h1: 2, spacingValues: 22 });
    expect(Object.fromEntries(faulty.map((c) => [c.id, Math.round(c.score * 100)]))).toEqual({ overflow: 0, contrast: 50, targets: 0, tiny_text: 70, one_h1: 0, spacing: 50 });
  });

  it("small targets are judged on a phone only", () => {
    expect(scoreMeasurement({ ...clean, width: 1280, smallTargets: 10 }).find((c) => c.id === "targets")!.score).toBe(1);
  });

  it("the paired judgement names the better version and what changed", () => {
    const before = [{ ...clean, overflowPx: 30 }, { ...clean, width: 1280 }];
    const after = [clean, { ...clean, width: 1280 }];
    expect(compareDesigns(before, after)).toMatchObject({ winner: "b", changes: [{ width: 375, id: "overflow", a: 0, b: 1 }] });
    expect(compareDesigns(after, after).winner).toBe("tie");
  });

  it("a page made of frames is measured as one: counts summed, the widest overflow", () => {
    expect(mergeFrames(1280, [{ ...clean, overflowPx: 3, h1: 0, spacingValues: 5 }, { ...clean, lowContrast: 2, h1: 1, spacingValues: 9 }]))
      .toEqual({ width: 1280, overflowPx: 3, textElements: 80, lowContrast: 2, targets: 20, smallTargets: 0, tinyText: 0, h1: 1, spacingValues: 9 });
  });
});
