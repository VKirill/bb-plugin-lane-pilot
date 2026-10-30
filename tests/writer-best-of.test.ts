import { describe, expect, it } from "vitest";
import { BEST_OF_ROUNDS_SETTING, BEST_OF_SETTING, BEST_OF_SLOT_CAP_SETTING, BEST_OF_TOKEN_BUDGET_SETTING, ROUND_SEED_MAX_CHARS, bestOfBudgetAllows, bestOfPicks, pickBestAttempt, reserveAppetite, resolveBestOf, roundSeedBrief, roundSurvivors, type RoundCandidate } from "../src/rooms/writer/best-of";

const settings = (extra: Record<string, unknown> = {}) => ({ [BEST_OF_SETTING]: "3", ...extra });

describe("best-of-3 plan for quality_mode full", () => {
  it("is off outside full and off when the switch is off", () => {
    expect(resolveBestOf(settings(), "standard").enabled).toBe(false);
    expect(resolveBestOf(settings(), "quick").enabled).toBe(false);
    expect(resolveBestOf({}, "full").enabled).toBe(false);
    expect(resolveBestOf(settings({ [BEST_OF_SETTING]: "off" }), "full").enabled).toBe(false);
  });

  it("runs three candidates under full when the switch is on, the slot cap permitting", () => {
    expect(resolveBestOf(settings(), "full")).toEqual({ enabled: true, count: 3, tokenBudget: 0, slotCap: 3, rounds: 1 });
    expect(resolveBestOf(settings({ [BEST_OF_SLOT_CAP_SETTING]: 2 }), "full").count).toBe(2);
    const budgeted = resolveBestOf(settings({ [BEST_OF_TOKEN_BUDGET_SETTING]: 5000 }), "full");
    expect(bestOfBudgetAllows(budgeted, 4000)).toBe(true);
    expect(bestOfBudgetAllows(budgeted, 5000)).toBe(false);
  });

  it("counts three appetites in the dispatch reserve", () => {
    expect(reserveAppetite(1000, resolveBestOf(settings(), "full"))).toBe(3000);
    expect(reserveAppetite(1000, resolveBestOf({}, "full"))).toBe(1000);
  });

  it("picks the three writers from the fallback chain without repeats", () => {
    const picks = bestOfPicks({
      primary: { providerId: "codex", model: "writer-model" },
      fallbacks: [
        { providerId: "opencode2", model: "glm", reasoningLevel: "high" },
        { providerId: "opencode2", model: "gemini", reasoningLevel: "medium" },
      ],
      pm: { providerId: "claude-code", model: "pm-model" },
    });
    expect(picks).toEqual([
      { providerId: "codex", model: "writer-model" },
      { providerId: "opencode2", model: "glm" },
      { providerId: "opencode2", model: "gemini" },
    ]);
    // A short chain gives what it has: the PM's model is the last resort, never a repeat.
    const short = bestOfPicks({ primary: { providerId: "codex", model: "w" }, fallbacks: [], pm: { providerId: "claude-code", model: "pm" } });
    expect(short).toEqual([{ providerId: "codex", model: "w" }, { providerId: "claude-code", model: "pm" }]);
  });
});

