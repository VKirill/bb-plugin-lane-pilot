import { describe, expect, it } from "vitest";
import { BEST_OF_SETTING, BEST_OF_SLOT_CAP_SETTING, BEST_OF_TOKEN_BUDGET_SETTING, bestOfBudgetAllows, bestOfPicks, pickBestAttempt, reserveAppetite, resolveBestOf } from "../src/rooms/writer/best-of";

const settings = (extra: Record<string, unknown> = {}) => ({ [BEST_OF_SETTING]: "3", ...extra });

describe("best-of-3 plan for quality_mode full", () => {
  it("is off outside full and off when the switch is off", () => {
    expect(resolveBestOf(settings(), "standard").enabled).toBe(false);
    expect(resolveBestOf(settings(), "quick").enabled).toBe(false);
    expect(resolveBestOf({}, "full").enabled).toBe(false);
    expect(resolveBestOf(settings({ [BEST_OF_SETTING]: "off" }), "full").enabled).toBe(false);
  });

  it("runs three candidates under full when the switch is on, the slot cap permitting", () => {
    expect(resolveBestOf(settings(), "full")).toEqual({ enabled: true, count: 3, tokenBudget: 0, slotCap: 3 });
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
