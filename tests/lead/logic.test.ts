import { describe, it, expect } from "vitest";
import { wilsonLower, cohenKappa, examEligible, examClass, examAll, type ExamRow, type Verdict } from "../../src/rooms/lead/logic";

const row = (over: Partial<ExamRow> = {}): ExamRow => ({
  class: "routing",
  risk: "low",
  judge_verdict: "exact",
  owner_label: null,
  predicted_at: 10,
  answered_at: 20,
  split: "exam",
  ...over,
});

/** `count` eligible rows of one class, answers at 100+i, each with the given verdict (or a picker). */
const rows = (count: number, verdict: (i: number) => Verdict = () => "exact", over: Partial<ExamRow> = {}): ExamRow[] =>
  Array.from({ length: count }, (_, i) => row({ judge_verdict: verdict(i), answered_at: 100 + i, ...over }));

describe("wilsonLower", () => {
  it("handles edges and fractional successes", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(10, 10)).toBeCloseTo(0.722, 3);
    expect(wilsonLower(50, 100)).toBeCloseTo(0.404, 3);
    expect(wilsonLower(9.5, 10)).toBeGreaterThan(wilsonLower(9, 10));
    expect(wilsonLower(9.5, 10)).toBeLessThan(wilsonLower(10, 10));
  });
});

describe("cohenKappa", () => {
  it("is null under 2 pairs, 1 on agreement, 0 at chance", () => {
    expect(cohenKappa([["exact", "exact"]])).toBeNull();
    expect(cohenKappa([["exact", "exact"], ["miss", "miss"]])).toBe(1);
    const mix: Array<readonly [string, string]> = [
      ...Array.from({ length: 20 }, () => ["exact", "exact"] as const),
      ...Array.from({ length: 5 }, () => ["exact", "miss"] as const),
      ...Array.from({ length: 10 }, () => ["miss", "exact"] as const),
      ...Array.from({ length: 15 }, () => ["miss", "miss"] as const),
    ];
    expect(cohenKappa(mix)).toBeCloseTo(0.4, 2);
    const random: Array<readonly [string, string]> = [];
    for (const a of ["exact", "miss"]) for (const b of ["exact", "miss"]) for (let i = 0; i < 10; i++) random.push([a, b]);
    expect(Math.abs(cohenKappa(random) as number)).toBeLessThan(0.01);
  });
});

describe("examEligible", () => {
  it("accepts only exam-split verdicts predicted before the answer", () => {
    expect(examEligible(row())).toBe(true);
    expect(examEligible(row({ predicted_at: 20, answered_at: 20 }))).toBe(false);
    expect(examEligible(row({ predicted_at: 30, answered_at: 20 }))).toBe(false);
    expect(examEligible(row({ split: "backtest" }))).toBe(false);
    expect(examEligible(row({ split: "design" }))).toBe(false);
    expect(examEligible(row({ judge_verdict: null }))).toBe(false);
    expect(examEligible(row({ answered_at: null }))).toBe(false);
    expect(examEligible(row({ predicted_at: null }))).toBe(false);
  });
});

describe("examClass", () => {
  it("decides when every gate passes", () => {
    const decided = rows(22, () => "exact", { owner_label: "exact" });
    const deferred = rows(3, () => "deferred");
    const exam = examClass("routing", [...decided, ...deferred]);
    expect(exam).toMatchObject({ n: 25, k: 22, m: 22, tier: "decides", reasons: [], revert: false });
    expect(exam.wilsonLb).toBeGreaterThanOrEqual(0.8);
    expect(exam.kappa).toBe(1);
  });

  it("proposes below min N", () => {
    const exam = examClass("routing", rows(19, () => "exact", { owner_label: "exact" }));
    expect(exam.tier).toBe("proposes");
    expect(exam.reasons).toContain("n 19 < 20");
  });

  it("proposes on a low Wilson bound", () => {
    const exam = examClass("routing", rows(20, (i) => (i < 14 ? "exact" : "miss"), { owner_label: null }));
    expect(exam.tier).toBe("proposes");
    expect(exam.reasons.some((r) => /^wilson \d\.\d\d < 0\.8$/.test(r))).toBe(true);
  });

  it("proposes on low coverage", () => {
    const decided = rows(20, () => "exact", { owner_label: "exact" });
    const deferred = rows(21, () => "deferred");
    const exam = examClass("routing", [...decided, ...deferred]);
    expect(exam.tier).toBe("proposes");
    expect(exam.reasons).toContain("coverage 0.49 < 0.5");
  });

  it("proposes when kappa is unknown", () => {
    const exam = examClass("routing", rows(25, () => "exact"));
    expect(exam.tier).toBe("proposes");
    expect(exam.reasons).toContain("kappa unknown");
  });

  it("proposes on low kappa", () => {
    const exam = examClass("routing", rows(25, () => "exact"), undefined);
    const labeled = rows(25, () => "exact").map((r, i) => ({ ...r, owner_label: (i < 12 ? "exact" : "miss") as Verdict }));
    const exam2 = examClass("routing", labeled);
    expect(exam.reasons).toContain("kappa unknown");
    expect(exam2.tier).toBe("proposes");
    expect(exam2.reasons).toContain("kappa 0.00 < 0.6");
  });

  it("proposes on a single high-risk miss", () => {
    const all = rows(25, () => "exact", { owner_label: "exact" });
    all[24] = row({ judge_verdict: "miss", owner_label: "miss", risk: "high", answered_at: 124 });
    const exam = examClass("routing", all);
    expect(exam.tier).toBe("proposes");
    expect(exam.reasons).toContain("1 high-risk miss");
    expect(exam.highRiskMiss).toBe(1);
  });
});

describe("revert window", () => {
  it("reverts when the last 20 decided rows degrade", () => {
    const all = rows(50, (i) => (i < 30 || i >= 42 ? "exact" : "miss"), { risk: "low" });
    const exam = examClass("routing", all);
    expect(exam.revert).toBe(true);
    expect(exam.windowLb).not.toBeNull();
    expect(exam.windowLb as number).toBeLessThan(0.7);
  });

  it("does not revert on a clean window", () => {
    const exam = examClass("routing", rows(50, () => "exact"));
    expect(exam.revert).toBe(false);
    expect(exam.windowLb).toBeGreaterThanOrEqual(0.7);
  });
});

describe("examAll", () => {
  it("returns one entry per eligible class, sorted, ignoring ineligible rows", () => {
    const list = [
      ...rows(20, () => "exact", { class: "zeta" }),
      ...rows(20, () => "exact", { class: "alpha" }),
      row({ class: "ghost", split: "backtest" }),
      row({ class: "ghost", judge_verdict: null }),
    ];
    const exams = examAll(list);
    expect(exams.map((e) => e.class)).toEqual(["alpha", "zeta"]);
    expect(exams.every((e) => e.n === 20)).toBe(true);
  });
});