describe("best-of-3 selection", () => {
  it("the green attempt wins of three where two are red; the reds close as superseded", () => {
    const result = pickBestAttempt([
      { attemptId: "a1", checksOk: false },
      { attemptId: "a2", checksOk: true },
      { attemptId: "a3", checksOk: false },
    ]);
    expect(result.winnerId).toBe("a2");
    expect(result.supersededIds).toEqual(["a1", "a3"]);
  });

  it("a tie of green candidates is decided by the critic verdict", () => {
    const result = pickBestAttempt([
      { attemptId: "a1", checksOk: true, critic: "fail" },
      { attemptId: "a2", checksOk: true, critic: "pass" },
      { attemptId: "a3", checksOk: true, critic: "fail" },
    ]);
    expect(result.winnerId).toBe("a2");
    expect(result.supersededIds).toEqual(["a1", "a3"]);
  });

  it("a tie the critic did not settle goes to the cheaper candidate, then the earlier one", () => {
    expect(pickBestAttempt([
      { attemptId: "a1", checksOk: true, tokens: 9000 },
      { attemptId: "a2", checksOk: true, tokens: 3000 },
    ]).winnerId).toBe("a2");
    expect(pickBestAttempt([
      { attemptId: "a1", checksOk: true, critic: "pass" },
      { attemptId: "a2", checksOk: true, critic: "pass" },
    ]).winnerId).toBe("a1");
  });

  it("no green candidate: no winner and nothing is superseded into the base", () => {
    expect(pickBestAttempt([{ attemptId: "a1", checksOk: false }, { attemptId: "a2", checksOk: false }])).toEqual({ winnerId: null, supersededIds: [] });
  });
});

describe("recursive best-of rounds (writer.best_of.rounds)", () => {
  it("one round by default; the switch caps at the maximum", () => {
    expect(resolveBestOf(settings(), "full").rounds).toBe(1);
    expect(resolveBestOf(settings({ [BEST_OF_ROUNDS_SETTING]: 2 }), "full").rounds).toBe(2);
    expect(resolveBestOf(settings({ [BEST_OF_ROUNDS_SETTING]: 99 }), "full").rounds).toBe(4);
    // Off stays one round even with the rounds key set.
    expect(resolveBestOf({ [BEST_OF_ROUNDS_SETTING]: 3 }, "full").rounds).toBe(1);
  });

  it("counts candidates × rounds in the dispatch reserve", () => {
    expect(reserveAppetite(1000, resolveBestOf(settings({ [BEST_OF_ROUNDS_SETTING]: 2 }), "full"))).toBe(6000);
    expect(reserveAppetite(1000, resolveBestOf(settings(), "full"))).toBe(3000);
  });

  it("two rounds: the round-1 survivors seed the round-2 briefs, the round-2 winner is picked as usual", () => {
    const runWriter = (brief: string) => ({ brief, checksOk: true });
    // Round 1: three candidates finish; two survive (a superseded and a green).
    const round1: RoundCandidate[] = [
      { attemptId: "a1", state: "failed", reason: "verification failed (npm test)", diffStat: " x.ts | 4 ++--" },
      { attemptId: "a2", state: "superseded", diffStat: " y.ts | 20 +++--" },
      { attemptId: "a3", state: "accepted", diffStat: " z.ts | 8 ++" },
    ];
    const survivors = roundSurvivors(round1);
    expect(survivors.map((c) => c.attemptId)).toEqual(["a3", "a2"]);

    // Round 2: each new candidate's first message carries the seed.
    const seed = roundSeedBrief(2, 2, survivors);
    expect(seed).toContain("round 2 of 2");
    expect(seed).toContain("a3");
    expect(seed).toContain("z.ts | 8 ++");
    expect(seed).not.toContain("a1");
    expect(seed.length).toBeLessThanOrEqual(ROUND_SEED_MAX_CHARS);
    const round2 = [runWriter(seed), runWriter(seed)];
    expect(round2.every((w) => w.brief === seed)).toBe(true);

    // The winner of round 2 is picked by the same rule as a single round.
    const result = pickBestAttempt([
      { attemptId: "b1", checksOk: true, tokens: 7000 },
      { attemptId: "b2", checksOk: true, tokens: 3000 },
      { attemptId: "b3", checksOk: false },
    ]);
    expect(result.winnerId).toBe("b2");
  });

  it("a round of all-red candidates seeds from the least-bad order, never from nothing", () => {
    const survivors = roundSurvivors([{ attemptId: "a1", state: "failed" }, { attemptId: "a2", state: "blocked" }]);
    expect(survivors).toHaveLength(1);
  });
});
