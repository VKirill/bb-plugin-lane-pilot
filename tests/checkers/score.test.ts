import { describe, expect, it } from "vitest";
import { CRITIC_BAR, CRITIC_MIN_SAMPLE, buildScorecard, decideCodeCritic, renderScorecard, type ResultRow } from "../../src/rooms/checkers/score";
import type { CheckerId, DefectClass, Outcome } from "../../src/rooms/checkers/types";

let n = 0;
const row = (defectClass: DefectClass | "control", checker: CheckerId, outcome: Outcome, extra: Partial<ResultRow> = {}): ResultRow => {
  const task = `t${n++}`;
  return { defectId: `${task}:${defectClass}`, taskId: task, defectClass, checker, outcome, flagged: outcome === "hit" || outcome === "off_target", expected: false, detail: "", tokens: null, costUsd: null, ...extra };
};
/** A planted defect with the rows of every checker that looks at it. */
const defect = (defectClass: DefectClass, id: string, outcomes: Partial<Record<CheckerId, Outcome>>, tokens = 0): ResultRow[] =>
  Object.entries(outcomes).map(([checker, outcome]) => ({
    defectId: id, taskId: id, defectClass, checker: checker as CheckerId, outcome: outcome as Outcome, flagged: outcome === "hit" || outcome === "off_target", expected: false, detail: "",
    tokens: checker === "code_critic" ? tokens : null, costUsd: null,
  }));

describe("scorecard", () => {
  it("counts hit and miss per class and checker, leaving not-applicable and unrun cells out of the rate", () => {
    const card = buildScorecard([
      ...defect("off_by_one", "a", { verification: "hit", plan_fact: "miss", ownership: "miss" }),
      ...defect("off_by_one", "b", { verification: "miss", plan_fact: "miss", ownership: "n/a" }),
    ]);
    expect(card.classes.off_by_one?.verification).toMatchObject({ n: 2, hit: 1, miss: 1 });
    expect(card.classes.off_by_one?.ownership).toMatchObject({ n: 1, miss: 1 });
    expect(card.checkers.verification.hitRate).toBe(0.5);
    expect(card.planted.off_by_one).toBe(2);
  });

  it("is red when the designed code catcher misses, and not when a checker that is not the designed one does", () => {
    const card = buildScorecard([
      ...defect("outside_owns", "a", { ownership: "miss", plan_fact: "miss" }),
      ...defect("off_by_one", "b", { verification: "hit", ownership: "miss" }),
    ]);
    expect(card.regressions).toEqual([{ defectId: "a", defectClass: "outside_owns", checker: "ownership" }]);
    expect(renderScorecard(card)).toContain("RED: ownership missed a");
  });

  it("does not call a verification miss a regression on real candidates (the tests may not cover the line), but does on the drill's covered fixture", () => {
    const rows = defect("off_by_one", "a", { verification: "miss", ownership: "miss" });
    expect(buildScorecard(rows).regressions).toEqual([]);
    expect(buildScorecard(rows, { guaranteed: ["verification"] }).regressions).toEqual([{ defectId: "a", defectClass: "off_by_one", checker: "verification" }]);
  });

  it("reports the escapes: defects no code checker caught", () => {
    const card = buildScorecard([
      ...defect("test_assertion_deleted", "a", { verification: "miss", ownership: "miss", plan_fact: "miss", code_critic: "hit" }),
      ...defect("broken_import", "b", { verification: "hit", ownership: "miss", plan_fact: "miss" }),
    ]);
    expect(card.escapes).toEqual({ total: 1, byClass: { test_assertion_deleted: 1 } });
    expect(card.gaps).toEqual(["test_assertion_deleted", "swallowed_error", "hardcoded_value"]);
  });

  it("measures false alarms on the clean candidates", () => {
    const card = buildScorecard([
      row("control", "code_critic", "hit", { flagged: true }), row("control", "code_critic", "miss"), row("control", "code_critic", "miss"), row("control", "code_critic", "miss"),
      row("control", "ownership", "miss"),
    ]);
    expect(card.checkers.code_critic).toMatchObject({ controls: 4, falseAlarms: 1, falseAlarmRate: 0.25 });
    expect(card.checkers.ownership.falseAlarmRate).toBe(0);
  });

  it("builds the same card from the same rows", () => {
    const rows = defect("off_by_one", "a", { verification: "hit" });
    expect(JSON.stringify(buildScorecard(rows))).toBe(JSON.stringify(buildScorecard([...rows])));
  });
});

describe("the code critic decision", () => {
  const critic = (escapes: number, caught: number, controls: number, falseAlarms: number) => decideCodeCritic({ escapesJudged: escapes, escapesCaught: caught, controls, falseAlarms, tokens: caught * 1000 });

  it("is not decided on a small sample", () => {
    expect(critic(CRITIC_MIN_SAMPLE - 1, CRITIC_MIN_SAMPLE - 1, 6, 0).recommendation).toBe("inconclusive");
  });

  it("recommends medium at or above the bar with few false alarms, and prices a catch", () => {
    const decision = critic(10, Math.ceil(10 * CRITIC_BAR), 6, 1);
    expect(decision.recommendation).toBe("medium");
    expect(decision.tokensPerCatch).toBe(1000);
  });

  it("stays off below the bar", () => {
    expect(critic(10, 5, 6, 0)).toMatchObject({ recommendation: "off", escapeCatchRate: 0.5 });
  });

  it("stays off when it catches enough but raises findings on too many clean candidates", () => {
    const decision = critic(10, 9, 6, 3);
    expect(decision.recommendation).toBe("off");
    expect(decision.reasons.join(" ")).toContain("clean candidates");
  });
});
