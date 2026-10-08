import { describe, expect, it } from "vitest";
import { draftView } from "../src/rooms/workflow/draft-view";
import { branchEdges, CARD, isBranching, layoutGraph, PORT_STEP } from "../src/rooms/workflow/ui/workflow-layout";

const draft = (extra: Record<string, unknown> = {}) => ({
  nodes: [
    { id: "a", type: "agent", role: "analyst" },
    { id: "b", type: "agent", role: "builder" },
    { id: "c", type: "action", action: "ship" },
    { id: "d", type: "decision" },
  ],
  edges: [
    { from: "start", to: "a" },
    { from: "a", to: "b", when: "a.status == 'ok'" },
    { from: "a", to: "c" },
    { from: "b", to: "d" },
    { from: "d", to: "c", when: "b.done" },
    { from: "d", to: "end" },
    { from: "c", to: "end" },
  ],
  ...extra,
});

describe("the canvas layout", () => {
  it("names the outputs of a step with a condition on one of several ways out, and of every decision; a fan-out has none", () => {
    const view = draftView(draft());
    const by = (id: string) => view.nodes.find((node) => node.id === id)!;
    expect(branchEdges(view, by("a")).map((edge) => edge.to)).toEqual(["b", "c"]);
    expect(branchEdges(view, by("d")).map((edge) => edge.to)).toEqual(["c", "$end"]);
    expect(branchEdges(view, by("b"))).toEqual([]);
    expect(isBranching("parallel", [{ when: "x" }, { when: null }] as never)).toBe(false);
    expect(isBranching("agent", [{ when: null }, { when: null }] as never)).toBe(false);
  });

  it("makes a card as tall as its outputs need", async () => {
    const laid = await layoutGraph(draftView(draft()), undefined, "RIGHT");
    const height = (key: string) => laid.nodes.find((item) => item.key === key)!.height;
    expect(height("b")).toBe(CARD.height);
    expect(height("a")).toBeGreaterThanOrEqual(2 * PORT_STEP);
    expect(laid.arranged).toBe(false);
  });

  it("puts a step where the owner placed it, and a step added after that to the right of the one that leads to it", async () => {
    const view = draftView(draft({ ui: { positions: { start: { x: 0, y: 0 }, a: { x: 300, y: 100 }, b: { x: 700, y: -40 }, c: { x: 700, y: 200 }, end: { x: 1500, y: 100 } } } }));
    const laid = await layoutGraph(view, undefined, "RIGHT");
    const at = (key: string) => { const item = laid.nodes.find((candidate) => candidate.key === key)!; return { x: item.x, y: item.y }; };
    expect(laid.arranged).toBe(true);
    expect(at("a")).toEqual({ x: 300, y: 100 });
    expect(at("b")).toEqual({ x: 700, y: -40 });
    expect(at("$end")).toEqual({ x: 1500, y: 100 });
    // `d` has no place of its own: it goes right of `b`, which leads to it.
    expect(at("d").x).toBeGreaterThan(700 + CARD.width);
    expect(at("d").y).toBe(-40);
    // The drawn box starts at the leftmost and topmost step, even when that is below zero.
    expect(laid.x).toBe(0);
    expect(laid.y).toBe(-40);
  });

  it("lays a narrow (top to bottom) graph out by itself: places belong to the wide layout", async () => {
    const view = draftView(draft({ ui: { positions: { a: { x: 300, y: 100 } } } }));
    const laid = await layoutGraph(view, undefined, "DOWN");
    expect(laid.arranged).toBe(false);
  });
});
