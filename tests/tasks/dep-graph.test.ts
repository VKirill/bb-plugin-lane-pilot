import { describe, expect, it } from "vitest";
import { cycleText, dependsOnTask, findCycle, planGraph, type DepNode } from "../../src/rooms/tasks";

const t = (id: string, depends_on: string[] = [], owns_paths: string[] = [`notes/${id}.md`]): DepNode => ({ id, depends_on, owns_paths });

describe("[sma:bf_waves] waves are laid out from the plan's links by code", () => {
  it("parallel: two tasks without a link and without shared files are one wave", () => {
    const graph = planGraph([t("a"), t("b")]);
    expect(graph.waves).toEqual([["a", "b"]]);
    expect(graph.cycle).toBeNull();
    expect(graph.sameWaveOverlap).toEqual([]);
  });

  it("sequence: a task that depends on another is in the next wave", () => {
    const plan = [t("b", ["a"]), t("a")];
    expect(planGraph(plan).waves).toEqual([["a"], ["b"]]);
    expect(planGraph(plan).waveOf).toEqual({ a: 1, b: 2 });
  });

  it("diamond: B and C after A together, D only after both", () => {
    const plan = [t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])];
    expect(planGraph(plan).waves).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("a wave the planner would put later is computed from the links: an independent task is wave 1", () => {
    // wfrun_edafda61 (2026-10-30): W-landing had no link and no shared file, the planner put it in wave 2.
    const plan = [t("W-jobs"), t("W-pay-plan"), t("W-landing")];
    expect(planGraph(plan).waveOf["W-landing"]).toBe(1);
  });

  it("two tasks of one computed wave that own the same files are named", () => {
    const graph = planGraph([t("a", [], ["src/x/"]), t("b", [], ["src/x/y.ts"]), t("c", ["a"], ["src/x/z.ts"])]);
    expect(graph.sameWaveOverlap).toEqual([["a", "b"]]);
  });

  it("a dependency outside the plan is reported and does not hold the layering", () => {
    const graph = planGraph([t("a", ["gone"]), t("b", ["a"])]);
    expect(graph.unknown).toEqual([["a", "gone"]]);
    expect(graph.waves).toEqual([["a"], ["b"]]);
  });
});

describe("[sma:p2_waves] a plan whose waves cannot be computed is a plan error", () => {
  it("cycle: A→B→C→A is found and its tasks get no wave", () => {
    const plan = [t("a", ["b"]), t("b", ["c"]), t("c", ["a"]), t("free")];
    const graph = planGraph(plan);
    expect(graph.cycle).toEqual(["a", "b", "c", "a"]);
    expect(cycleText(graph.cycle!)).toBe("a → b → c → a");
    expect(graph.waveOf).toEqual({ free: 1 });
    expect(graph.waves).toEqual([["free"]]);
  });

  it("a task that depends on a cycle has no wave either; a self link is a cycle", () => {
    expect(planGraph([t("a", ["b"]), t("b", ["a"]), t("c", ["a"])]).waveOf).toEqual({});
    expect(findCycle([t("a", ["a"])])).toEqual(["a", "a"]);
  });

  it("the run's redispatch names close a cycle too: P1 names P1.2", () => {
    const open = [{ id: "P1.2", depends_on: ["P2"] }, { id: "P2", depends_on: ["P1"] }];
    expect(findCycle(open, (dep, id) => dependsOnTask([dep], id))).toEqual(["P1.2", "P2", "P1.2"]);
    expect(findCycle(open)).toBeNull();
  });
});
