import { describe, expect, it } from "vitest";
import { judge } from "./subject";

// A deliberately hollow test: it checks only that something came back, so no shape-preserving mutation can fail it.
describe("fixture", () => {
  it("[fx] judge answers", () => {
    const verdict = judge(8, "src/a.ts");
    expect(verdict).toBeTruthy();
    expect(typeof verdict.status).toBe("string");
  });
});
