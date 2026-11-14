import { describe, expect, it } from "vitest";
import { judge } from "./subject";

// A behaviour test: it checks the result (status, score and target), so a flipped branch fails it by an assertion.
describe("fixture", () => {
  it("[fx] a score of 7 or more passes, less is sent back, and the verdict names its target", () => {
    expect(judge(8, "src/a.ts")).toEqual({ status: "pass", score: 8, target: "src/a.ts" });
    expect(judge(3, "src/b.ts")).toEqual({ status: "rework", score: 3, target: "src/b.ts" });
  });
});
