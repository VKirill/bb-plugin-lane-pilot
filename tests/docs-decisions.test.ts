import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Audit 2026-10-08 round 4, item 23: the decision about access to the hub's data.db lived only in the BB-сервис root, not in this repository.
describe("decision records live in the repository", () => {
  it("has the ADR about access to the hub's data.db", () => {
    const path = join(__dirname, "..", "docs", "decisions", "2026-10-08-lane-pilot-data-db-access.md");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("0600");
    expect(text).toContain("0700");
    expect(text).toContain("Остающийся риск");
  });
});
