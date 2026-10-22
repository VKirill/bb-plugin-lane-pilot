import { describe, expect, it } from "vitest";
import { afterFailedMove, ladderStep, type LadderState } from "../../src/rooms/wall/ladder";
import { selectClasses, type SelectInput } from "../../src/rooms/wall/select";
import type { WallClass } from "../../src/rooms/wall/types";

const cls = (key: string, patch: Partial<WallClass> = {}): WallClass => ({
  classKey: key, failureClass: "harness", reasonNorm: `reason ${key}`, origin: "harness", firstSeen: 0, lastSeen: 0, total: 5, counts: [5, 5, 5], windows: [10, 50, 50], rung: 0, state: "open",
  recur7: 5, recur1: 3, failedMoves: 0, hunt: "none", afterHuntFailed: 0, stage: "moves", ...patch,
});
const input = (classes: WallClass[], patch: Partial<SelectInput> = {}): SelectInput => ({
  classes, max: 3, walks: 2, recurrenceFloor: 3, openRepair: new Set(), roundsTonight: new Map(), roundsPerNight: 2, tokensLeft: 20_000_000, roundCost: 4_000_000, ...patch,
});

describe("the wall ladder: two moves, the hunt instead of the third, one informed move, then the backlog", () => {
  it("walks the whole ladder and never repeats forever", () => {
    let state: LadderState = { failedMoves: 0, hunt: "none", afterHuntFailed: 0 };
    expect(ladderStep(state).step).toBe("move");
    state = afterFailedMove(state);
    expect(ladderStep(state).step).toBe("move");
    state = afterFailedMove(state);
    expect(ladderStep(state)).toMatchObject({ step: "hunt", stage: "hunt" });
    expect(ladderStep({ ...state, hunt: "running" }).step).toBe("wait_hunt");
    const usable = { ...state, hunt: "usable" as const };
    expect(ladderStep(usable)).toMatchObject({ step: "informed_move", stage: "informed" });
    const after = afterFailedMove(usable);
    expect(after).toMatchObject({ failedMoves: 2, afterHuntFailed: 1 });
    expect(ladderStep(after)).toMatchObject({ step: "backlog", stage: "backlog" });
    // The hunters found nothing usable: straight to the backlog.
    expect(ladderStep({ ...state, hunt: "unknown" }).step).toBe("backlog");
  });

  it("the number of normal moves is a setting (3 is Maslov's own count)", () => {
    expect(ladderStep({ failedMoves: 2, hunt: "none", afterHuntFailed: 0 }, 3).step).toBe("move");
    expect(ladderStep({ failedMoves: 3, hunt: "none", afterHuntFailed: 0 }, 3).step).toBe("hunt");
  });
});

describe("which classes the night works on", () => {
  it("at most three, Lane Pilot's side first, the rest with a reason for the morning list", () => {
    const classes = [cls("a"), cls("b"), cls("c"), cls("d"), cls("e", { origin: "writer", recur7: 1 }), cls("f", { origin: "infra", recur7: 9 })];
    const result = selectClasses(input(classes));
    expect(result.picked).toHaveLength(3);
    expect(result.picked[0]!.classKey).toBe("f");
    expect(result.picked.map((row) => row.classKey)).toEqual(["f", "a", "b"]);
    expect(result.morning.map((row) => row.classKey).sort()).toEqual(["c", "d", "e"]);
    expect(result.morning.find((row) => row.classKey === "e")!.why).toMatch(/origin writer and 1 in 7 days/);
    expect(result.morning.find((row) => row.classKey === "d")!.why).toMatch(/more than 3 classes/);
  });

  it("a writer-side class qualifies by recurrence: 3 in 7 days with no repair under way", () => {
    expect(selectClasses(input([cls("w", { origin: "writer", recur7: 3 })])).picked.map((row) => row.classKey)).toEqual(["w"]);
    expect(selectClasses(input([cls("w", { origin: "writer", recur7: 3 })], { openRepair: new Set(["w"]) })).picked).toEqual([]);
  });

  it("a class within the bar is watched, not repaired; one in the backlog waits for a person", () => {
    const closed = cls("c", { state: "closed", rung: 3, recur7: 2 });
    const r = selectClasses(input([closed, cls("b", { stage: "backlog" })]));
    expect(r.picked).toEqual([]);
    expect(r.morning.map((row) => row.why).join("|")).toMatch(/within the bar/);
    expect(r.morning.map((row) => row.why).join("|")).toMatch(/in the backlog/);
  });

  it("the ladder decides the role: a class whose moves are spent is not repaired, an informed move is", () => {
    const spent = selectClasses(input([cls("s", { failedMoves: 2 })]));
    expect(spent.picked).toEqual([]);
    expect(spent.morning[0]!.why).toMatch(/hunt is next/);
    const informed = selectClasses(input([cls("i", { failedMoves: 2, hunt: "usable" })]));
    expect(informed.picked).toEqual([expect.objectContaining({ classKey: "i", role: "informed" })]);
  });

  it("two rounds a night per class and the night's token cap", () => {
    expect(selectClasses(input([cls("r")], { roundsTonight: new Map([["r", 2]]) })).picked).toEqual([]);
    const capped = selectClasses(input([cls("a"), cls("b"), cls("c")], { tokensLeft: 9_000_000 }));
    expect(capped.picked).toHaveLength(2);
    expect(capped.morning.find((row) => row.classKey === "c")!.why).toMatch(/token cap/);
  });

  it("two cycles in a row without a bench improvement end the series (shouldStopCycle)", () => {
    const result = selectClasses(input([cls("a")], { cycleScores: [0.5, 0.5, 0.5] }));
    expect(result.picked).toEqual([]);
    expect(result.stoppedBy).toMatch(/shouldStopCycle/);
    expect(selectClasses(input([cls("a")], { cycleScores: [0.5, 0.6, 0.7] })).picked).toHaveLength(1);
  });
});
