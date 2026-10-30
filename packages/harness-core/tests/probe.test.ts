import { describe, expect, it } from "vitest";
import { PROBE_DEFAULTS, formatProbeContrasts, replayCandidate, selectProbeAttempts, type ProbeSource } from "../src/index";

const attempt = (id: string, tokens: number): ProbeSource => ({
  attemptId: id, tokens, brief: `brief ${id}`, outcome: `blocked: ${id} missed the check`,
});

describe("selectProbeAttempts", () => {
  it("takes one or two saved attempts of the key and stops at the token budget", () => {
    const picked = selectProbeAttempts(
      [attempt("a1", 10_000), attempt("a2", 10_000), attempt("a3", 10_000)],
      { maxAttempts: 2, tokenBudget: 24_000 },
    );
    expect(picked.map((row) => row.attemptId)).toEqual(["a1", "a2"]);
    expect(picked.reduce((sum, row) => sum + row.tokens, 0)).toBeLessThanOrEqual(24_000);
  });

  it("skips the round when the token budget is zero", () => {
    expect(selectProbeAttempts([attempt("a1", 100)], { ...PROBE_DEFAULTS, tokenBudget: 0 })).toEqual([]);
  });

  it("still replays the newest attempt when it alone is larger than the budget, clipped to the budget", () => {
    const picked = selectProbeAttempts([attempt("huge", 90_000), attempt("next", 100)], { maxAttempts: 2, tokenBudget: 8_000 });
    expect(picked).toEqual([expect.objectContaining({ attemptId: "huge", tokens: 8_000 })]);
  });
});

describe("replayCandidate", () => {
  it("replays a candidate diff on a saved attempt and clips both sides to the budget", () => {
    const contrast = replayCandidate({
      label: "inv",
      diff: `+${"x".repeat(200)}`,
      attempt: attempt("a1", 4_000),
      tokenBudget: 40,
    });
    expect(contrast.candidate).toBe("inv");
    expect(contrast.attemptId).toBe("a1");
    expect(contrast.added.length).toBeLessThanOrEqual(80);
    expect(contrast.outcome).toContain("a1");
    expect(formatProbeContrasts([contrast])).toContain("attempt a1");
    expect(formatProbeContrasts([contrast])).toContain("inv");
  });
});
