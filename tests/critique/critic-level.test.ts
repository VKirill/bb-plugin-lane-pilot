import { describe, expect, it } from "vitest";
import { criticLevel, sampledSkip } from "../../src/rooms/critique/critic-level";

/** The critic's level by rule; it replaced the Jev screen `critique.screen`. */
const green = [{ exitCode: 0 }];
// A task id the one-in-ten sample does not pick, so a skip stays a skip.
const id = ["t1", "t2", "t3", "t4", "t5", "t6"].find((x) => !sampledSkip(x))!;
const level = (over: Partial<Parameters<typeof criticLevel>[0]>) => criticLevel({ taskId: id, kind: "fix", risk: "medium", paths: ["src/a.ts"], checks: green, ...over });

describe("critic level", () => {
  it("is strict for sensitive paths, high risk, edited reference tests and code without checks", () => {
    expect(level({ paths: ["src/billing/charge.ts"] })).toEqual({ tier: "strict", reason: "sensitive_path:src/billing/charge.ts" });
    expect(level({ paths: ["db/migrations/0042_users.sql"] }).tier).toBe("strict");
    expect(level({ paths: ["src/auth/session.ts"] }).tier).toBe("strict");
    expect(level({ risk: "high" })).toEqual({ tier: "strict", reason: "risk_high" });
    expect(level({ referenceTestEdits: ["tests/a.test.ts"] }).reason).toBe("reference_tests_edited");
    expect(level({ checks: [] })).toEqual({ tier: "strict", reason: "no_checks" });
  });
  it("skips small, green, non-feature work and docs or tests only, and names why", () => {
    expect(level({ paths: ["README.md", "docs/guide.md"], checks: [] })).toEqual({ tier: "skip", reason: "docs_tests_only" });
    expect(level({ kind: "refactor", paths: Array.from({ length: 8 }, (_, i) => `src/m${i}.ts`) })).toEqual({ tier: "skip", reason: "small_refactor" });
    expect(level({ paths: ["src/a.ts", "src/b.ts"] })).toEqual({ tier: "skip", reason: "small_change" });
    expect(level({ paths: ["src/styles/tokens.css"] }).tier).toBe("skip");
  });
  it("keeps the critic for features, bigger changes, red checks and pinned tasks", () => {
    expect(level({ kind: "feature" }).tier).toBe("normal");
    expect(level({ paths: ["a.ts", "b.ts", "c.ts", "d.ts"] }).tier).toBe("normal");
    expect(level({ checks: [{ exitCode: 1 }] }).reason).toBe("check_failed");
    expect(level({ pinned: true }).reason).toBe("pinned");
  });
  it("sends one skip in ten to the critic, the same way every time", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `task-${i}`);
    const share = ids.filter(sampledSkip).length / ids.length;
    expect(share).toBeGreaterThan(0.07);
    expect(share).toBeLessThan(0.14);
    const sampled = ids.find(sampledSkip)!;
    expect(criticLevel({ taskId: sampled, kind: "fix", risk: "low", paths: ["src/a.ts"], checks: green }).reason).toBe("skip_sampled:small_change");
  });
});
